// Keeps the running Pat process in step with the operator's identity.
//
// Two things reach Pat, by two different routes: the callsign and locator go
// into its config file, and the Winlink password goes into its environment.
// The environment is fixed at spawn, so applying a change means restarting the
// subprocess -- which is why this reconciles rather than pushes. An ordinary
// launch, where nothing has changed, must not bounce Pat at all.

import { createHash } from "node:crypto";
import {
  applyPatIdentity,
  readPatConfig,
  WL2GO_RIG_NAME,
  type ApplyOutcome,
  type PatIdentity,
} from "./patConfigFile.ts";

export interface DesiredIdentity extends PatIdentity {
  /** Null when the operator has no Winlink password stored. */
  password: string | null;
}

/**
 * A stable summary of an identity, used to decide whether Pat is out of date.
 *
 * The password is hashed rather than kept: comparing fingerprints answers the
 * only question we have ("did it change?") without holding the plaintext in a
 * long-lived field. The salt-free hash is fine here -- this never leaves the
 * process and is not a credential store.
 */
export function fingerprintIdentity(identity: DesiredIdentity): string {
  const hash = createHash("sha256");
  hash.update(identity.mycall);
  hash.update(" ");
  hash.update(identity.locator);
  hash.update(" ");
  // Both of these are read by Pat only at startup (app/connect.go:285 for the
  // modem address, app/app.go:240 for the prediction engine), so a change to
  // either is exactly the kind that needs a restart to take effect. Leaving
  // them out of the fingerprint would write the new value into the file and
  // then never apply it.
  hash.update(identity.ardopAddr);
  hash.update(" ");
  // Read at startup too, and more consequentially than the others: Pat opens
  // every rig in hamlib_rigs once (app/app.go:455-500) and every later ARDOP
  // connect hard-errors if the one ardop.rig names did not load
  // (app/connect.go:315). A rig change that did not restart Pat would leave a
  // Pat that cannot key the radio at all.
  hash.update(identity.rigAddr ?? "");
  hash.update(" ");
  hash.update(identity.predictionEngine);
  hash.update(" ");
  hash.update(identity.password === null ? "" : `set:${identity.password}`);
  return hash.digest("hex");
}

export interface PatIdentitySyncOptions {
  patConfigPath: string;
  /** Restarts Pat so a new environment and config take effect. */
  restart: () => Promise<void>;
  onLog?: (message: string) => void;
  onError?: (message: string) => void;
  /**
   * How long to wait for a burst of config changes to settle before acting.
   *
   * Saving a callsign and a password are two separate mutations that arrive
   * milliseconds apart, and each one fires a change event. Without a window
   * here that is two restarts; with it, one.
   */
  coalesceMs?: number;
}

const DEFAULT_COALESCE_MS = 250;

export class PatIdentitySync {
  private readonly opts: PatIdentitySyncOptions;
  private appliedFingerprint: string | null = null;

  // Reconciles must never overlap. A restart is a stop followed by a start, so
  // two in flight together interleave into stop/stop/start/start -- which spawns
  // two Pat processes, the second of which dies on "address already in use".
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private latest: (() => DesiredIdentity) | null = null;

  constructor(options: PatIdentitySyncOptions) {
    this.opts = options;
  }

  /**
   * Asks for a reconcile, coalescing a burst into one and never overlapping.
   *
   * Takes a getter rather than a value so that when the work finally runs it
   * uses the newest identity, not whichever one happened to schedule it.
   */
  requestReconcile(getDesired: () => DesiredIdentity): void {
    this.latest = getDesired;

    if (this.running) {
      // Something changed mid-flight; go round again with the newest values
      // once the current pass finishes.
      this.rerun = true;
      return;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.opts.coalesceMs ?? DEFAULT_COALESCE_MS);
  }

  /** Runs any pending reconcile immediately and waits for it. For tests and quit. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.drain();
      return;
    }
    await this.running;
  }

  private async drain(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }

    this.running = (async () => {
      do {
        this.rerun = false;
        const desired = this.latest?.();
        if (!desired) return;
        try {
          await this.reconcile(desired);
        } catch (err: unknown) {
          this.opts.onError?.(err instanceof Error ? err.message : String(err));
        }
      } while (this.rerun);
    })();

    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  /**
   * Records what the currently running Pat was started with.
   *
   * Called straight after the initial spawn, so the first reconcile of an
   * unchanged config is a no-op rather than an immediate restart.
   */
  markApplied(identity: DesiredIdentity): void {
    this.appliedFingerprint = fingerprintIdentity(identity);
  }

  /** Whether the running Pat is out of step with this identity. */
  needsApply(identity: DesiredIdentity): boolean {
    return this.appliedFingerprint !== fingerprintIdentity(identity);
  }

  /**
   * Writes the identity into Pat's config file, without touching the process.
   *
   * Used before the first spawn, when there is nothing to restart. Safe to call
   * when Pat has never run -- it reports "missing" rather than failing.
   */
  writeConfigOnly(identity: DesiredIdentity): ApplyOutcome {
    return applyPatIdentity(this.opts.patConfigPath, identity);
  }

  /**
   * What the freshly started Pat is actually running with.
   *
   * Read back from the config Pat itself seeded rather than assumed from what
   * we intended: on a launch where Pat creates the file for the first time, our
   * pre-spawn write was a no-op, so the two differ. Recording the intent here
   * would mark an identity applied that never reached Pat, and no later
   * reconcile would ever correct it.
   */
  observeApplied(password: string | null): void {
    const config = readPatConfig(this.opts.patConfigPath);
    const read = (key: string): string => {
      const value = config?.[key];
      return typeof value === "string" ? value : "";
    };
    // Nested sections, read the same defensive way as the flat fields: Pat may
    // not have written them yet on the launch where it seeds its config.
    const nested = (key: string, field: string): string => {
      const section = config?.[key];
      if (typeof section !== "object" || section === null || Array.isArray(section)) return "";
      const value = (section as Record<string, unknown>)[field];
      return typeof value === "string" ? value : "";
    };

    // The rig's address lives one level deeper than the others, under its own
    // name in hamlib_rigs. Absent is the ordinary state, not a fault.
    const rigs = config?.["hamlib_rigs"];
    const rig =
      typeof rigs === "object" && rigs !== null && !Array.isArray(rigs)
        ? (rigs as Record<string, unknown>)[WL2GO_RIG_NAME]
        : undefined;
    const rigAddr =
      typeof rig === "object" && rig !== null && typeof (rig as Record<string, unknown>)["address"] === "string"
        ? ((rig as Record<string, unknown>)["address"] as string)
        : null;

    this.markApplied({
      mycall: read("mycall"),
      locator: read("locator"),
      ardopAddr: nested("ardop", "addr"),
      rigAddr,
      predictionEngine: nested("prediction", "engine"),
      versionReportingDisabled: config?.["version_reporting_disabled"] === true,
      password,
    });
  }

  /**
   * Forgets what Pat is believed to be running, forcing the next reconcile to
   * restart it even though nothing in the identity changed.
   *
   * For the case the fingerprint cannot see: rigctld died and came back, so Pat
   * is now attached to a rig that no longer exists. Its config still says
   * exactly what it should, which is precisely why comparing fingerprints would
   * conclude there is nothing to do -- and leave a Pat that cannot key the
   * radio until something unrelated happened to bounce it.
   */
  forgetApplied(): void {
    this.appliedFingerprint = null;
  }

  /**
   * Brings Pat into line with the given identity, restarting it if needed.
   *
   * Returns whether a restart actually happened. A restart is a visible event --
   * the API drops for a moment and System Check notices -- so it must only occur
   * when something genuinely changed.
   */
  async reconcile(identity: DesiredIdentity): Promise<boolean> {
    if (!this.needsApply(identity)) return false;

    // "missing" means Pat has not seeded its config yet, so the identity did not
    // land. Restarting would not help and recording it as applied would strand
    // the mismatch forever, since no later reconcile would see a difference.
    if (this.writeConfigOnly(identity) === "missing") {
      this.opts.onLog?.("Pat has not written its configuration yet; the station identity will be applied once it has");
      return false;
    }

    this.opts.onLog?.(
      identity.mycall
        ? `Applying station identity ${identity.mycall}; restarting the protocol engine`
        : "Clearing station identity; restarting the protocol engine",
    );

    await this.opts.restart();
    this.appliedFingerprint = fingerprintIdentity(identity);
    return true;
  }
}
