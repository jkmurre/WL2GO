import { spawn, type ChildProcess } from "node:child_process";
import { loopbackAddr } from "../util/loopback.ts";
import { PatLogFilter } from "./patLogFilter.ts";
import { chmod, mkdir, open } from "node:fs/promises";
import type { Writable } from "node:stream";
import * as http from "node:http";
import * as path from "node:path";
import type { BinaryInfo, PatProcessState, SubprocessState } from "../../shared/ipcContract.ts";
import { inspectBinary } from "../util/binaryInfo.ts";
import { findFreeLoopbackPort } from "../util/tcpProbe.ts";
import { PAT_TOKEN_HEADER } from "./patApiClient.ts";

/** Read once by patched Pat, then removed from its environment. */
export const PAT_TOKEN_ENV = "WL2GO_PAT_TOKEN";

export interface PatProcessOptions {
  /** Root of the vendored binaries tree: resources/bin. */
  resourcesBinDir: string;
  configPath: string;
  mailboxDir: string;
  /**
   * Directory Pat looks in for prehook scripts. Pointed inside our userData and
   * left empty on purpose: Pat's default is outside the app entirely, and
   * connect.go:206 hands a prehook the full environment -- which is where the
   * Winlink password lives. No scripts, no leak.
   */
  prehooksDir: string;
  /**
   * Pat's own log. Pre-created 0600 before every spawn, because on Winlink
   * account activation Pat prints the assigned password into it and creates it
   * 0644 by default.
   */
  logPath: string;
  eventLogPath: string;
  formsDir: string;
  /**
   * A fixed API port, for tests. Omitted, a free loopback port is chosen on the
   * first start and kept across restarts: a well-known port is one a web page in
   * the operator's browser does not have to guess.
   */
  httpPort?: number;
  /**
   * The per-launch secret every API request must carry (patch 0001 in
   * vendor/pat/patches). Loopback alone does not keep a browser out, since any
   * page the operator has open can reach 127.0.0.1. Null runs Pat unguarded.
   */
  apiToken?: string | null;
  /**
   * The Winlink account password, or null.
   *
   * Supplied to Pat through the environment, never through its config file and
   * never through argv. Pat applies environment variables over the config on
   * every load (app/config.go:32-35), so this is the one way to give it the
   * credential without writing it to disk or exposing it in `ps`.
   */
  winlinkPassword?: string | null;
  /**
   * Called when Pat prints a Winlink-assigned account password. Pat only ever
   * prints it, so this is the single chance to keep it -- and the filter that
   * raises it also redacts it before anything reaches the log.
   */
  onActivationPassword?: (password: string) => void;
  /** Where to send Pat's stdout/stderr. Injected so this stays testable. */
  createLogStream?: () => Writable;
  onStateChange?: (state: PatProcessState) => void;
}

/**
 * Vendored binaries are keyed by Node's process.platform / process.arch, which
 * is also what scripts/build-*.sh writes (it maps Go's naming onto Node's --
 * Go says "amd64" where Node says "x64").
 */
export function resolveBinaryPath(
  resourcesBinDir: string,
  binaryName = "pat",
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const exeName = platform === "win32" ? `${binaryName}.exe` : binaryName;
  return path.join(resourcesBinDir, platform, arch, exeName);
}

/**
 * Creates Pat's log file owner-only, before Pat can create it itself.
 *
 * Pat opens this with os.Create, which is O_CREATE|O_TRUNC and 0666 -- so a file
 * it creates lands at 0644, world-readable, and on account activation it will
 * contain the operator's Winlink password in clear text. Go applies that
 * permission ONLY when creating: on an existing file it truncates and leaves the
 * mode alone. Creating it here first is therefore what fixes the mode, and the
 * directory is 0700 so the file is unreachable even if the mode is ever lost.
 */
export async function prepareLogFile(logPath: string): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  // Existing file: fix the mode without disturbing the contents Pat will
  // truncate anyway. Missing file: create it empty and owner-only.
  const handle = await open(logPath, "a", 0o600);
  try {
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await chmod(path.dirname(logPath), 0o700);
}

export function tryGetStatus(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 1000,
  token: string | null = null,
): Promise<boolean> {
  return new Promise((resolve) => {
    const headers = token ? { [PAT_TOKEN_HEADER]: token } : undefined;
    const req = http.get({ host, port, path: "/api/status", timeout: timeoutMs, headers }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export interface WaitOptions {
  host?: string;
  intervalMs?: number;
  /** Called between polls; lets the caller abort early if the process died. */
  shouldAbort?: () => string | null;
  /** The API token; a guarded Pat answers 403 to a probe without it. */
  token?: string | null;
}

export async function waitUntilReady(port: number, timeoutMs: number, options: WaitOptions = {}): Promise<void> {
  const { host = "127.0.0.1", intervalMs = 150, shouldAbort, token = null } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const abortReason = shouldAbort?.();
    if (abortReason) throw new Error(abortReason);
    if (await tryGetStatus(port, host, 1000, token)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Pat's /api/status did not respond on port ${port} within ${timeoutMs}ms`);
}

export class PatProcessManager {
  private readonly opts: PatProcessOptions;
  private proc: ChildProcess | null = null;
  private logStream: Writable | null = null;
  private state: SubprocessState = "idle";
  private lastError: string | null = null;
  private binary: BinaryInfo | null = null;
  private restarting = false;
  private exitInfo: string | null = null;
  /** 0 until the first start picks one; then fixed for this manager's life. */
  private port: number;

  constructor(opts: PatProcessOptions) {
    this.opts = opts;
    this.port = opts.httpPort ?? 0;
  }

  /** The API port, or 0 before the first start. */
  get httpPort(): number {
    return this.port;
  }

  get binaryPath(): string {
    return resolveBinaryPath(this.opts.resourcesBinDir);
  }

  getState(): PatProcessState {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      binaryPath: this.binaryPath,
      binary: this.binary,
      httpPort: this.port,
      lastError: this.lastError,
    };
  }

  private setState(state: SubprocessState, error: string | null = null): void {
    this.state = state;
    this.lastError = error;
    this.opts.onStateChange?.(this.getState());
  }

  isRunning(): boolean {
    // True across a restart as well, so the quit path waits for the gap between
    // stop() and start() instead of concluding there is nothing to tear down.
    return this.restarting || this.proc !== null;
  }


  /**
   * Starts Pat. Rejects with an operator-readable reason rather than a raw
   * spawn error. The binary is inspected before spawning so a missing or
   * wrong-architecture binary fails in milliseconds instead of after the full
   * readiness timeout.
   */
  /**
   * The command line Pat is spawned with. Exposed so the tests can assert it.
   *
   * Deliberately carries NO --mycall. Pat adopts options.MyCall from
   * config.mycall when the flag is absent (app/app.go:217-224), which makes our
   * generated config the single source. It also disarms the trap immediately
   * below that, at app/app.go:230-233, where Pat discards
   * config.secure_login_password whenever the flag and the config disagree --
   * with no flag there is nothing to disagree with.
   *
   * The Winlink password is NOT here and must never be: argv is world-readable
   * through `ps`. It goes in the environment instead; see buildEnv().
   */
  buildArgs(): string[] {
    return [
      "--config",
      this.opts.configPath,
      "--mbox",
      this.opts.mailboxDir,
      // Keeps Pat inside our userData; its default prehooks path is outside the
      // app. The directory stays empty, which also means no script can inherit
      // the environment this process is given.
      "--prehooks",
      this.opts.prehooksDir,
      // Pat's log, event log and forms all default outside the app. Naming them
      // keeps WL2GO self-contained and, for the log, puts the file somewhere we
      // control the permissions of.
      "--log",
      this.opts.logPath,
      "--event-log",
      this.opts.eventLogPath,
      "--forms",
      this.opts.formsDir,
      "http",
      // Loopback only. A bare ":port" binds every interface, which would expose
      // the API to the whole network. See util/loopback.ts.
      "--addr",
      loopbackAddr(this.port),
    ];
  }

  /**
   * The environment Pat is spawned with.
   *
   * PAT_SECURELOGINPASSWORD is how the Winlink password reaches Pat without
   * ever being written to disk. The name is not arbitrary: envconfig is called
   * with the prefix "Pat" (app/config.go:33) and the field carries no tag, so
   * v1.4.0's naming rules produce exactly this key.
   *
   * Omitted entirely when there is no password, rather than set empty -- an
   * empty value would still override anything else and says something different
   * from "not configured".
   *
   * The API token travels the same way, and for the same reason: argv is
   * readable through `ps`.
   */
  buildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = { ...base };
    delete env["PAT_SECURELOGINPASSWORD"];
    delete env[PAT_TOKEN_ENV];

    const password = this.opts.winlinkPassword;
    if (password) env["PAT_SECURELOGINPASSWORD"] = password;
    const token = this.opts.apiToken;
    if (token) env[PAT_TOKEN_ENV] = token;
    return env;
  }

  async start(readinessTimeoutMs = 10_000): Promise<void> {
    if (this.proc) throw new Error("Pat process already started");

    this.setState("starting");
    const binPath = this.binaryPath;
    this.binary = await inspectBinary(binPath);

    if (!this.binary.exists) {
      const msg = `Pat binary not found at ${binPath}. Run: npm run build:pat`;
      this.setState("failed", msg);
      throw new Error(msg);
    }
    if (!this.binary.matchesHost) {
      const msg =
        `Pat binary at ${binPath} is ${this.binary.format}/${this.binary.arch}, ` +
        `which cannot run on ${process.platform}/${process.arch}. Rebuild it: npm run build:pat`;
      this.setState("failed", msg);
      throw new Error(msg);
    }

    await mkdir(this.opts.mailboxDir, { recursive: true });
    await mkdir(path.dirname(this.opts.configPath), { recursive: true });
    await mkdir(this.opts.prehooksDir, { recursive: true });
    await mkdir(this.opts.formsDir, { recursive: true });
    await prepareLogFile(this.opts.logPath);
    if (this.port === 0) this.port = await findFreeLoopbackPort();

    this.logStream = this.opts.createLogStream?.() ?? null;

    const proc = spawn(binPath, this.buildArgs(), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.buildEnv(),
    });
    this.proc = proc;
    this.exitInfo = null;

    if (this.logStream) {
      // Through the redacting filter, never straight to the file: Pat prints the
      // Winlink activation password to stdout, and once it is written it is
      // written. See patLogFilter.ts.
      const filter = new PatLogFilter({
        onPassword: (password) => this.opts.onActivationPassword?.(password),
      });
      filter.pipe(this.logStream, { end: false });
      proc.stdout?.pipe(filter, { end: false });
      proc.stderr?.pipe(filter, { end: false });
    }

    let spawnError: Error | null = null;
    proc.on("error", (err) => {
      spawnError = err;
    });
    proc.on("exit", (code, signal) => {
      this.exitInfo = `exited with code=${code} signal=${signal}`;
      this.logStream?.write(`\n[patProcessManager] ${this.exitInfo}\n`);
      this.proc = null;
    });

    try {
      await waitUntilReady(this.port, readinessTimeoutMs, {
        token: this.opts.apiToken ?? null,
        shouldAbort: () => {
          if (spawnError) return `Failed to spawn Pat at ${binPath}: ${spawnError.message}`;
          if (this.exitInfo) return `Pat ${this.exitInfo} before becoming ready`;
          return null;
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.setState("failed", reason);
      throw new Error(reason);
    }

    this.setState("running");
  }

  /** SIGTERM, escalating to SIGKILL, so a wedged Pat can never block app quit. */
  async stop(timeoutMs = 5000): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.setState("stopped");
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
        // If SIGKILL still yields nothing, give up rather than hang the quit path.
        setTimeout(finish, 1000);
      }, timeoutMs);

      proc.once("exit", finish);
      proc.kill("SIGTERM");
    });

    this.logStream?.end();
    this.logStream = null;
    this.proc = null;
    this.setState("stopped");
  }

  /**
   * Stops Pat and starts it again with its current options.
   *
   * Needed because the Winlink password is supplied through the environment,
   * which is fixed at spawn -- so a credential or callsign change can only take
   * effect on a fresh process. Deliberately composed from the existing stop()
   * and start() rather than a second lifecycle path: those two already handle
   * SIGTERM escalation and readiness probing, and a parallel implementation
   * would be the one that rots.
   */
  async restart(readinessTimeoutMs = 10_000): Promise<void> {
    // Refuse rather than interleave. Two overlapping restarts become
    // stop/stop/start/start, and the second Pat dies binding a port the first
    // already holds. The caller serialises; this makes a mistake there loud.
    if (this.restarting) throw new Error("Pat is already restarting");

    this.restarting = true;
    try {
      await this.stop();
      await this.start(readinessTimeoutMs);
    } finally {
      this.restarting = false;
    }
  }
}
