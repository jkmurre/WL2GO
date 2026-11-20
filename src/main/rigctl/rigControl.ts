// Owns the rigctld that Pat and WL2GO share, for as long as a profile wants it.
//
// This is resident, NOT per-session, and that is forced by Pat: it opens every
// rig in `hamlib_rigs` once at startup and holds the connection
// (app/app.go:455-500). A rig that was not listening at that moment is skipped,
// and every later ARDOP connect then hard-errors "unable to set PTT rig ... Not
// defined or not loaded" (app/connect.go:315). So rigctld has to be up before
// Pat is spawned and has to stay up for as long as Pat runs.
//
// The single serial port is why this is the only thing allowed to open it. With
// a rig configured, ardopcf is given no PTT arguments at all and Pat keys the
// radio through here instead -- one owner, doing frequency, mode and keying,
// which is what WSJT-X and Winlink Express both do. configSchema's
// validateRigControl is what stops a profile from asking for both.

import type { HamlibConfig, RadioProfile } from "../../shared/configSchema.ts";
import { loopbackAddr } from "../util/loopback.ts";
import { RigctlClient } from "./rigctlClient.ts";
import { RigSession } from "./rigSession.ts";
import { RigctldProcessManager, type RigctldProcessOptions } from "./rigctldProcessManager.ts";

export interface RigControlOptions {
  resourcesBinDir: string;
  createLogStream?: RigctldProcessOptions["createLogStream"];
  onStateChange?: RigctldProcessOptions["onStateChange"];
  onLog?: (message: string) => void;
  onError?: (message: string) => void;
  /**
   * Called when rigctld stops without being asked to.
   *
   * Pat cannot recover from this on its own -- its rig connection is opened
   * once -- so the owner has to restart rigctld AND then Pat. Reported rather
   * than handled here, because restarting Pat is not this module's business.
   */
  onUnexpectedExit?: () => void;
}

/**
 * How many consecutive failed starts before WL2GO stops trying.
 *
 * Bounded because each failure also restarts Pat through the recovery path, so
 * an unbounded retry against a radio that is simply switched off would bounce
 * the protocol engine every few seconds indefinitely. Reset whenever the
 * settings change, so fixing them is always enough to try again.
 */
const MAX_FAILED_STARTS = 3;

/** What actually reaches rigctld, reduced to the parts that need a restart. */
function fingerprint(hamlib: HamlibConfig | null): string {
  if (!hamlib || !hamlib.device) return "";
  return `${hamlib.model}|${hamlib.device}|${hamlib.baud}|${hamlib.port}`;
}

export class RigControl {
  private readonly opts: RigControlOptions;
  private manager: RigctldProcessManager | null = null;
  private client: RigctlClient | null = null;
  private applied = "";
  /** Set while stop() is deliberately tearing things down, so the exit is expected. */
  private stopping = false;
  /**
   * Serialises sync(), which is fired from EVERY config mutation.
   *
   * Two of those arrive milliseconds apart when onboarding saves a callsign and
   * a password -- the same burst PatIdentitySync has a coalescing window for.
   * Without this both calls pass the early return and both construct a manager,
   * and one of the two processes is then owned by nobody.
   */
  private inFlight: Promise<boolean> = Promise.resolve(false);
  /**
   * How many times rigctld has died on startup for the CURRENT settings.
   *
   * Bounded because the recovery path restarts Pat too. A radio that is
   * switched off makes rigctld exit immediately, and an unbounded retry would
   * bounce Pat every few seconds for as long as the app was left running.
   */
  private failedStarts = 0;

  readonly session: RigSession;

  constructor(options: RigControlOptions) {
    this.opts = options;
    this.session = new RigSession({
      getClient: () => this.client,
      onLog: (message) => this.opts.onLog?.(message),
    });
  }

  /** The address Pat should be pointed at, or null when no rig is running. */
  address(): string | null {
    return this.manager ? loopbackAddr(this.manager.port) : null;
  }

  isRunning(): boolean {
    return this.manager?.isRunning() === true;
  }

  /** The running process, for the state broadcast. Null when none. */
  processManager(): RigctldProcessManager | null {
    return this.manager;
  }

  /**
   * Brings rig control into line with a profile.
   *
   * Returns whether anything changed, which is what tells the caller Pat needs
   * restarting. Doing nothing when nothing changed is the point: a profile save
   * that leaves the rig alone must not drop the radio out from under a Pat that
   * is working.
   */
  async sync(profile: RadioProfile | null): Promise<boolean> {
    const next = this.inFlight.then(
      () => this.syncOnce(profile),
      () => this.syncOnce(profile),
    );
    this.inFlight = next.catch(() => false);
    return next;
  }

  /**
   * Makes rig control usable for a session that is about to start, healing
   * whatever state it finds. Returns whether the DAEMON was (re)started, which
   * is what tells the caller Pat's rig connection is stale and needs the same
   * restart dance as an unexpected exit.
   *
   * This exists because sync() only runs on config changes, unexpected exits
   * and startup. Nothing used to re-examine rig control when the operator hit
   * Connect -- so a client connection that had died under a perfectly healthy
   * rigctld, or a daemon whose restart had failed while the radio was off,
   * stayed dead for the life of the app. The operator's only lever was
   * relaunching, and the error ("rig control is not running ... try again")
   * told them to do the one thing that could not work.
   *
   * Resetting the failure bound here is deliberate: the bound exists to stop
   * UNATTENDED retries from bouncing Pat forever, and a connect attempt is an
   * operator saying "try again" -- the same licence a settings change grants.
   */
  async ensure(profile: RadioProfile | null): Promise<boolean> {
    const next = this.inFlight.then(
      () => this.ensureOnce(profile),
      () => this.ensureOnce(profile),
    );
    this.inFlight = next.catch(() => false);
    return next;
  }

  private async ensureOnce(profile: RadioProfile | null): Promise<boolean> {
    this.failedStarts = 0;

    const hamlib = profile?.hamlib ?? null;
    const wanted = fingerprint(hamlib);
    if (!wanted || !hamlib) return false;

    if (wanted === this.applied && this.isRunning()) {
      if (this.client?.isConnected()) return false;

      // The daemon is fine -- and so, therefore, is Pat's own connection to
      // it -- but OUR client socket is gone: it dropped, or its connect failed
      // at startup and nothing ever tried again. Replace just the client; a
      // full restart here would take the rig away from a Pat that is happy.
      await this.client?.close().catch(() => {});
      this.client = null;
      const client = new RigctlClient({ port: hamlib.port });
      try {
        await client.connect();
        this.client = client;
        this.opts.onLog?.("Reconnected to rig control");
      } catch (err: unknown) {
        this.opts.onError?.(
          `Rig control is running but WL2GO could not reconnect to it: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return false;
    }

    // Not running, or running with stale settings: the full path, exactly as a
    // config change would take it. Called directly rather than through sync(),
    // which would deadlock -- sync() chains onto the queue this is running in.
    return this.syncOnce(profile);
  }

  private async syncOnce(profile: RadioProfile | null): Promise<boolean> {
    const wanted = fingerprint(profile?.hamlib ?? null);
    if (wanted === this.applied && (wanted === "" || this.isRunning())) return false;

    // A change of settings is a fresh start: whatever went wrong before was
    // about the OLD ones, so the operator fixing them must not be refused.
    if (wanted !== this.applied) this.failedStarts = 0;
    if (this.failedStarts >= MAX_FAILED_STARTS) return false;

    await this.stop();
    this.applied = wanted;
    if (!wanted || !profile?.hamlib?.device) return true;

    // Narrowed above by the `!profile?.hamlib?.device` guard; restated so the
    // device is a string rather than string|null for the spawn arguments.
    const hamlib = { ...profile.hamlib, device: profile.hamlib.device };
    const manager = new RigctldProcessManager({
      resourcesBinDir: this.opts.resourcesBinDir,
      port: hamlib.port,
      model: hamlib.model,
      device: hamlib.device,
      baudRate: hamlib.baud,
      ...(this.opts.createLogStream ? { createLogStream: this.opts.createLogStream } : {}),
      ...(this.opts.onStateChange ? { onStateChange: this.opts.onStateChange } : {}),
      onExit: () => {
        // `started` is what keeps a failed STARTUP out of the crash path, and
        // it matters more than it looks. start() registers this handler before
        // it waits for the port, so a rigctld that exits immediately -- radio
        // switched off, wrong CAT port, the common failures -- fires this while
        // start() is still being awaited, before the catch below can clear
        // this.manager. Both other guards pass at that moment, so the recovery
        // would spawn rigctld again AND restart Pat, every ten seconds, for as
        // long as the app was left running.
        if (!started || this.stopping || this.manager !== manager) return;
        this.opts.onError?.(
          "Rig control stopped unexpectedly. The radio cannot be tuned or keyed until it is back.",
        );
        this.opts.onUnexpectedExit?.();
      },
    });
    this.manager = manager;

    let started = false;
    try {
      await manager.start();
      started = true;
      this.failedStarts = 0;
    } catch (err: unknown) {
      this.manager = null;
      this.failedStarts += 1;
      const described = describeRigctldFailure(hamlib, err instanceof Error ? err.message : String(err));
      this.opts.onError?.(
        this.failedStarts >= MAX_FAILED_STARTS
          ? `${described} WL2GO has stopped retrying; change the profile's rig settings to try again.`
          : described,
      );
      return true;
    }

    // Our own connection, held alongside Pat's. rigctld accepts many clients,
    // unlike ardopcf's single host socket, which is what lets WL2GO set the
    // mode on a radio Pat is keying through.
    const client = new RigctlClient({ port: hamlib.port });
    try {
      await client.connect();
      this.client = client;
    } catch (err: unknown) {
      this.opts.onError?.(
        `Rig control started but WL2GO could not talk to it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.opts.onLog?.(
      `Rig control running on port ${hamlib.port} for Hamlib model ${hamlib.model} on ${hamlib.device}`,
    );
    return true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    try {
      await this.client?.close().catch(() => {});
      this.client = null;
      const manager = this.manager;
      this.manager = null;
      if (manager) {
        await manager.stop().catch(() => {});
        this.opts.onLog?.("Rig control stopped and the radio's CAT port released");
      }
    } finally {
      this.stopping = false;
    }
  }
}

/**
 * Why rigctld would not start, in terms that name something to go and do.
 *
 * The serial cases dominate in the field and none of them are things WL2GO can
 * fix, so each one has to say which thing to check.
 */
export function describeRigctldFailure(hamlib: HamlibConfig, reason: string): string {
  if (/not found|rebuild it/i.test(reason)) return reason;
  if (/already listening|address already in use|EADDRINUSE/i.test(reason)) {
    return (
      `Port ${hamlib.port} is already in use, so rig control could not start. ` +
      `Quit any other program using the radio (rigctld, WSJT-X, fldigi) and try again.`
    );
  }
  if (/exited with code/i.test(reason)) {
    return (
      `Rig control started and stopped immediately. That almost always means ${hamlib.device} could not ` +
      `be opened — check the radio is switched on and plugged in, and that nothing else is using its ` +
      `CAT port. If the port is right, the radio model may be wrong for this radio.`
    );
  }
  return `Rig control did not start: ${reason}`;
}
