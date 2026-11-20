// One ARDOP session, from cold modem to disconnected.
//
// The Telnet path is a single call to Pat and nothing else has to happen first.
// An RF session is four things in order -- resolve the devices, start the
// modem, dial, and always stop the modem again -- and each one fails in a way
// the operator has to be told apart from the others. "Session failure" covers
// all four in Pat's vocabulary, which is why this exists.
//
// It sits ON TOP of PatConnectionManager rather than replacing it: the stage
// model, the prompt handling and the /ws plumbing are the same for both
// transports, and forking them would be the two-vocabularies mistake the
// session stage enum exists to avoid.

import type {
  AudioDevice,
  ChannelCheckEvent,
  ChannelHoldDecision,
  ConnectionState,
} from "../../shared/ipcContract.ts";
import { lanReadinessIssues, type RadioProfile } from "../../shared/configSchema.ts";
import { buildArdopUrl, isArdopBandwidth } from "../../shared/ardopUrl.ts";
import { resolveAudioDevice, type ResolvedAudioDevice } from "../audio/deviceResolver.ts";
import type { ArdopProcessManager } from "./ardopProcessManager.ts";
import type { PatConnectionManager } from "../pat/patConnectionManager.ts";
import { releasePtt } from "../serial/pttTester.ts";
import { rxRecordingDir } from "../diagnostics/rxRecording.ts";
import { logDirectory } from "../logging/logger.ts";
import type { RigSession, RigSnapshot } from "../rigctl/rigSession.ts";
import { ArdopHostClient } from "./ardopHostClient.ts";
import { ClearChannelMonitor, type ChannelVerdict } from "./clearChannelMonitor.ts";
import type { FinalIdWatcher, SignOffOutcome } from "./finalIdWatcher.ts";

/** Why a radio session cannot be started right now, or null when it can. */
export interface RadioReadiness {
  ok: boolean;
  /** One sentence, fit to show as the reason a menu entry is greyed out. */
  reason: string | null;
  /** Non-fatal things worth saying anyway. Never a reason to refuse. */
  warnings: string[];
}

export interface ArdopSessionRequest {
  /** The RMS gateway callsign to call. */
  target: string;
  /** ARQ bandwidth, or null to leave the modem's configured default alone. */
  bandwidth?: string | null;
  /** The chosen row's dial frequency in kHz, or null to tune nothing. */
  dialKhz?: number | null;
  /** Winlink hybrid Radio-Only mode. See shared/ipcContract.ts. */
  radioOnly?: boolean;
}

export interface ArdopConnectionOptions {
  getProfile: () => RadioProfile | null;
  listAudioDevices: () => Promise<AudioDevice[]>;
  getModem: () => ArdopProcessManager | null;
  getSession: () => PatConnectionManager | null;
  /** Rig control, when the build has it. Null means "no radio control at all". */
  getRig?: () => RigSession | null;
  /** The operator's callsign, for the radio-only SSID check. Empty when unset. */
  getCallsign?: () => string;
  /**
   * Heals rig control before the session asks it for anything. This is what
   * lets a second connect attempt succeed after the first one died with the
   * rig client down -- without it, "rig control is not running ... try again"
   * was only curable by relaunching the app.
   */
  ensureRig?: () => Promise<void>;
  onLog?: (message: string) => void;
  /** Live clear-channel-check state, for the status bar and the hold dialog. */
  onChannelCheck?: (event: ChannelCheckEvent) => void;
  /** Test seam; defaults to a real ArdopHostClient on the modem's host port. */
  createHostClient?: (port: number) => ChannelCheckClient;
  /** Test seam; defaults to the monitor's 10-second operating requirement. */
  channelClearWindowMs?: number;
  /** Test seam; defaults to the 2-second settle after a pre-tune QSY. */
  qsySettleMs?: number;
  /** Whether Settings > Diagnostics has audio recording on. Default off. */
  isRxRecordingEnabled?: () => boolean;
  /**
   * The sign-off watcher fed from the modem's console (finalIdWatcher.ts).
   * When present, the teardown holds modem.stop() until the final station ID
   * has gone out -- the fix for the deferred-ID race that dropped the
   * mandatory CW ID whenever the far station closed the link first. Null (the
   * default, and the test seam) means stop immediately, as before.
   */
  getSignOffWaiter?: () => FinalIdWatcher | null;
}

/** What the clear-channel check needs from a host client. */
export interface ChannelCheckClient {
  connect(): Promise<void>;
  onLine(listener: (line: string) => void): () => void;
  onClose(listener: () => void): () => void;
  /** One host command; the check uses it to reset the busy detector. */
  send(command: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The gap between closing our listener and Pat dialling, so ardopcf's host
 * poll sees our FIN before Pat's connection arrives. Displacement semantics
 * make even a lost race harmless -- the newest connection wins -- but this
 * keeps our dead descriptor from lingering inside ardopcf for the session.
 */
const HOST_HANDOFF_SETTLE_MS = 200;

/** Receiver settle after the pre-tune QSY, before the busy listen starts. */
const QSY_SETTLE_MS = 2_000;

/**
 * Whether the profile's saved devices still point at hardware that is here.
 *
 * Answered WITHOUT spawning anything, because it drives a greyed-out menu entry
 * that has to render on every dropdown open. resolveAudioDevice is the same
 * function the spawn itself uses, so the menu and the modem cannot disagree
 * about whether a device is present -- which they did once before, when the
 * renderer had its own copy of the question.
 */
export function assessRadioReadiness(
  profile: RadioProfile | null,
  devices: AudioDevice[],
): RadioReadiness {
  if (!profile) {
    return { ok: false, reason: "No radio profile is set up yet.", warnings: [] };
  }

  if (profile.interface.type === "lan") {
    // Deliberately refused rather than attempted. A networked Icom speaks its
    // own framed protocol on three UDP ports; bundled Hamlib has no support for
    // it (its one Icom-UDP branch is #if 0, rig.c:1210-1222) and ardopcf can
    // only open PortAudio devices (PaSound.c:705). There is nothing to connect
    // with yet, and half-connecting -- or quietly falling back to the USB
    // codec -- would both be worse than saying so.
    //
    // An INCOMPLETE profile is reported separately even though neither can
    // connect, because the two need different things from the operator: one is
    // waiting on WL2GO, the other on a field they have not filled in.
    const missing = lanReadinessIssues(profile.interface.lan);
    return {
      ok: false,
      reason: missing.length
        ? `"${profile.name}" is missing ${joinList(missing)}.`
        : `"${profile.name}" is a network profile. Connecting over the radio's network port is not built yet.`,
      warnings: [],
    };
  }

  const usb = profile.interface.usb;
  const capture = resolveAudioDevice(usb.audioInput, devices, "capture");
  if (!capture.ok) return { ok: false, reason: capture.message, warnings: [] };

  const playback = resolveAudioDevice(usb.audioOutput, devices, "playback");
  if (!playback.ok) return { ok: false, reason: playback.message, warnings: [] };

  // Everything below is a warning on purpose. A missing PTT setting does not
  // stop a session -- plenty of interfaces key on audio -- and refusing here
  // would strand an operator whose radio is in VOX.
  const warnings = [...capture.warnings, ...playback.warnings];
  if (profile.ptt.method === "none") {
    warnings.push(
      "This profile has no keying configured, so the radio must be in VOX. " +
        "If it does not transmit, set how it keys in the profile.",
    );
  }
  if (profile.ptt.method === "rigctld" && !profile.hamlib) {
    // validateProfile refuses to SAVE this, but a hand-edited config can still
    // produce it, and it is the configuration in which nothing keys at all.
    warnings.push(
      "This profile keys through rig control but has no radio set up, so the radio will not transmit. " +
        "Pick a radio model in the profile.",
    );
  }
  if (!profile.hamlib) {
    // Not a refusal. Plenty of radios have no Hamlib backend, and tuning by
    // hand is a perfectly ordinary way to work -- it is simply not what an
    // operator assumes is happening unless they are told.
    warnings.push(
      "This profile has no rig control, so WL2GO will not tune the radio or set its mode. " +
        "Set the frequency and a DATA mode (USB-D) by hand before calling.",
    );
  }

  return { ok: true, reason: null, warnings };
}

export class ArdopConnectionManager {
  private readonly opts: ArdopConnectionOptions;
  /** Set for the duration of a session, so the modem is stopped exactly once. */
  private running = false;
  /** Set only while the clear-channel check runs; how decisions reach it. */
  private channelMonitor: ClearChannelMonitor | null = null;
  /**
   * One wait per session, shared by the success path (beforeFinish) and the
   * finally -- both must see the SAME answer, or the finally could start a
   * second wait after the first already let the sign-off through.
   */
  private signOffWait: Promise<SignOffOutcome> | null = null;

  constructor(options: ArdopConnectionOptions) {
    this.opts = options;
  }

  /** Starts (once) and returns the session's sign-off wait. Never rejects. */
  private awaitSignOff(): Promise<SignOffOutcome> {
    if (!this.signOffWait) {
      const watcher = this.opts.getSignOffWaiter?.() ?? null;
      this.signOffWait = watcher
        ? watcher.wait().catch((): SignOffOutcome => "quiet")
        : Promise.resolve("quiet" as const);
    }
    return this.signOffWait;
  }

  /** Routes the hold dialog's answer (or a Stop press) into the running check. */
  channelDecision(decision: ChannelHoldDecision): void {
    this.channelMonitor?.decide(decision);
  }

  async readiness(): Promise<RadioReadiness> {
    const profile = this.opts.getProfile();
    if (!profile) return assessRadioReadiness(null, []);
    // A LAN profile is refused before the device listing is even fetched:
    // running ardopcf --list-devices to answer a question whose answer is
    // already "no" costs a subprocess on every dropdown open.
    if (profile.interface.type === "lan") return assessRadioReadiness(profile, []);

    try {
      return assessRadioReadiness(profile, await this.opts.listAudioDevices());
    } catch (err: unknown) {
      return {
        ok: false,
        reason: `The audio devices could not be listed: ${message(err)}`,
        warnings: [],
      };
    }
  }

  /**
   * Runs one RF session and resolves when it is over.
   *
   * The modem is stopped in a finally, on every path including success. It
   * holds the sound card exclusively, so a modem left running blocks the next
   * session AND the device test, and the operator has no way to tell why.
   */
  async connect(request: ArdopSessionRequest): Promise<ConnectionState> {
    const session = this.opts.getSession();
    if (!session) throw new Error("The protocol engine is not running.");
    if (this.running) throw new Error("A radio session is already in progress.");

    const modem = this.opts.getModem();
    if (!modem) throw new Error("The modem is not available.");

    // Refused BEFORE anything slow or on the air. Pat implements Radio-Only by
    // appending "-T" to the callsign and cannot do that to one that already
    // carries an SSID -- but its refusal (connect.go:133-137) is a bare log
    // line and a generic "Session failure". Naming the fix here is the whole
    // point of checking first.
    if (request.radioOnly && /-\d{1,2}$/.test((this.opts.getCallsign?.() ?? "").trim())) {
      throw new Error(
        "Radio-only sessions need a callsign without an SSID (Winlink adds -T itself). " +
          "Use your base callsign in Settings, or turn radio-only off for this call.",
      );
    }

    const profile = this.opts.getProfile();
    if (!profile) throw new Error("No radio profile is set up yet.");
    if (profile.interface.type !== "usb") {
      throw new Error(assessRadioReadiness(profile, []).reason ?? "This profile cannot be used on the air yet.");
    }

    const devices = await this.opts.listAudioDevices();
    const capture = requireDevice(resolveAudioDevice(profile.interface.usb.audioInput, devices, "capture"));
    const playback = requireDevice(resolveAudioDevice(profile.interface.usb.audioOutput, devices, "playback"));

    this.running = true;
    // Set before anything slow happens: starting the modem is the first thing
    // an operator watches, and on a busy machine it is not instant.
    session.beginModemStart();

    // A blank sign-off slate for this session: the watcher's PTT history and
    // any previous session's settled wait must not leak into this one.
    this.signOffWait = null;
    this.opts.getSignOffWaiter?.()?.reset();

    // The RADIO before the modem, and the ordering is deliberate. Putting the
    // rig into a data mode has to succeed before anything can transmit, and a
    // failure here must not leave a modem running with the sound card claimed.
    //
    // A profile with no rig control resolves to a null snapshot and changes
    // nothing, which is exactly what every session did before rig control
    // existed.
    let rigSnapshot: RigSnapshot | null = null;
    const rig = this.opts.getRig?.() ?? null;
    if (rig) {
      // Before prepareForCall, so a rig client that died since the last
      // attempt is replaced rather than reported. Only when the profile
      // actually has a rig -- ensure() would no-op anyway, but a session with
      // no rig should not wait on rig control's queue either.
      if (profile.hamlib) await this.opts.ensureRig?.();
      const prepared = await rig.prepareForCall(profile);
      rigSnapshot = prepared.snapshot;
      if (!prepared.ok) {
        this.running = false;
        // Put back whatever was read before the failed change, so a half-applied
        // mode does not outlive the attempt.
        await rig.restore(rigSnapshot);
        session.failSession(prepared.error ?? "The radio could not be set up for this call.");
        this.opts.onLog?.(`The radio was not ready: ${prepared.error}`);
        return session.getState();
      }
    }

    try {
      this.opts.onLog?.(
        `Starting the modem for "${profile.name}" on port ${profile.ardop.hostPort} ` +
          `(capture ${capture}, playback ${playback})`,
      );
      // The resolved devices and the profile's keying have to be handed to the
      // modem, not merely logged. The session modem is a launch-time singleton
      // that knows nothing about the active profile until this call; without it
      // every on-air session spawned NOSOUND with no PTT, so the modem could
      // neither hear the radio nor key it.
      //
      // No webguiPort: only the tuning session gets one, on a scratch port.
      modem.configure({
        captureDevice: capture,
        playbackDevice: playback,
        ptt: profile.ptt,
        // The profile's transmit drive, applied the only way it can be on a
        // modem Pat will attach to: ardopcf keeps ONE host control socket, so
        // -H at spawn is the sole route in. Without this every on-air session
        // ran at ardopcf's built-in 100 (ARDOPC.c:105) no matter what the
        // operator had set, and the tuning window's whole purpose was defeated
        // the moment they closed it.
        hostCommands: [
          `DRIVELEVEL ${profile.driveLevel}`,
          // The busy detector's sensitivity, per profile: two radios can sit
          // on very different noise floors, and the operator's only lever
          // for a channel that reports busy with nothing on it.
          `BUSYDET ${profile.busyDetLevel}`,
          // The target's bandwidth too, when the row names a valid one: the
          // busy detector sizes its passband from ARQBandwidth (ARDOPC.c:2100),
          // and Pat only sets it at dial time -- AFTER the clear-channel
          // check, which otherwise listens across the default 2000MAX however
          // narrow the actual call will be. Pat re-sends the same value when
          // it dials, harmlessly.
          ...(request.bandwidth && isArdopBandwidth(request.bandwidth)
            ? [`ARQBW ${request.bandwidth}`]
            : []),
        ],
        // On only when Settings > Diagnostics enables it, under the developer
        // overrides in rxRecording.ts -- which also says why the log alone
        // cannot tell "heard nothing" from "heard it and discarded it".
        recordRxAudioDir: rxRecordingDir(logDirectory(), this.opts.isRxRecordingEnabled?.() ?? false),
      });
      await modem.start();
    } catch (err: unknown) {
      this.running = false;
      await rig?.restore(rigSnapshot);
      // Named as a modem failure HERE, where it is unambiguous. Deciding this
      // later, from the session's error, would mean guessing.
      const described = describeModemFailure(message(err));
      session.failSession(described);
      this.opts.onLog?.(`The modem did not start: ${described}`);
      return session.getState();
    }

    // Hz to put the dial back to when WE tuned it; null when Pat owns the VFO.
    let restoreFrequencyHz: number | null = null;

    try {
      // Pre-tune, so the clear-channel check listens on the TARGET frequency.
      // Pat's own qsy() runs inside session.connect -- after the check -- so
      // without this a rig-controlled session would monitor whatever the radio
      // was last left on. Tuning here makes WL2GO the session's one VFO writer:
      // freq= is dropped from Pat's URL below, and the finally puts the dial
      // back. On any failure this degrades to exactly the old behaviour, with
      // Pat tuning when it dials.
      let tunedByUs = false;
      const dialKhz = request.dialKhz ?? null;
      if (rig && profile.hamlib && typeof dialKhz === "number" && Number.isFinite(dialKhz) && dialKhz > 0) {
        // Heal AGAIN, right here, not only at the top of connect(). On radios
        // whose DATA MOD CI-V probe fails, prepareForCall's probe killed the
        // rigctld client socket -- rigctld drops the whole client connection
        // on a raw-command I/O error -- and this pre-tune then read null and
        // silently degraded on EVERY session: the clear-channel check
        // listened on whatever frequency the radio was last left on.
        await this.opts.ensureRig?.();
        const originalHz = await rig.readFrequencyHz();
        if (originalHz !== null && (await rig.setFrequencyHz(dialKhz * 1000))) {
          tunedByUs = true;
          restoreFrequencyHz = originalHz;
          this.opts.onLog?.(`Radio tuned to ${dialKhz} kHz for the channel check`);
          // Let the receiver settle on the new frequency before listening:
          // the QSY lands mid-AGC-recovery, and the busy detector's first
          // samples would otherwise measure the transient, not the channel.
          // (Pat's own qsy() waits 3 s before transmitting, same reasoning.)
          await new Promise((resolve) => setTimeout(resolve, this.opts.qsySettleMs ?? QSY_SETTLE_MS));
        } else {
          this.opts.onLog?.(
            "Could not pre-tune the radio; the channel check will listen on the current frequency " +
              "and the dial will be tuned when the call starts.",
          );
        }
      }

      // Listen before transmitting. Ten consecutive clear seconds are required
      // before the dial; a busy channel holds the call and asks the operator.
      session.beginChannelCheck();
      const verdict = await this.runChannelCheck(modem);
      if (verdict === "abort") {
        session.failSession("The call was cancelled while waiting for a clear channel.");
        this.opts.onLog?.(`The call to ${request.target} was cancelled during the channel check`);
        return session.getState();
      }
      if (verdict === "force") {
        this.opts.onLog?.("Transmitting on a busy channel at the operator's request");
      }

      const url = buildArdopUrl({
        target: request.target,
        bandwidth: request.bandwidth ?? null,
        // Dropped when we already tuned: one VFO writer per session, and for
        // this one it is WL2GO. See the pre-tune above and rigSession.ts.
        dialKhz: tunedByUs ? null : dialKhz,
        // Only with a rig behind it. A freq= on a URL Pat has no VFO for does
        // not fail to tune, it fails the session before dialling with an error
        // naming nothing -- see shared/ardopUrl.ts.
        rigConfigured: profile.hamlib !== null,
        radioOnly: request.radioOnly === true,
      });
      this.opts.onLog?.(`Calling ${request.target} over the air`);
      // beforeFinish: the session is not "finished" until the final station
      // ID is off the air -- Pat reports the mail exchange over up to three
      // seconds BEFORE ardopcf's deferred IDFrame + CW ID even starts.
      return await session.connect("ardop", url, {
        modemStarted: true,
        beforeFinish: () => this.awaitSignOff(),
      });
    } finally {
      this.running = false;
      // The mandatory station ID first: SIGTERMing the modem here used to
      // beat ardopcf's deferred final ID by ~300 ms whenever the far station
      // closed the link. The wait is instant for a session that never keyed
      // or was stopped by the operator, and the same shared promise the
      // success path already awaited.
      const signOff = await this.awaitSignOff();
      if (signOff === "id-complete") {
        this.opts.onLog?.("The station ID has been sent");
      } else if (signOff === "timeout") {
        this.opts.onLog?.(
          "Gave up waiting for the station ID; the channel may have stayed busy. Stopping the modem anyway.",
        );
      }
      // Always. The modem holds the sound card exclusively; leaving it running
      // after a session blocks the next one and the device test, and nothing in
      // the UI would explain why.
      await modem.stop();
      this.opts.onLog?.("The modem has been stopped and the sound card released");

      // Heal rig control before anything below asks it for something: a
      // client socket that died during the session (the CI-V probe, chiefly)
      // otherwise turns the mode restore AND the unkey into silent no-ops,
      // and the unkey is the one command that must never be lost.
      if (rig && profile.hamlib) await this.opts.ensureRig?.();

      // The mode goes back, and the frequency goes back only when WE set it.
      // When Pat tuned (no pre-tune happened), its qsy() already defers its own
      // restore of the dial frequency (app/connect.go:243-247), and a second
      // writer with no ordering between them would leave the operator wherever
      // the last one happened to land -- so exactly one of the two ever runs.
      await rig?.restore(rigSnapshot);
      if (restoreFrequencyHz !== null && rig) {
        await rig.setFrequencyHz(restoreFrequencyHz).catch(() => false);
      }

      // Then command the unkey, separately and unconditionally, on BOTH paths.
      //
      // Stopping the modem does not release the radio, and the reason differs
      // by keying method -- which is why both run rather than one being chosen:
      //
      //   CAT      ardopcf sends its unkey while completing a transmission, so
      //            a modem killed or crashing mid-transmission never sends it,
      //            and killing a process cannot undo bytes already written to a
      //            serial port. releasePtt writes the unkey itself.
      //   rigctld  PAT holds the asserted PTT through Hamlib. Nothing about the
      //            modem stopping tells it to let go, and there is no serial
      //            port being dropped to save us either.
      //
      // Module 10a's rule, and the one failure this project's stated
      // differentiator is about.
      await rig?.stopTransmitting();
      await releasePtt(profile.ptt);
    }
  }

  /**
   * The pre-dial listen: attach to the modem's host socket, require ten
   * consecutive clear seconds, and hand any hold decision to the operator.
   *
   * The check must never be the thing that kills a session. Any failure to
   * run it -- the client refusing to connect, chiefly -- is logged and treated
   * as "clear": Pat's own busy-channel prompt (fed the current state by vendor
   * patch 0008) remains as the fallback. A verdict of "abort" is different:
   * that is the operator, or a modem that died under the check, and the
   * session ends without dialling.
   */
  private async runChannelCheck(modem: ArdopProcessManager): Promise<ChannelVerdict> {
    const port = modem.getState().hostPort;
    const client = this.opts.createHostClient?.(port) ?? new ArdopHostClient({ port });
    const monitor = new ClearChannelMonitor({
      onUpdate: (update) => this.opts.onChannelCheck?.({ ...update }),
      ...(this.opts.channelClearWindowMs === undefined
        ? {}
        : { clearWindowMs: this.opts.channelClearWindowMs }),
    });
    this.channelMonitor = monitor;
    try {
      await client.connect();
      // Reset the busy detector before the window opens: LISTEN TRUE calls
      // ClearBusy() (HostInterface.c:886-893), discarding averages that
      // predate the pre-tune. Without this the first seconds of the window
      // are judged on whatever the radio heard on the OLD frequency. Logged
      // and ignored on failure -- the check must never kill a session.
      await client.send("LISTEN TRUE").catch((err: unknown) => {
        this.opts.onLog?.(`The busy detector could not be reset (${message(err)}); listening anyway.`);
      });
      const offLine = client.onLine((line) => {
        const match = /^BUSY (TRUE|FALSE)\b/.exec(line.trim());
        if (match) monitor.handleBusy(match[1] === "TRUE");
      });
      // A modem that dies or is reset takes the socket with it; without this
      // the wait below would never settle.
      const offClose = client.onClose(() => monitor.cancel());
      try {
        return await monitor.wait();
      } finally {
        offLine();
        offClose();
      }
    } catch (err: unknown) {
      this.opts.onLog?.(`The clear-channel check could not run (${message(err)}); calling anyway.`);
      return "clear";
    } finally {
      this.channelMonitor = null;
      // "done" however the check ended, so no stale hold outlives it.
      this.opts.onChannelCheck?.({ phase: "done", secondsRemaining: null, promptOperator: false });
      await client.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, HOST_HANDOFF_SETTLE_MS));
    }
  }

  /**
   * Stops the transmitter now, and abandons whatever was in progress.
   *
   * ORDER MATTERS, and it is not the obvious one.
   *
   * Under CAT keying, killing ardopcf was enough: the process died, the serial
   * port closed, and the radio dropped out of transmit as a side effect. Under
   * rig-control keying that is no longer true -- PAT holds the asserted PTT
   * through rigctld, and killing the modem only stops the audio. The radio
   * stays keyed, transmitting nothing, until something explicitly unkeys it.
   *
   * So the single rigctl line goes FIRST. It is also by far the fastest of the
   * three: the dirty disconnect is a round trip to Pat and the modem kill waits
   * on a process. Every one of them still runs, because each covers a case the
   * others do not, and none is allowed to stop the rest on failure.
   */
  async abort(): Promise<{ ok: boolean; message: string }> {
    const profile = this.opts.getProfile();
    const problems: string[] = [];

    // 0. A Stop during the pre-dial channel check: settle the check as an
    //    abort so connect() unwinds through its own teardown. Nothing has
    //    transmitted yet, but the rest of this method still runs -- each step
    //    below is a no-op when there is nothing for it to do, and skipping
    //    them on a guess is how a keyed transmitter gets walked away from.
    this.channelMonitor?.decide("abort");

    //    And the sign-off wait with it: Stop means the transmitter goes off
    //    NOW. Waiting out a station ID here would delay the very unkey this
    //    method exists to guarantee.
    this.opts.getSignOffWaiter?.()?.markAborted();

    // 1. Unkey through rig control. The only thing that stops the carrier when
    //    Pat is the one holding PTT. Healed first: a rig client whose socket
    //    died mid-session would otherwise report "not running" and leave the
    //    transmitter keyed -- the one failure this whole method exists for.
    const rig = this.opts.getRig?.() ?? null;
    const usesRigKeying = profile?.ptt.method === "rigctld";
    if (rig && profile?.hamlib) await this.opts.ensureRig?.();
    if (rig) {
      const unkeyed = await rig.stopTransmitting().catch(() => false);
      if (!unkeyed && usesRigKeying) {
        problems.push("the radio did not acknowledge the unkey through rig control");
      }
    } else if (usesRigKeying) {
      problems.push("rig control is not running, so the radio could not be unkeyed through it");
    }

    // 2. Tell Pat to stop, without waiting for the remote station.
    try {
      await this.opts.getSession()?.abort();
    } catch (err: unknown) {
      problems.push(`the protocol engine did not accept the abort (${message(err)})`);
    }

    // 3. Kill the modem, which is what stops the audio, then command the unkey
    //    on the profile's own keying path as the last unconditional guard.
    try {
      const modem = this.opts.getModem();
      if (modem) await modem.resetModem();
    } catch (err: unknown) {
      problems.push(`the modem could not be stopped (${message(err)})`);
    }

    if (profile) await releasePtt(profile.ptt);

    this.running = false;

    // Reported honestly. "Stopped" when it may not have is the one answer that
    // must never be given here -- an operator who believes the transmitter is
    // off will walk away from a radio that is still keyed.
    if (problems.length) {
      const described = `The transmission may not have stopped: ${joinList(problems)}. Switch the radio off if it is still transmitting.`;
      this.opts.onLog?.(described);
      return { ok: false, message: described };
    }

    this.opts.onLog?.("Transmission aborted and the radio unkeyed");
    return { ok: true, message: "Transmitting stopped." };
  }
}

/** Turns a refused resolution into a throw, keeping connect() readable. */
function requireDevice(resolved: ResolvedAudioDevice): string {
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.argument;
}

/**
 * Why the modem would not start, in terms an operator can act on.
 *
 * ardopcf exits without saying why, so the cause has to be inferred from what
 * the process manager could observe. Each branch names something to go and do.
 */
export function describeModemFailure(reason: string): string {
  if (/already listening|address already in use/i.test(reason)) {
    // The stale-port case, which has its own recovery action.
    return reason;
  }
  if (/exited with code/i.test(reason)) {
    return (
      `The modem started and then stopped immediately. That almost always means it could not open ` +
      `the sound card — check the radio is still plugged in, and that no other program is using it.` +
      (process.platform === "darwin"
        ? ` If macOS asked for microphone access and it was declined, allow it under ` +
          `System Settings > Privacy & Security > Microphone.`
        : "")
    );
  }
  if (/not found|rebuild it/i.test(reason)) return reason;
  return `The modem did not start: ${reason}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "a, b and c" -- so a list of missing fields reads as a sentence. */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
