import { spawn, type ChildProcess } from "node:child_process";
import { LOOPBACK_HOST } from "../util/loopback.ts";
import type { Writable } from "node:stream";
import type { BinaryInfo, RigctldProcessState, SubprocessState } from "../../shared/ipcContract.ts";
import { inspectBinary } from "../util/binaryInfo.ts";
import { resolveBinaryPath } from "../pat/patProcessManager.ts";
import { waitForTcpPort } from "../util/tcpProbe.ts";

/**
 * Hamlib's rig-control daemon. Like the modem it is not started at launch:
 * it opens the radio's serial port exclusively, so it runs only while a Radio
 * Profile that needs CAT control is active. Module 10 drives that.
 */

/** rigctld's own default TCP port. */
export const RIGCTLD_DEFAULT_PORT = 4532;

/**
 * Hamlib's dummy backend. It emulates a radio entirely in software, so the
 * daemon can be proven to start and answer with no hardware attached.
 */
export const DUMMY_RIG_MODEL = 1;

export interface RigctldProcessOptions {
  resourcesBinDir: string;
  port?: number;
  /** Hamlib rig model number. Defaults to the dummy backend. */
  model?: number;
  /** Serial device for the radio, e.g. /dev/tty.usbserial-1420. */
  device?: string;
  /** Serial speed; Hamlib's per-model default is used when omitted. */
  baudRate?: number;
  createLogStream?: () => Writable;
  onStateChange?: (state: RigctldProcessState) => void;
  /**
   * Fired when the process exits, whether or not stop() asked it to.
   *
   * Needed because a rigctld that dies takes Pat's rig with it and Pat cannot
   * reopen one: it connects to every rig in hamlib_rigs once, at startup
   * (app/app.go:455-500). Without this the radio silently stops being tunable
   * or keyable and the next session fails with an error naming neither.
   * Telling a deliberate stop from a crash is the CALLER's job -- it is the one
   * that knows it asked.
   */
  onExit?: () => void;
}

export class RigctldProcessManager {
  private readonly opts: RigctldProcessOptions;
  private proc: ChildProcess | null = null;
  private logStream: Writable | null = null;
  private state: SubprocessState = "idle";
  private lastError: string | null = null;
  private binary: BinaryInfo | null = null;
  private exitInfo: string | null = null;

  constructor(opts: RigctldProcessOptions) {
    this.opts = opts;
  }

  get binaryPath(): string {
    return resolveBinaryPath(this.opts.resourcesBinDir, "rigctld");
  }

  get port(): number {
    return this.opts.port ?? RIGCTLD_DEFAULT_PORT;
  }

  getState(): RigctldProcessState {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      binaryPath: this.binaryPath,
      binary: this.binary,
      port: this.port,
      model: this.opts.model ?? DUMMY_RIG_MODEL,
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

  /** The command line rigctld is spawned with. Exposed for testing. */
  buildArgs(): string[] {
    // -T binds the listener; rigctld's default is ANY, which would let anyone
    // on the network key the transmitter unauthenticated. See util/loopback.ts.
    const args = [
      "-m",
      String(this.opts.model ?? DUMMY_RIG_MODEL),
      "-T",
      LOOPBACK_HOST,
      "-t",
      String(this.port),
    ];
    if (this.opts.device) args.push("-r", this.opts.device);
    if (this.opts.baudRate) args.push("-s", String(this.opts.baudRate));
    return args;
  }

  async start(readinessTimeoutMs = 10_000): Promise<void> {
    if (this.proc) throw new Error("rigctld already started");

    this.setState("starting");
    const binPath = this.binaryPath;
    const binary = await this.inspect();

    if (!binary.exists) {
      const msg = `rigctld binary not found at ${binPath}. Run: npm run build:rigctld`;
      this.setState("failed", msg);
      throw new Error(msg);
    }
    if (!binary.matchesHost) {
      const msg =
        `rigctld binary at ${binPath} is ${binary.format}/${binary.arch}, ` +
        `which cannot run on ${process.platform}/${process.arch}. Rebuild it: npm run build:rigctld`;
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

    let spawnError: Error | null = null;
    proc.on("error", (err) => {
      spawnError = err;
    });
    proc.on("exit", (code, signal) => {
      this.exitInfo = `exited with code=${code} signal=${signal}`;
      this.logStream?.write(`\n[rigctldProcessManager] ${this.exitInfo}\n`);
      this.proc = null;
      this.opts.onExit?.();
    });

    try {
      await waitForTcpPort(this.port, readinessTimeoutMs, {
        label: "rigctld",
        shouldAbort: () => {
          if (spawnError) return `Failed to spawn rigctld at ${binPath}: ${spawnError.message}`;
          // rigctld exits immediately if the serial port is missing or busy,
          // which is the common failure with a radio that is off or unplugged.
          if (this.exitInfo) return `rigctld ${this.exitInfo} before opening its port`;
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
   * Starts against Hamlib's dummy backend, confirms the port answers, and stops
   * again. Proves the daemon and its bundled library are runnable without a
   * radio attached.
   */
  async selfTest(timeoutMs = 8000): Promise<void> {
    await this.start(timeoutMs);
    await this.stop();
    this.setState("idle");
  }
}
