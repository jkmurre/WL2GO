// Pat's config.json as a derived artifact of ours.
//
// WL2GO owns four fields in it -- mycall, locator, ardop.addr and
// prediction.engine -- and forces a fifth, secure_login_password, permanently
// empty. Everything else is Pat's and
// round-trips untouched, which is why this is a read-modify-write rather than a
// generate: Pat's schema is ~30 fields and modelling it here would only create
// drift across Pat upgrades.
//
// The password reaches Pat through the PAT_SECURELOGINPASSWORD environment
// variable instead (see patProcessManager.ts). It is never written here, and
// this module actively scrubs any value it finds -- left by an older build, a
// hand-edit, or Pat's own web UI.

import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../util/atomicWrite.ts";

/**
 * Pat's config is deliberately typed as an open record. We only ever read and
 * write the fields we own; naming the rest would be a maintenance burden with
 * no benefit, since they pass through as opaque JSON.
 */
export type PatConfig = Record<string, unknown>;

/** The fields WL2GO derives from its own config. */
export interface PatIdentity {
  /** Empty before onboarding; Pat tolerates that for the `http` subcommand. */
  mycall: string;
  /** Maidenhead locator, or empty. */
  locator: string;
  /**
   * Where Pat should look for the ARDOP modem, as "host:port".
   *
   * Owned because Pat reads config.Ardop.Addr when it opens the TNC
   * (app/connect.go:285) and there is no way to change it on a running Pat --
   * /api/reload is deliberately unused here. So it has to be right in the file
   * before Pat starts, which means a profile whose host port differs from the
   * running one needs a restart. That is what the fingerprint is for.
   */
  ardopAddr: string;
  /**
   * The rigctld address Pat should drive the radio through, or null for none.
   *
   * Owned because it is what makes Pat able to tune and to key. Pat opens every
   * rig in `hamlib_rigs` ONCE, at startup (app/app.go:455-500), and skips any
   * whose connection fails -- after which `initARDOP` hard-errors
   * "unable to set PTT rig ... Not defined or not loaded" on every ARDOP
   * connect (app/connect.go:315). So rigctld has to be listening before Pat is
   * spawned, and a change here needs a restart exactly as ardopAddr does.
   */
  rigAddr: string | null;
  /**
   * The HF propagation engine, and this is NOT cosmetic.
   *
   * Pat's default is "" (auto), which tries a LOCAL voacap binary and, when
   * that is missing, simply breaks out of the switch leaving a.predictor nil
   * (app/app.go:240-251). It does NOT fall back to the web service. WL2GO
   * bundles no voacap, so leaving this alone means every station in the browser
   * comes back with no link quality at all.
   *
   * "voacap-api" needs nothing bundled, so packaging is untouched.
   */
  predictionEngine: string;
  /**
   * When true Pat makes no startup calls to api.winlink.org.
   *
   * Left enabled by default, matching other Winlink clients, but the operator
   * can turn it off -- those calls send the callsign and, for the
   * password-recovery check, the Winlink password (app/winlink_api.go:72).
   */
  versionReportingDisabled: boolean;
}

/**
 * Pat writes its config 0600 (app/config.go:191) and so do we, so the file's
 * permissions survive a round-trip through either program.
 */
const CONFIG_MODE = 0o600;

export const PASSWORD_FIELD = "secure_login_password";

/**
 * The name WL2GO's rig is filed under in Pat's `hamlib_rigs`.
 *
 * A fixed key so the entry can be replaced and removed on later runs. Any OTHER
 * rig in that map is left alone, like every field WL2GO does not own.
 */
export const WL2GO_RIG_NAME = "wl2go";

export interface MergeResult {
  config: PatConfig;
  /** False when the file already says exactly this, so nothing need be written. */
  changed: boolean;
}

/**
 * Applies the owned fields to a config read from disk.
 *
 * Pure: no I/O, so the interesting cases -- a password left behind, a config
 * that already matches -- are testable without Pat installed.
 */
export function mergePatConfig(current: PatConfig, identity: PatIdentity): MergeResult {
  // Both of these are NESTED, so they are merged into whatever is already
  // there rather than replaced. Pat's ardop section also carries
  // arq_bandwidth, connect_requests, rig, ptt_ctrl, beacon_interval and
  // cwid_enabled; its prediction section carries voacap and voacap_api
  // sub-objects. Assigning a fresh object would silently wipe all of it.
  //
  // Rig control is three fields that only mean anything together: the rig
  // definition, the ardop section's reference to it by name, and the flag that
  // makes Pat act on ardopcf's PTT notifications. Written as a set, and CLEARED
  // as a set when there is no rig -- a leftover `rig` naming a definition that
  // is no longer there is not inert, it stops every ARDOP session from dialling.
  const rigs = { ...asRecord(current["hamlib_rigs"]) };
  if (identity.rigAddr) {
    rigs[WL2GO_RIG_NAME] = { network: "tcp", address: identity.rigAddr };
  } else {
    delete rigs[WL2GO_RIG_NAME];
  }

  const ardop = {
    ...asRecord(current["ardop"]),
    addr: identity.ardopAddr,
    rig: identity.rigAddr ? WL2GO_RIG_NAME : "",
    // With this set, Pat keys the radio through Hamlib in response to
    // ardopcf's "PTT TRUE"/"PTT FALSE" host notifications (app/connect.go:310-320,
    // a.ardop.SetPTT(rig)). That is the whole of rig-control keying, and it is
    // why ardopcf is given no PTT arguments of its own.
    ptt_ctrl: identity.rigAddr !== null,
  };
  const prediction = { ...asRecord(current["prediction"]), engine: identity.predictionEngine };

  const merged: PatConfig = {
    ...current,
    mycall: identity.mycall,
    locator: identity.locator,
    version_reporting_disabled: identity.versionReportingDisabled,
    hamlib_rigs: rigs,
    ardop,
    prediction,
  };

  // Always written empty, never merely left alone. Pat's own PUT /api/config
  // restores an env-supplied password into the file when it round-trips the
  // "[REDACTED]" sentinel (api/api.go:435), so an unscrubbed field is a real
  // way for the credential to reach the disk.
  merged[PASSWORD_FIELD] = "";

  const currentArdop = asRecord(current["ardop"]);
  const currentRig = asRecord(asRecord(current["hamlib_rigs"])[WL2GO_RIG_NAME]);

  const changed =
    current["mycall"] !== identity.mycall ||
    current["locator"] !== identity.locator ||
    current["version_reporting_disabled"] !== identity.versionReportingDisabled ||
    currentArdop["addr"] !== identity.ardopAddr ||
    currentArdop["rig"] !== ardop.rig ||
    currentArdop["ptt_ctrl"] !== ardop.ptt_ctrl ||
    (currentRig["address"] ?? null) !== identity.rigAddr ||
    asRecord(current["prediction"])["engine"] !== identity.predictionEngine ||
    current[PASSWORD_FIELD] !== "";

  return { config: merged, changed };
}

/** A nested section of Pat's config, or an empty object if it has none yet. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reads Pat's config.
 *
 * Returns null when the file is missing or unreadable rather than throwing:
 * Pat writes a complete default on its first launch (app/config.go:20-30), so
 * "not there yet" is an ordinary state, and a corrupt file must not stop the
 * operator from getting to Settings to fix things.
 */
export function readPatConfig(filePath: string): PatConfig | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as PatConfig;
  } catch {
    return null;
  }
}

export function writePatConfig(filePath: string, config: PatConfig): void {
  writeFileAtomicSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: CONFIG_MODE });
}

/**
 * Outcome of trying to write our identity into Pat's config.
 *
 * "missing" and "unchanged" must not be conflated: the first means the identity
 * did NOT reach Pat and the caller has more work to do, the second means it is
 * already there. Collapsing both into a boolean is how a callsign silently fails
 * to apply on the launch where Pat first seeds its config.
 */
export type ApplyOutcome = "written" | "unchanged" | "missing";

/**
 * Brings Pat's config into line with ours.
 *
 * A missing config is not an error -- Pat writes one on its first launch -- but
 * it does mean nothing was applied, which the caller needs to know before it
 * decides the identity is live.
 */
export function applyPatIdentity(filePath: string, identity: PatIdentity): ApplyOutcome {
  const current = readPatConfig(filePath);
  if (!current) return "missing";

  const { config, changed } = mergePatConfig(current, identity);
  if (!changed) return "unchanged";

  writePatConfig(filePath, config);
  return "written";
}
