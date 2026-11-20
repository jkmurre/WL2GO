import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PatIdentitySync, fingerprintIdentity, type DesiredIdentity } from "./patIdentitySync.ts";
import { writePatConfig } from "./patConfigFile.ts";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wl2go-identity-"));
  configPath = path.join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A base identity, so a test spells out only the field it is exercising.
 *
 * ardopAddr and predictionEngine are part of the fingerprint because Pat reads
 * both only at startup -- see fingerprintIdentity.
 */
function identity(over: Partial<DesiredIdentity> = {}): DesiredIdentity {
  return {
    mycall: "W1AW",
    locator: "FN31pr",
    ardopAddr: "127.0.0.1:8515",
    rigAddr: null,
    predictionEngine: "voacap-api",
    versionReportingDisabled: false,
    password: null,
    ...over,
  };
}

const W1AW: DesiredIdentity = identity();

function sync(onRestart?: () => Promise<void>) {
  let restarts = 0;
  const instance = new PatIdentitySync({
    patConfigPath: configPath,
    restart: async () => {
      restarts += 1;
      await onRestart?.();
    },
  });
  return { instance, restarts: () => restarts };
}

describe("fingerprintIdentity", () => {
  it("is stable for the same identity", () => {
    assert.equal(fingerprintIdentity(W1AW), fingerprintIdentity({ ...W1AW }));
  });

  it("changes with the callsign, the locator, and the password", () => {
    const base = fingerprintIdentity(W1AW);
    assert.notEqual(fingerprintIdentity({ ...W1AW, mycall: "K1ABC" }), base);
    assert.notEqual(fingerprintIdentity({ ...W1AW, locator: "FN42" }), base);
    assert.notEqual(fingerprintIdentity({ ...W1AW, password: "hunter2" }), base);
  });

  it("distinguishes no password from an empty one", () => {
    // "not configured" and "configured as empty" mean different things to Pat.
    assert.notEqual(
      fingerprintIdentity({ ...W1AW, password: null }),
      fingerprintIdentity({ ...W1AW, password: "" }),
    );
  });

  it("does not expose the password", () => {
    const printed = fingerprintIdentity({ ...W1AW, password: "hunter2" });
    assert.equal(printed.includes("hunter2"), false);
    assert.match(printed, /^[0-9a-f]{64}$/);
  });

  it("does not confuse a callsign/locator boundary shift", () => {
    // Naive concatenation would make ("AB","C") and ("A","BC") identical.
    assert.notEqual(
      fingerprintIdentity(identity({ mycall: "AB", locator: "C", versionReportingDisabled: false, password: null })),
      fingerprintIdentity(identity({ mycall: "A", locator: "BC", versionReportingDisabled: false, password: null })),
    );
  });
});

describe("PatIdentitySync", () => {
  it("does not restart when nothing has changed", async () => {
    // The common case: an ordinary launch must not bounce the subprocess.
    writePatConfig(configPath, { mycall: "W1AW", locator: "FN31pr", secure_login_password: "" });
    const { instance, restarts } = sync();
    instance.markApplied(W1AW);

    assert.equal(await instance.reconcile(W1AW), false);
    assert.equal(restarts(), 0);
  });

  it("restarts when the callsign changes", async () => {
    writePatConfig(configPath, { mycall: "W1AW", locator: "FN31pr", secure_login_password: "" });
    const { instance, restarts } = sync();
    instance.markApplied(W1AW);

    assert.equal(await instance.reconcile({ ...W1AW, mycall: "K1ABC" }), true);
    assert.equal(restarts(), 1);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mycall, "K1ABC");
  });

  it("restarts when only the password changes", async () => {
    // The password lives in Pat's environment, which is fixed at spawn -- so
    // this is exactly the case a config-file-only sync would miss.
    writePatConfig(configPath, { mycall: "W1AW", locator: "FN31pr", secure_login_password: "" });
    const { instance, restarts } = sync();
    instance.markApplied(W1AW);

    assert.equal(await instance.reconcile({ ...W1AW, password: "hunter2" }), true);
    assert.equal(restarts(), 1);
  });

  it("restarts when the password is cleared", async () => {
    writePatConfig(configPath, { mycall: "W1AW", locator: "FN31pr", secure_login_password: "" });
    const { instance, restarts } = sync();
    instance.markApplied({ ...W1AW, password: "hunter2" });

    assert.equal(await instance.reconcile(W1AW), true);
    assert.equal(restarts(), 1);
  });

  it("never writes the password into Pat's config file", async () => {
    writePatConfig(configPath, { mycall: "W1AW", locator: "FN31pr", secure_login_password: "" });
    const { instance } = sync();
    instance.markApplied(W1AW);
    await instance.reconcile({ ...W1AW, password: "hunter2" });

    assert.equal(readFileSync(configPath, "utf8").includes("hunter2"), false);
  });

  it("treats a second identical reconcile as a no-op", async () => {
    writePatConfig(configPath, { mycall: "", locator: "", secure_login_password: "" });
    const { instance, restarts } = sync();
    instance.markApplied(identity({ mycall: "", locator: "", versionReportingDisabled: false, password: null }));

    await instance.reconcile(W1AW);
    await instance.reconcile(W1AW);
    assert.equal(restarts(), 1, "the second call must not restart again");
  });

  it("does not record the identity as applied when the restart fails", async () => {
    writePatConfig(configPath, { mycall: "", locator: "", secure_login_password: "" });
    const instance = new PatIdentitySync({
      patConfigPath: configPath,
      restart: async () => {
        throw new Error("pat did not come back");
      },
    });
    instance.markApplied(identity({ mycall: "", locator: "", versionReportingDisabled: false, password: null }));

    await assert.rejects(instance.reconcile(W1AW), /did not come back/);
    // Still out of step, so a later attempt retries rather than assuming success.
    assert.equal(instance.needsApply(W1AW), true);
  });

  it("writes the config without a restart before the first spawn", () => {
    writePatConfig(configPath, { mycall: "", locator: "", secure_login_password: "" });
    const { instance, restarts } = sync();

    assert.equal(instance.writeConfigOnly(W1AW), "written");
    assert.equal(restarts(), 0);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mycall, "W1AW");
  });

  it("tolerates Pat never having created its config", () => {
    const { instance } = sync();
    assert.equal(instance.writeConfigOnly(W1AW), "missing", "must not throw on a first-ever launch");
  });

  it("does not restart, or claim success, when Pat has no config yet", async () => {
    // The launch where Pat seeds its own config: our pre-spawn write was a
    // no-op, so restarting would not apply anything and recording it as applied
    // would mean no later reconcile ever notices.
    const { instance, restarts } = sync();
    instance.markApplied(identity({ mycall: "", locator: "", versionReportingDisabled: false, password: null }));

    assert.equal(await instance.reconcile(W1AW), false);
    assert.equal(restarts(), 0);
    assert.equal(instance.needsApply(W1AW), true, "must stay out of step so it retries");
  });

  it("observes what Pat actually seeded rather than what was intended", async () => {
    // Pat wrote its own default with no callsign; our intent was W1AW.
    writePatConfig(configPath, { mycall: "", locator: "", secure_login_password: "" });
    const { instance, restarts } = sync();
    instance.observeApplied(null);

    assert.equal(await instance.reconcile(W1AW), true, "the difference must be seen and corrected");
    assert.equal(restarts(), 1);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mycall, "W1AW");
  });

  it("restarts Pat when the modem address changes", async () => {
    // Pat reads config.Ardop.Addr only when it opens the TNC
    // (app/connect.go:285) and /api/reload is deliberately unused here, so
    // writing a new address without restarting would leave Pat dialling the
    // old port -- silently, since the config file would look correct.
    writePatConfig(configPath, {
      mycall: "W1AW",
      locator: "FN31pr",
      secure_login_password: "",
      ardop: { addr: "127.0.0.1:8515" },
      prediction: { engine: "voacap-api" },
    });
    const { instance, restarts } = sync();
    instance.observeApplied(null);

    assert.equal(await instance.reconcile(identity({ ardopAddr: "127.0.0.1:8600" })), true);
    assert.equal(restarts(), 1);
  });

  it("restarts Pat when the prediction engine changes", async () => {
    writePatConfig(configPath, {
      mycall: "W1AW",
      locator: "FN31pr",
      secure_login_password: "",
      ardop: { addr: "127.0.0.1:8515" },
      prediction: { engine: "" },
    });
    const { instance, restarts } = sync();
    instance.observeApplied(null);

    assert.equal(await instance.reconcile(W1AW), true);
    assert.equal(restarts(), 1);
  });

  it("observes an existing callsign, so an unchanged launch stays quiet", async () => {
    // The config has to carry ALL the owned fields, not just the callsign:
    // observeApplied reads back what Pat is actually running with, and a
    // missing modem address or prediction engine is a real difference that
    // should restart Pat. That is the point of the fingerprint.
    writePatConfig(configPath, {
      mycall: "W1AW",
      locator: "FN31pr",
      secure_login_password: "",
      ardop: { addr: "127.0.0.1:8515" },
      prediction: { engine: "voacap-api" },
    });
    const { instance, restarts } = sync();
    instance.observeApplied(null);

    assert.equal(await instance.reconcile(W1AW), false);
    assert.equal(restarts(), 0);
  });
});

describe("PatIdentitySync: concurrent requests", () => {
  /** A restart that takes time and records overlap, like the real stop/start. */
  function slowRestart() {
    let active = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const restart = async () => {
      calls += 1;
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    };
    return { restart, calls: () => calls, maxConcurrent: () => maxConcurrent };
  }

  it("never runs two reconciles at once", async () => {
    // The bug this exists for: finishing onboarding saves the callsign and the
    // password as two mutations milliseconds apart. Un-serialised, the two
    // restarts interleave into stop/stop/start/start and a second Pat dies on
    // "listen tcp 127.0.0.1:17812: bind: address already in use".
    writePatConfig(configPath, { mycall: "", locator: "", secure_login_password: "" });
    const r = slowRestart();
    const instance = new PatIdentitySync({ patConfigPath: configPath, restart: r.restart, coalesceMs: 0 });
    instance.markApplied(identity({ mycall: "", locator: "", versionReportingDisabled: false, password: null }));

    let desired: DesiredIdentity = identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false, password: null });
    instance.requestReconcile(() => desired);
    desired = identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false, password: "hunter2" });
    instance.requestReconcile(() => desired);

    await instance.flush();
    assert.equal(r.maxConcurrent(), 1, "two restarts must never overlap");
  });

  it("coalesces a burst into a single restart", async () => {
    writePatConfig(configPath, { mycall: "", locator: "", secure_login_password: "" });
    const r = slowRestart();
    const instance = new PatIdentitySync({ patConfigPath: configPath, restart: r.restart, coalesceMs: 5 });
    instance.markApplied(identity({ mycall: "", locator: "", versionReportingDisabled: false, password: null }));

    // Both arrive inside the coalescing window, as onboarding's two saves do.
    const final: DesiredIdentity = identity({ mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false, password: "hunter2" });
    instance.requestReconcile(() => (identity({ mycall: "W1AW", locator: "FN31pr", versionReportingDisabled: false, password: null })));
    instance.requestReconcile(() => final);

    await instance.flush();
    assert.equal(r.calls(), 1, "one restart, not one per saved field");
    assert.equal(instance.needsApply(final), false, "and it applied the newest values");
  });

  it("uses the newest identity when a change lands mid-restart", async () => {
    writePatConfig(configPath, { mycall: "", locator: "", secure_login_password: "" });
    const r = slowRestart();
    const instance = new PatIdentitySync({ patConfigPath: configPath, restart: r.restart, coalesceMs: 0 });
    instance.markApplied(identity({ mycall: "", locator: "", versionReportingDisabled: false, password: null }));

    let desired: DesiredIdentity = identity({ mycall: "W1AW", locator: "", versionReportingDisabled: false, password: null });
    instance.requestReconcile(() => desired);
    await new Promise((r2) => setTimeout(r2, 2)); // let the first pass begin

    desired = identity({ mycall: "K1ABC", locator: "", versionReportingDisabled: false, password: null });
    instance.requestReconcile(() => desired);

    await instance.flush();
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mycall, "K1ABC");
    assert.equal(instance.needsApply(desired), false);
  });

  it("keeps going after a failed reconcile instead of wedging the queue", async () => {
    writePatConfig(configPath, { mycall: "", locator: "", secure_login_password: "" });
    let attempts = 0;
    const errors: string[] = [];
    const instance = new PatIdentitySync({
      patConfigPath: configPath,
      coalesceMs: 0,
      onError: (m) => errors.push(m),
      restart: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("pat did not come back");
      },
    });
    instance.markApplied(identity({ mycall: "", locator: "", versionReportingDisabled: false, password: null }));

    instance.requestReconcile(() => W1AW);
    await instance.flush();
    assert.equal(errors.length, 1, "the failure is reported, not swallowed silently");

    // A later request still runs, rather than the queue being stuck.
    instance.requestReconcile(() => W1AW);
    await instance.flush();
    assert.equal(attempts, 2);
    assert.equal(instance.needsApply(W1AW), false);
  });
});
