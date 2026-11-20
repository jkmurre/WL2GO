import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  PASSWORD_FIELD,
  applyPatIdentity,
  mergePatConfig,
  readPatConfig,
  writePatConfig,
  type PatConfig,
  type PatIdentity,
} from "./patConfigFile.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wl2go-patcfg-"));
  file = path.join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A trimmed stand-in for the config Pat seeds on first launch. */
function patDefaults(overrides: PatConfig = {}): PatConfig {
  return {
    mycall: "",
    secure_login_password: "",
    auxiliary_addresses: [],
    locator: "",
    auto_download_size_limit: -1,
    service_codes: ["PUBLIC"],
    http_addr: "localhost:8080",
    connect_aliases: { telnet: "telnet://{mycall}:CMSTelnet@cms.winlink.org:8772/wl2k" },
    hamlib_rigs: {},
    version_reporting_disabled: false,
    ardop: { addr: "localhost:8515", arq_bandwidth: { Forced: false, Max: 500 } },
    ...overrides,
  };
}


/**
 * A PatIdentity with the fields a test does not care about already filled in.
 *
 * WL2GO owns several fields in Pat's config now; spelling them all out at
 * every call site buries the one the test is actually about.
 */
function identity(over: Partial<PatIdentity> = {}): PatIdentity {
  return {
    mycall: "W1AW",
    locator: "",
    ardopAddr: "127.0.0.1:8515",
    rigAddr: null,
    predictionEngine: "voacap-api",
    versionReportingDisabled: false,
    ...over,
  };
}

describe("mergePatConfig", () => {
  it("applies the callsign and locator", () => {
    const { config } = mergePatConfig(patDefaults(), identity({ mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false }));
    assert.equal(config["mycall"], "W1AW");
    assert.equal(config["locator"], "FN31pr");
  });

  it("preserves every field it does not own", () => {
    const current = patDefaults();
    const { config } = mergePatConfig(current, identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false }));

    // "ardop" and "prediction" are only PARTLY owned -- one key each -- so they
    // are checked separately below rather than skipped.
    const owned = new Set(["mycall", "locator", PASSWORD_FIELD, "ardop", "prediction"]);
    for (const key of Object.keys(current)) {
      if (owned.has(key)) continue;
      assert.deepEqual(config[key], current[key], `field "${key}" must round-trip untouched`);
    }
  });

  it("merges INTO the nested sections rather than replacing them", () => {
    // The failure this prevents is silent and expensive: assigning a fresh
    // { addr } object would drop arq_bandwidth, connect_requests,
    // beacon_interval and cwid_enabled -- so an operator's bandwidth choice
    // would vanish the first time WL2GO wrote the file. `rig` and `ptt_ctrl`
    // are NOT in that list any more: WL2GO owns them, because they are what
    // makes Pat able to tune and key the radio.
    const current = patDefaults({
      ardop: { addr: "localhost:8515", arq_bandwidth: { Forced: false, Max: 500 }, cwid_enabled: true },
      prediction: { engine: "", voacap: { executable: "voacapl" } },
    });
    const { config } = mergePatConfig(current, identity({ ardopAddr: "127.0.0.1:8515" }));

    const ardop = config["ardop"] as Record<string, unknown>;
    assert.equal(ardop["addr"], "127.0.0.1:8515");
    assert.deepEqual(ardop["arq_bandwidth"], { Forced: false, Max: 500 });
    assert.equal(ardop["cwid_enabled"], true);

    const prediction = config["prediction"] as Record<string, unknown>;
    assert.equal(prediction["engine"], "voacap-api");
    assert.deepEqual(prediction["voacap"], { executable: "voacapl" });
  });

  it("creates the nested sections when Pat has not written them yet", () => {
    const { config } = mergePatConfig({ mycall: "" }, identity({ ardopAddr: "127.0.0.1:8515" }));
    assert.deepEqual(config["ardop"], { addr: "127.0.0.1:8515", rig: "", ptt_ctrl: false });
    assert.deepEqual(config["prediction"], { engine: "voacap-api" });
  });

  it("owns the prediction engine, because auto would mean no predictions at all", () => {
    // Pat's default "auto" tries a LOCAL voacap and, on failing to find one,
    // leaves its predictor nil (app/app.go:240-251) -- it does NOT fall back to
    // the web service. Nothing is bundled, so without this every station in the
    // browser comes back with no link quality.
    const { config, changed } = mergePatConfig(patDefaults({ prediction: { engine: "" } }), identity());
    assert.equal((config["prediction"] as Record<string, unknown>)["engine"], "voacap-api");
    assert.equal(changed, true);
  });

  it("notices a modem address that no longer matches", () => {
    // Pat reads config.Ardop.Addr only when it opens the TNC
    // (app/connect.go:285), so a difference here is what makes the identity
    // sync restart Pat -- without it the new address is written and ignored.
    const { changed } = mergePatConfig(
      patDefaults({ ardop: { addr: "localhost:8515" } }),
      identity({ ardopAddr: "127.0.0.1:8600" }),
    );
    assert.equal(changed, true);
  });

  it("writes the Winlink sharing preference", () => {
    // A fourth owned field: it gates Pat's startup calls to api.winlink.org,
    // one of which transmits the operator's password.
    const on = mergePatConfig(patDefaults(), identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false }));
    assert.equal(on.config["version_reporting_disabled"], false);

    const off = mergePatConfig(patDefaults(), identity({ mycall: "W1AW", locator: "", versionReportingDisabled: true }));
    assert.equal(off.config["version_reporting_disabled"], true);
    assert.equal(off.changed, true);
  });

  it("treats a config missing the sharing field as needing a write", () => {
    // An older config has no such key; leaving it absent would let Pat fall back
    // to its own default rather than the operator's choice.
    const { changed } = mergePatConfig(
      { mycall: "W1AW", locator: "", secure_login_password: "" },
      identity({ mycall: "W1AW", locator: "", versionReportingDisabled: true }),
    );
    assert.equal(changed, true);
  });

  it("does not take ownership of http_addr", () => {
    // The loopback guarantee lives in Pat's --addr flag, which wins over config.
    // Writing it here would reopen a question the security sprint closed.
    const { config } = mergePatConfig(patDefaults(), identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false }));
    assert.equal(config["http_addr"], "localhost:8080");
  });

  it("always writes an empty password, even when the input has none", () => {
    const { config } = mergePatConfig(patDefaults(), identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false }));
    assert.equal(config[PASSWORD_FIELD], "");
  });

  it("scrubs a password left behind by an older build or a hand-edit", () => {
    // The credential must exist on disk only inside the Keychain. Anything
    // found here is removed rather than preserved.
    const { config, changed } = mergePatConfig(
      patDefaults({ mycall: "W1AW", [PASSWORD_FIELD]: "hunter2" }),
      identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false }),
    );
    assert.equal(config[PASSWORD_FIELD], "");
    assert.equal(changed, true, "scrubbing a password is a change worth writing");
  });

  it("reports no change when the file already matches", () => {
    // Every owned field spelled out, because patDefaults() is deliberately what
    // PAT writes by default -- localhost:8515 and no prediction engine -- not
    // what WL2GO owns. The first launch after an upgrade does rewrite those two
    // and does bounce Pat once; this is the launch after that.
    const current = patDefaults({
      mycall: "W1AW",
      locator: "FN31pr",
      versionReportingDisabled: false,
      // rig and ptt_ctrl included: WL2GO owns both, so a file missing them is
      // out of date and SHOULD be rewritten.
      ardop: { addr: "127.0.0.1:8515", rig: "", ptt_ctrl: false },
      prediction: { engine: "voacap-api" },
    });
    const { changed } = mergePatConfig(current, identity({ mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false }));
    assert.equal(changed, false, "an ordinary launch must not rewrite or restart anything");
  });

  it("reports a change when only the locator differs", () => {
    const current = patDefaults({ mycall: "W1AW", locator: "FN31", versionReportingDisabled: false });
    assert.equal(mergePatConfig(current, identity({ mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false })).changed, true);
  });

  it("does not mutate the config it was given", () => {
    const current = patDefaults();
    mergePatConfig(current, identity({ mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false }));
    assert.equal(current["mycall"], "");
  });

  it("handles an empty callsign, which is the pre-onboarding state", () => {
    // An empty callsign is not a change to make, so on a config that already
    // carries the owned values nothing needs writing.
    const current = patDefaults({
      ardop: { addr: "127.0.0.1:8515", rig: "", ptt_ctrl: false },
      prediction: { engine: "voacap-api" },
    });
    const { config, changed } = mergePatConfig(current, identity({ mycall: "", locator: "", versionReportingDisabled: false }));
    assert.equal(config["mycall"], "");
    assert.equal(changed, false);
  });
});

describe("mergePatConfig / rig control", () => {
  const RIG_ADDR = "127.0.0.1:4532";

  it("writes the rig, the reference to it, and the PTT flag as one set", () => {
    // All three only mean anything together: the definition, ardop.rig naming
    // it, and ptt_ctrl making Pat act on ardopcf's PTT notifications
    // (app/connect.go:310-320). Any one of them alone does nothing.
    const { config } = mergePatConfig(patDefaults(), identity({ rigAddr: RIG_ADDR }));
    assert.deepEqual((config["hamlib_rigs"] as Record<string, unknown>)["wl2go"], {
      network: "tcp",
      address: RIG_ADDR,
    });
    const ardop = config["ardop"] as Record<string, unknown>;
    assert.equal(ardop["rig"], "wl2go");
    assert.equal(ardop["ptt_ctrl"], true);
  });

  it("CLEARS all three when the profile has no rig", () => {
    // A leftover ardop.rig naming a definition that is gone is not inert: Pat
    // hard-errors "unable to set PTT rig ... Not defined or not loaded" on
    // every ARDOP connect (app/connect.go:315), so an un-cleared field stops
    // sessions that would otherwise work.
    const current = patDefaults({
      hamlib_rigs: { wl2go: { network: "tcp", address: RIG_ADDR } },
      ardop: { addr: "127.0.0.1:8515", rig: "wl2go", ptt_ctrl: true },
    });
    const { config } = mergePatConfig(current, identity({ rigAddr: null }));
    assert.deepEqual(config["hamlib_rigs"], {});
    const ardop = config["ardop"] as Record<string, unknown>;
    assert.equal(ardop["rig"], "");
    assert.equal(ardop["ptt_ctrl"], false);
  });

  it("leaves a rig the operator defined themselves alone", () => {
    // Same rule as every other field WL2GO does not own: only our own entry is
    // ours to replace or remove.
    const current = patDefaults({ hamlib_rigs: { mine: { network: "tcp", address: "127.0.0.1:4599" } } });
    const { config } = mergePatConfig(current, identity({ rigAddr: RIG_ADDR }));
    const rigs = config["hamlib_rigs"] as Record<string, unknown>;
    assert.deepEqual(rigs["mine"], { network: "tcp", address: "127.0.0.1:4599" });
    assert.ok(rigs["wl2go"]);
  });

  it("notices a rig address that no longer matches, so Pat is restarted", () => {
    // Pat opens its rigs once at startup (app/app.go:455-500), so a changed
    // address that did not restart Pat would be written and never applied.
    const current = patDefaults({
      hamlib_rigs: { wl2go: { network: "tcp", address: RIG_ADDR } },
      ardop: { addr: "127.0.0.1:8515", rig: "wl2go", ptt_ctrl: true },
      prediction: { engine: "voacap-api" },
      mycall: "W1AW",
      locator: "FN31pr",
    });
    const base = { mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false };
    assert.equal(mergePatConfig(current, identity({ ...base, rigAddr: RIG_ADDR })).changed, false);
    assert.equal(mergePatConfig(current, identity({ ...base, rigAddr: "127.0.0.1:4533" })).changed, true);
  });
});

describe("readPatConfig", () => {
  it("returns null when Pat has not created its config yet", () => {
    assert.equal(readPatConfig(file), null);
  });

  it("returns null for a corrupt file rather than throwing", () => {
    // An operator with a broken Pat config still needs to reach Settings.
    writeFileSync(file, "{ not json");
    assert.equal(readPatConfig(file), null);
  });

  it("returns null for JSON that is not an object", () => {
    writeFileSync(file, '"a string"');
    assert.equal(readPatConfig(file), null);
  });

  it("round-trips a config it wrote", () => {
    writePatConfig(file, patDefaults({ mycall: "W1AW" }));
    assert.equal(readPatConfig(file)?.["mycall"], "W1AW");
  });
});

describe("writePatConfig", () => {
  it("writes owner-only, matching the mode Pat itself uses", () => {
    writePatConfig(file, patDefaults());
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("writes valid JSON Pat can parse back", () => {
    writePatConfig(file, patDefaults({ mycall: "W1AW" }));
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.mycall, "W1AW");
  });
});

describe("applyPatIdentity", () => {
  it("reports 'missing' when Pat has not seeded a config yet", () => {
    // Must be distinguishable from "unchanged": the identity did NOT reach Pat,
    // so a caller that treats both as "nothing to do" strands the mismatch.
    assert.equal(applyPatIdentity(file, identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false })), "missing");
  });

  it("writes the identity and reports that it changed", () => {
    writePatConfig(file, patDefaults());
    assert.equal(applyPatIdentity(file, identity({ mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false })), "written");

    const written = readPatConfig(file);
    assert.equal(written?.["mycall"], "W1AW");
    assert.equal(written?.["locator"], "FN31pr");
  });

  it("leaves the file untouched when nothing differs", () => {
    writePatConfig(
      file,
      patDefaults({
        mycall: "W1AW",
        locator: "FN31pr",
        versionReportingDisabled: false,
        ardop: { addr: "127.0.0.1:8515", rig: "", ptt_ctrl: false },
        prediction: { engine: "voacap-api" },
      }),
    );
    const before = readFileSync(file, "utf8");

    assert.equal(applyPatIdentity(file, identity({ mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false })), "unchanged");
    assert.equal(readFileSync(file, "utf8"), before);
  });

  it("never leaves a password on disk", () => {
    writePatConfig(file, patDefaults({ mycall: "W1AW", [PASSWORD_FIELD]: "hunter2" }));
    applyPatIdentity(file, identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false }));

    assert.equal(readFileSync(file, "utf8").includes("hunter2"), false);
  });
});
