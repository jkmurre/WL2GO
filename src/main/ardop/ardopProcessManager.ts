import { spawn, type ChildProcess } from "node:child_process";
import { LOOPBACK_HOST } from "../util/loopback.ts";
import type { Writable } from "node:stream";
import type { ArdopProcessState, BinaryInfo, SubprocessState } from "../../shared/ipcContract.ts";
import { inspectBinary } from "../util/binaryInfo.ts";
import { resolveBinaryPath } from "../pat/patProcessManager.ts";
import { isPortFree, waitForTcpPort } from "../util/tcpProbe.ts";
import type { PttConfig } from "../../shared/configSchema.ts";

export { waitForTcpPort };

/**
 * The soft-modem. Unlike Pat, ardopcf is NOT started at launch: it takes
 * exclusive control of an audio device (and on macOS would trigger a microphone
 * permission prompt), so it only runs while a connection is actually wanted.
 * Module 9 drives that; this manager provides the spawn/stop mechanics and a
 * self-test that proves the binary works without touching audio hardware.
 */

/** Device name that makes ardopcf skip audio initialisation entirely. */
export const NO_AUDIO_DEVICE = "NOSOUND";

/**
 * Puts the modem's console output at DEBUG. Sent with every modem WL2GO starts.
 *
 * This is not developer noise, it is the ONLY way to find out whether the modem
 * is hearing the radio. ardopcf measures the receive peak on every capture
 * buffer (PaSound.c:1401) but at the default INFO level it reports that peak
 * NOWHERE: it goes to the WebGui socket, and to the log only when
 * `ardop_log_get_level_console() <= ZF_LOG_DEBUG` (PaSound.c:1416-1421). At
 * INFO the sole message is "your input signal is probably clipping" -- so a
 * radio delivering pure silence and a radio delivering a perfect signal produce
 * byte-identical logs.
 *
 * That is exactly the question a failed session leaves behind. "The station did
 * not answer" has two completely different causes -- the modem never heard the
 * reply, or it heard it and could not decode it -- and without `Input peaks`
 * every ten seconds there is nothing in the record that separates them.
 *
 * 2 is DEBUG. ardopcf's levels run the OTHER way from most: VERBOSE is 1 and
 * FATAL is 6 (log.h:190-191), so a larger number means less. Both DEBUG and
 * VERBOSE satisfy the peak-reporting test; VERBOSE also logs per-symbol decoder
 * detail, which would bury it.
 *
 * The status bar's TX/RX activity lights also hang off this: KeyPTT and the
 * leader correlator log at DEBUG (see modemActivity.ts), so raising this level
 * silently turns those lights off.
 */
export const MODEM_CONSOLE_LOG_COMMAND = "CONSOLELOG 2";

/**
 * Opens the leader-detect gate wider than ardopcf's default of 5.
 *
 * SoundInput.c:1796 will not attempt acquisition below the squelch, so the
 * default demands ~9 dB before the decoder looks at all. Upstream vouches for 3
 * specifically (SoundInput.c:1818).
 */
export const MODEM_SQUELCH_COMMAND = "SQUELCH 3";

/*
 * EXTRADELAY is deliberately left at ardopcf's default of 0 ("used for long
 * delay paths eg Satellite" -- ARDOPC.c:100). WL2GO once set it to 1000 to
 * widen the listening window, compensating for a capture path that was
 * discarding one received sample in five. That loss is fixed, and the delay
 * is not free: ARQ.c:1183 holds EVERY reply frame for 250 + EXTRADELAY ms
 * after decode, so at 1000 our DataACKs started ~1.6 s after the far
 * station's frame ended -- inside its ~2 s repeat window. It re-keyed
 * mid-ACK, never heard us, and a connected session deadlocked into repeats
 * until the 90 s IRS timeout. Do not reintroduce it to paper over receive
 * problems; fix the receive problem.
 */

/**
 * The parts of a spawn that change from one session to the next.
 *
 * Separated from the construction-time options because the session modem is a
 * long-lived singleton: it is built once at launch, when the active profile's
 * devices and keying are not known yet, and started many times afterwards. It
 * used to take these at construction only, which meant every on-air session ran
 * with NOSOUND and no PTT -- a modem that could neither hear nor transmit.
 */
export interface ArdopRuntimeConfig {
  captureDevice?: string;
  playbackDevice?: string;
  /** How the modem keys the radio. Absent means no keying: VOX, or a self-test. */
  ptt?: PttConfig;
  /**
   * Host commands applied at startup, as if the host had sent them (-H).
   *
   * This is the ONLY way to set things like DRIVELEVEL on a modem Pat will
   * attach to: ardopcf keeps a single host control socket (TCPHostInterface.c:670
   * assigns to a scalar, not an array), so a second connection while Pat is
   * attached would displace Pat's.
   */
  hostCommands?: string[];
  /** Enables the WebGui on this port. Unset means no -G at all. */
  webguiPort?: number;
  /**
   * Records what the modem hears to a WAV in this directory (-w).
   *
   * The directory is required: StartRxWav falls back to the process CWD when
   * the log directory is empty (PaSound.c:189-198), and we pass -m.
   */
  recordRxAudioDir?: string;
}

export interface ArdopProcessOptions extends ArdopRuntimeConfig {
  resourcesBinDir: string;
  /** TCP command port. The data port is always this plus one. */
  hostPort: number;
  createLogStream?: () => Writable;
  onStateChange?: (state: ArdopProcessState) => void;
  /**
   * Raw console output, alongside (not instead of) the log stream. Chunks are
   * delivered as they arrive and are NOT aligned to line breaks; the consumer
   * buffers. This is what feeds the status-bar TX/RX activity lights.
   */
  onOutput?: (chunk: string) => void;
}

export class ArdopProcessManager {
  private readonly opts: ArdopProcessOptions;
  private proc: ChildProcess | null = null;
  private logStream: Writable | null = null;
  private state: SubprocessState = "idle";
  private lastError: string | null = null;
  private binary: BinaryInfo | null = null;
  private exitInfo: string | null = null;

  /** What the NEXT spawn will use. Seeded from the constructor, then replaced. */
  private runtime: ArdopRuntimeConfig;

  constructor(opts: ArdopProcessOptions) {
    this.opts = opts;
    this.runtime = {
      captureDevice: opts.captureDevice,
      playbackDevice: opts.playbackDevice,
      ptt: opts.ptt,
      hostCommands: opts.hostCommands,
      webguiPort: opts.webguiPort,
      recordRxAudioDir: opts.recordRxAudioDir,
    };
  }

  /**
   * Sets what the next spawn will use. Call immediately before start().
   *
   * REPLACES rather than merges, deliberately. Merging would let one profile's
   * keying survive into a session with another profile that has none, and
   * "the radio keyed when nothing asked it to" is the worst bug this app can
   * have. Passing {} is how a caller says "no devices, no keying".
   *
   * Refused while running, because the arguments are read at spawn: accepting
   * it would report a change that the live process is not honouring.
   */
  configure(config: ArdopRuntimeConfig): void {
    if (this.proc) {
      throw new Error("The modem is already running; stop it before changing its configuration.");
    }
    this.runtime = { ...config };
  }

  get binaryPath(): string {
    return resolveBinaryPath(this.opts.resourcesBinDir, "ardopcf");
  }

  getState(): ArdopProcessState {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      binaryPath: this.binaryPath,
      binary: this.binary,
      hostPort: this.opts.hostPort,
      lastError: this.lastError,
    };
  }

  private setState(state: SubprocessState, error: string | null = null): void {
    this.state = state;
    this.lastError = error;
    this.opts.onStateChange?.(this.getState());
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  /** Checks the vendored binary without running it. */
  async inspect(): Promise<BinaryInfo> {
    this.binary = await inspectBinary(this.binaryPath);
    return this.binary;
  }

  /** The command line ardopcf is spawned with. Exposed so the tests can assert it. */
  /**
   * The PTT options, in front of the positionals like everything else.
   *
   * Three shapes, all read out of ardopcf's own argument handling:
   *
   *   rts      -p <port>[:<baud>]     asserts RTS to transmit
   *   cat      -c <port>:<baud> -k <hex> -u <hex>
   *   rigctld  nothing at all          -- see below
   *
   * "rigctld" deliberately passes NO arguments. It used to pass -p host:port,
   * which PaSound.c:517-537 turns into PTTMode = PTTHAMLIB -- and RadioPTT()
   * has no PTTHAMLIB branch, in our vendored PaSound.c:1621-1649 OR upstream's
   * ALSASound.c:1892-1900, so it keyed nothing whatsoever. With no PTT
   * arguments ardopcf leaves RadioControl false and reports "PTT TRUE" /
   * "PTT FALSE" to whoever holds its host socket (PaSound.c:1655-1670), which
   * during a session is Pat -- and Pat keys the radio through Hamlib when
   * ardop.ptt_ctrl is set (app/connect.go:310-320). That is the same
   * arrangement WSJT-X and Winlink Express use.
   *
   * The `:baud` suffix is the only way to set the speed -- there is no flag for
   * it and the built-in default is 19200 (ARDOPC.c:133,138). It is parsed by
   * strlop(port, ':') at PaSound.c:445-448.
   *
   * CM108 is absent on purpose: the PortAudio backend only recognises a Linux
   * hidraw path (PaSound.c:459-476), and a VID:PID on macOS falls through to
   * the IP branch and then to a serial open that cannot succeed.
   */
  private pttArgs(): string[] {
    const ptt = this.runtime.ptt;
    if (!ptt || ptt.method === "none") return [];
    // "rigctld" carries no port of its own; every other method needs one.
    if (ptt.method !== "rigctld" && !ptt.port) return [];

    switch (ptt.method) {
      case "rts":
        return ["-p", `${ptt.port}:${ptt.baud}`];
      case "rigctld":
        // Nothing. The host keys the radio; see the note above.
        return [];
      case "cat":
        // Hex is stored normalised (uppercase, no separators) because
        // ardopcf's parser understands nothing else -- see normaliseHexCommand.
        return ["-c", `${ptt.port}:${ptt.baud}`, "-k", ptt.keyHex, "-u", ptt.unkeyHex];
    }
  }

  /**
   * -H takes ONE semicolon-separated string, not repeated flags.
   *
   * Commands containing a semicolon would silently split into two, so they are
   * refused here rather than reaching ardopcf as something else. Nothing WL2GO
   * sends contains one; a caller that manages to construct one has a bug.
   */
  private hostCommandArgs(): string[] {
    // Prepended, not left to the callers: a modem started without it is one
    // whose log cannot answer "did it hear anything", and that is every modem
    // WL2GO runs, including the audio device self-test.
    const commands = [
      MODEM_CONSOLE_LOG_COMMAND,
      MODEM_SQUELCH_COMMAND,
      ...(this.runtime.hostCommands?.filter((c) => c.trim().length > 0) ?? []),
    ];

    const offender = commands.find((c) => c.includes(";"));
    if (offender) {
      throw new Error(`Host command "${offender}" contains a semicolon, which ardopcf reads as a separator.`);
    }
    return ["-H", commands.join(";")];
  }

  buildArgs(): string[] {
    // Options MUST come before the positionals.
    //
    // ardopcf reads its positional arguments as argv[optind], [optind+1] and
    // [optind+2] (ARDOPCommon.c:375-383), so options-first parses correctly
    // whether or not this platform's getopt permutes. Options-last relies on
    // permutation: glibc does it, but BSD-derived getopt -- which is what macOS
    // ships -- may stop at the first non-option and silently ignore everything
    // after it. Upstream targets Linux and never had to care; we do.
    return [
      // Upstream binds INADDR_ANY with no way to change it, which would expose
      // TNC control -- including transmit -- to the whole network. Our vendor
      // patch 0005 adds this option. See util/loopback.ts.
      "--hostbind",
      LOOPBACK_HOST,
      "-m", // console output only; WL2GO captures it into its own logs
      ...this.pttArgs(),
      ...this.hostCommandArgs(),
      // -G ONLY when a caller deliberately asked for it. The WebGui is not
      // merely a display: its '2' message fires TWOTONETEST, a real five-second
      // transmission, and that is not gated by developer mode (Webgui.c:784-790).
      // Vendor patch 0006 puts the listener on --hostbind and removes its
      // developer mode, but the session modem still never sets this -- only the
      // tuning session does, on a scratch port. Tests assert both halves.
      ...(this.runtime.webguiPort ? ["-G", String(this.runtime.webguiPort)] : []),
      // -w needs -l to be useful; see recordRxAudioDir. Both or neither.
      // -T as well as -w: a recording of what we HEAR cannot show whether what
      // we SEND is a valid frame, and "the station never really replied" and
      // "our connect request was malformed" look identical from the receive
      // side. Both replay through `npm run decode-rx-wav`.
      ...(this.runtime.recordRxAudioDir ? ["-w", "-T", "-l", this.runtime.recordRxAudioDir] : []),
      // Positionals: port, capture device, playback device.
      String(this.opts.hostPort),
      this.runtime.captureDevice ?? NO_AUDIO_DEVICE,
      this.runtime.playbackDevice ?? NO_AUDIO_DEVICE,
    ];
  }

  async start(readinessTimeoutMs = 10_000): Promise<void> {
    if (this.proc) throw new Error("ardopcf already started");

    this.setState("starting");
    const binPath = this.binaryPath;
    const binary = await this.inspect();

    if (!binary.exists) {
      const msg = `ardopcf binary not found at ${binPath}. Run: npm run build:ardopcf`;
      this.setState("failed", msg);
      throw new Error(msg);
    }
    if (!binary.matchesHost) {
      const msg =
        `ardopcf binary at ${binPath} is ${binary.format}/${binary.arch}, ` +
        `which cannot run on ${process.platform}/${process.arch}. Rebuild it: npm run build:ardopcf`;
      this.setState("failed", msg);
      throw new Error(msg);
    }

    // Asked BEFORE spawning, and this ordering is the whole point.
    //
    // waitForTcpPort below cannot tell a modem we started from one left behind
    // by a previous run: an orphan holding the port makes the readiness poll
    // succeed on its first attempt, so a new process that died on startup would
    // still be reported running -- and Pat would dial through the orphan, whose
    // audio devices belong to whatever profile was last used. That is a session
    // that transmits on the wrong sound card and reports success.
    if (!(await isPortFree(this.opts.hostPort))) {
      const msg =
        `Something is already listening on port ${this.opts.hostPort}, so the modem cannot start. ` +
        `This is usually a modem left running by a previous session — use "Reset modem" to clear it.`;
      this.setState("failed", msg);
      throw new Error(msg);
    }

    this.logStream = this.opts.createLogStream?.() ?? null;

    const proc = spawn(binPath, this.buildArgs(), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.exitInfo = null;

    if (this.logStream) {
      proc.stdout?.pipe(this.logStream, { end: false });
      proc.stderr?.pipe(this.logStream, { end: false });
    }

    if (this.opts.onOutput) {
      const forward = (data: Buffer) => this.opts.onOutput?.(data.toString("utf8"));
      proc.stdout?.on("data", forward);
      proc.stderr?.on("data", forward);
    }

    let spawnError: Error | null = null;
    proc.on("error", (err) => {
      spawnError = err;
    });
    proc.on("exit", (code, signal) => {
      this.exitInfo = `exited with code=${code} signal=${signal}`;
      this.logStream?.write(`\n[ardopProcessManager] ${this.exitInfo}\n`);
      this.proc = null;
    });

    try {
      await waitForTcpPort(this.opts.hostPort, readinessTimeoutMs, {
        label: "ardopcf",
        shouldAbort: () => {
          if (spawnError) return `Failed to spawn ardopcf at ${binPath}: ${spawnError.message}`;
          // ardopcf exits immediately when it cannot open the requested audio
          // device, which is the most common real-world failure.
          if (this.exitInfo) return `ardopcf ${this.exitInfo} before opening its host port`;
          return null;
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.setState("failed", reason);
      await this.stop();
      throw new Error(reason);
    }

    this.setState("running");
  }

  // INVARIANT: on a session's normal teardown this is only called after the
  // final station ID's PTT-FALSE (finalIdWatcher.ts) -- a SIGTERM mid-ID
  // truncates the tone on the air, because PaSound.c stops feeding the sound
  // card once blnClosing is set (vendor patch, commit c2cde84). The abort path
  // is the deliberate exception: Stop means the transmitter goes off now.
  async stop(timeoutMs = 4000): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      if (this.state !== "failed") this.setState("stopped");
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        if (this.proc) proc.kill("SIGKILL");
        setTimeout(finish, 1000);
      }, timeoutMs);

      proc.once("exit", finish);
      proc.kill("SIGTERM");
    });

    this.logStream?.end();
    this.logStream = null;
    this.proc = null;
    if (this.state !== "failed") this.setState("stopped");
  }

  /**
   * Force-kills the modem and reports whether the port actually came free.
   *
   * The recovery path for a wedged modem, and it deliberately does more than
   * stop(): a modem holding the sound card open can ignore SIGTERM, and one
   * left behind by a crashed run is not ours to signal at all. So this kills
   * what it owns, then checks the port -- and says plainly when something it
   * cannot reach is still there, rather than reporting success and letting the
   * next connect fail in a way that looks like broken hardware.
   */
  async resetModem(): Promise<{ ok: boolean; message: string }> {
    const wasRunning = this.proc !== null;
    if (this.proc) {
      this.proc.kill("SIGKILL");
      await this.stop(0);
    }

    // The port does not come free the instant the process dies; the kernel
    // needs a moment to release the listener.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await isPortFree(this.opts.hostPort)) {
        this.setState("idle");
        return {
          ok: true,
          message: wasRunning
            ? "The modem was stopped and its port is free."
            : "No modem was running, and the port is free.",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return {
      ok: false,
      message:
        `Port ${this.opts.hostPort} is still in use by a program WL2GO did not start. ` +
        `Quit any other ARDOP software, or restart the computer if you cannot find it.`,
    };
  }

  /**
   * Starts the modem with audio disabled, confirms it opens its host port, and
   * stops it again. Proves the binary is runnable end to end without claiming
   * the sound card or prompting for microphone access.
   */
  async selfTest(timeoutMs = 8000): Promise<void> {
    await this.start(timeoutMs);
    await this.stop();
    this.setState("idle");
  }
}
