import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { overallStatus, runSystemCheck, type SystemCheckInput } from "./systemCheck.ts";
import type {
  AppConfigView,
  ArdopProcessState,
  RigctldProcessState,
  BinaryInfo,
  DiagnosticCheck,
  PatProcessState,
  PatStatus,
} from "../../shared/ipcContract.ts";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_BUSYDET_LEVEL,
  DEFAULT_DRIVE_LEVEL,
  defaultPtt,
} from "../../shared/configSchema.ts";

const EMPTY_CONFIG: AppConfigView = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  station: { callsign: "", gridSquare: "", shareWithWinlink: true },
  profiles: [],
  activeProfileId: null,
  diagnostics: { recordRxAudio: false },
  hasWinlinkPassword: false,
  profilesWithLanPassword: [],
  secureStorageAvailable: true,
  warnings: [],
};

/** The normal post-onboarding state: an operator who has completed setup. */
const CONFIGURED_CONFIG: AppConfigView = {
  ...EMPTY_CONFIG,
  station: { callsign: "W1AW", gridSquare: "FN31pr", shareWithWinlink: true },
};

function check(status: DiagnosticCheck["status"]): DiagnosticCheck {
  return { id: `id-${status}`, label: status, status, detail: "" };
}

const HEALTHY_BINARY: BinaryInfo = {
  path: "/app/resources/bin/darwin/arm64/pat",
  exists: true,
  format: "macho",
  arch: "arm64",
  sizeBytes: 21_000_000,
  matchesHost: true,
};

const PAT_STATUS: PatStatus = {
  active_listeners: [],
  connected: false,
  dialing: false,
  remote_addr: "",
  http_clients: [],
  config_hash: "abc123",
};

const HEALTHY_ARDOP_BINARY: BinaryInfo = {
  path: "/app/resources/bin/darwin/arm64/ardopcf",
  exists: true,
  format: "macho",
  arch: "arm64",
  sizeBytes: 604_000,
  matchesHost: true,
};

const ARDOP_IDLE: ArdopProcessState = {
  state: "idle",
  pid: null,
  binaryPath: HEALTHY_ARDOP_BINARY.path,
  binary: HEALTHY_ARDOP_BINARY,
  hostPort: 8515,
  lastError: null,
};

const HEALTHY_RIG_BINARY: BinaryInfo = {
  path: "/app/resources/bin/darwin/arm64/rigctld",
  exists: true,
  format: "macho",
  arch: "arm64",
  sizeBytes: 231_000,
  matchesHost: true,
};

const RIGCTLD_IDLE: RigctldProcessState = {
  state: "idle",
  pid: null,
  binaryPath: HEALTHY_RIG_BINARY.path,
  binary: HEALTHY_RIG_BINARY,
  port: 4532,
  model: 1,
  lastError: null,
};

const RUNNING_STATE: PatProcessState = {
  state: "running",
  pid: 4242,
  binaryPath: HEALTHY_BINARY.path,
  binary: HEALTHY_BINARY,
  httpPort: 17812,
  lastError: null,
};

function input(overrides: Partial<SystemCheckInput> = {}): SystemCheckInput {
  return {
    paths: {
      userData: tmpdir(),
      logs: tmpdir(),
      config: `${tmpdir()}/config.json`,
      secrets: `${tmpdir()}/secrets.json`,
      patConfig: `${tmpdir()}/pat-config.json`,
      patMailbox: tmpdir(),
      patPrehooks: tmpdir(),
      patLog: `${tmpdir()}/pat.log`,
      patEventLog: `${tmpdir()}/eventlog.json`,
      patForms: tmpdir(),
      mailboxDb: `${tmpdir()}/mailbox.db`,
      draftsDb: `${tmpdir()}/drafts.db`,
      foldersDb: `${tmpdir()}/folders.db`,
      winlinkNetwork: `${tmpdir()}/winlink-network.json`,
      resourcesBin: `${tmpdir()}/bin`,
    },
    patState: RUNNING_STATE,
    getPatStatus: async () => PAT_STATUS,
    ardopState: ARDOP_IDLE,
    modemInUse: false,
  runModemSelfTest: async () => {},
    rigctldState: RIGCTLD_IDLE,
    runRigctldSelfTest: async () => {},
    listAudioDevices: async () => [
      {
        direction: "capture" as const,
        index: 0,
        name: "Built-in Microphone",
        hostApi: "Core Audio",
        maxChannels: 1,
        isDefault: true,
        supports12k: true,
      },
      {
        direction: "playback" as const,
        index: 1,
        name: "Built-in Output",
        hostApi: "Core Audio",
        maxChannels: 2,
        isDefault: true,
        supports12k: true,
      },
    ],
    listSerialPorts: async () => [],
    microphoneAccess: "granted" as const,
    configView: CONFIGURED_CONFIG,
    patCallsign: "W1AW",
    eventStreamAttached: true,
    resourcesRoot: "/app/resources",
    isPackaged: false,
    appVersion: "0.0.1",
    logFile: tmpdir(),
    shutdownArmed: true,
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const found = checks.find((c) => c.id === id);
  assert.ok(found, `expected a check with id "${id}"`);
  return found;
}

describe("overallStatus", () => {
  it("lets the worst status win", () => {
    assert.equal(overallStatus([check("pass"), check("warn"), check("fail")]), "fail");
    assert.equal(overallStatus([check("pass"), check("warn"), check("pending")]), "warn");
    assert.equal(overallStatus([check("pass"), check("pending")]), "pending");
    assert.equal(overallStatus([check("pass"), check("pass")]), "pass");
  });

  it("treats an empty check list as passing", () => {
    assert.equal(overallStatus([]), "pass");
  });
});

describe("runSystemCheck", () => {

  it("does not fail the modem self-test while the modem is in a session", async () => {
    // start() refuses a second modem, so running the self-test mid-session
    // throws -- and reporting that as FAIL puts a red row on the health screen
    // for a modem that is healthy and busy. A permanent red for a normal state
    // is what teaches operators to ignore the health screen.
    let ran = false;
    const report = await runSystemCheck(
      input({
        modemInUse: true,
        runModemSelfTest: async () => {
          ran = true;
          throw new Error("ardopcf already started");
        },
      }),
    );

    const check = report.checks.find((c) => c.id === "ardopcf-selftest");
    assert.equal(check?.status, "pending");
    assert.match(String(check?.detail), /active session/i);
    assert.equal(ran, false, "the self-test must not even be attempted");
  });

  it("passes every check on a healthy system", async () => {
    const report = await runSystemCheck(input());
    assert.equal(report.overall, "pass");
    assert.deepEqual(report.patStatus, PAT_STATUS);
    assert.equal(
      report.checks.filter((c) => c.status !== "pass").length,
      0,
      JSON.stringify(report.checks.filter((c) => c.status !== "pass"), null, 2),
    );
  });

  it("fails, with a rebuild hint, when the binary is for another platform", async () => {
    const report = await runSystemCheck(
      input({
        patState: {
          state: "failed",
          pid: null,
          binaryPath: HEALTHY_BINARY.path,
          binary: { ...HEALTHY_BINARY, format: "elf", matchesHost: false },
          httpPort: 17812,
          lastError: "cannot run on darwin/arm64",
        },
      }),
    );

    const archCheck = byId(report.checks, "pat-binary-arch");
    assert.equal(archCheck.status, "fail");
    assert.match(archCheck.hint ?? "", /npm run build:pat/);
    assert.equal(report.overall, "fail");
  });

  it("tells the operator to build Pat when it is missing entirely", async () => {
    const report = await runSystemCheck(
      input({
        patState: {
          state: "failed",
          pid: null,
          binaryPath: HEALTHY_BINARY.path,
          binary: { ...HEALTHY_BINARY, exists: false, matchesHost: false },
          httpPort: 17812,
          lastError: "not found",
        },
      }),
    );

    assert.equal(byId(report.checks, "pat-binary-present").status, "fail");
    assert.match(byId(report.checks, "pat-binary-present").hint ?? "", /npm run build:pat/);
    // Architecture cannot be judged when there is no file to judge.
    assert.equal(byId(report.checks, "pat-binary-arch").status, "pending");
  });

  it("stays pending, not failed, while Pat is still starting", async () => {
    const report = await runSystemCheck(
      input({
        patState: {
          state: "starting",
          pid: 99,
          binaryPath: HEALTHY_BINARY.path,
          binary: HEALTHY_BINARY,
          httpPort: 17812,
          lastError: null,
        },
      }),
    );

    assert.equal(byId(report.checks, "pat-process").status, "pending");
    assert.equal(byId(report.checks, "pat-api").status, "pending");
    assert.equal(report.overall, "pending");
    assert.equal(report.patStatus, null);
  });

  it("reports an unreachable API even though the process is running", async () => {
    const report = await runSystemCheck(
      input({
        getPatStatus: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );

    const api = byId(report.checks, "pat-api");
    assert.equal(api.status, "fail");
    assert.match(api.detail, /ECONNREFUSED/);
  });

  it("fails when the shutdown handler is not armed", async () => {
    const report = await runSystemCheck(input({ shutdownArmed: false }));
    assert.equal(byId(report.checks, "clean-shutdown").status, "fail");
  });

  it("warns rather than fails when logging is unavailable", async () => {
    const report = await runSystemCheck(input({ logFile: null }));
    assert.equal(byId(report.checks, "logger").status, "warn");
    assert.equal(report.overall, "warn");
  });
});

describe("runSystemCheck: ARDOP modem", () => {
  it("passes when the modem is vendored and self-tests", async () => {
    const report = await runSystemCheck(input());
    assert.equal(byId(report.checks, "ardopcf-binary-present").status, "pass");
    assert.equal(byId(report.checks, "ardopcf-binary-arch").status, "pass");
    assert.equal(byId(report.checks, "ardopcf-selftest").status, "pass");
  });

  it("tells the operator to build the modem when it is missing", async () => {
    const report = await runSystemCheck(
      input({ ardopState: { ...ARDOP_IDLE, binary: { ...HEALTHY_ARDOP_BINARY, exists: false, matchesHost: false } } }),
    );
    assert.equal(byId(report.checks, "ardopcf-binary-present").status, "fail");
    assert.match(byId(report.checks, "ardopcf-binary-present").hint ?? "", /npm run build:ardopcf/);
    assert.equal(byId(report.checks, "ardopcf-binary-arch").status, "pending");
    // Nothing to run, so the self-test must not be attempted.
    assert.equal(byId(report.checks, "ardopcf-selftest").status, "pending");
  });

  it("fails on a wrong-architecture modem without trying to run it", async () => {
    let selfTestRan = false;
    const report = await runSystemCheck(
      input({
        ardopState: { ...ARDOP_IDLE, binary: { ...HEALTHY_ARDOP_BINARY, format: "elf", matchesHost: false } },
        runModemSelfTest: async () => {
          selfTestRan = true;
        },
      }),
    );
    assert.equal(byId(report.checks, "ardopcf-binary-arch").status, "fail");
    assert.equal(selfTestRan, false, "must not execute a binary built for another platform");
  });

  it("surfaces a self-test failure with the modem's own error", async () => {
    const report = await runSystemCheck(
      input({
        runModemSelfTest: async () => {
          throw new Error("ardopcf exited with code=1 before opening its host port");
        },
      }),
    );
    const check = byId(report.checks, "ardopcf-selftest");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /exited with code=1/);
    assert.equal(report.overall, "fail");
  });
});

describe("runSystemCheck: rig control and devices", () => {
  it("passes when rig control is vendored and self-tests", async () => {
    const report = await runSystemCheck(input());
    assert.equal(byId(report.checks, "rigctld-binary-present").status, "pass");
    assert.equal(byId(report.checks, "rigctld-binary-arch").status, "pass");
    assert.equal(byId(report.checks, "rigctld-selftest").status, "pass");
  });

  it("tells the operator to build rig control when it is missing", async () => {
    const report = await runSystemCheck(
      input({ rigctldState: { ...RIGCTLD_IDLE, binary: { ...HEALTHY_RIG_BINARY, exists: false, matchesHost: false } } }),
    );
    assert.equal(byId(report.checks, "rigctld-binary-present").status, "fail");
    assert.match(byId(report.checks, "rigctld-binary-present").hint ?? "", /npm run build:rigctld/);
    assert.equal(byId(report.checks, "rigctld-selftest").status, "pending");
  });

  it("does not execute a wrong-architecture rig control binary", async () => {
    let ran = false;
    const report = await runSystemCheck(
      input({
        rigctldState: { ...RIGCTLD_IDLE, binary: { ...HEALTHY_RIG_BINARY, format: "elf", matchesHost: false } },
        runRigctldSelfTest: async () => {
          ran = true;
        },
      }),
    );
    assert.equal(byId(report.checks, "rigctld-binary-arch").status, "fail");
    assert.equal(ran, false);
  });

  it("counts audio devices by direction", async () => {
    const report = await runSystemCheck(input());
    const check = byId(report.checks, "audio-devices");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /1 capture, 1 playback/);
  });

  it("warns when no audio device is present at all", async () => {
    const report = await runSystemCheck(input({ listAudioDevices: async () => [] }));
    assert.equal(byId(report.checks, "audio-devices").status, "warn");
  });

  it("passes serial enumeration with zero ports, since no radio may be attached", async () => {
    const report = await runSystemCheck(input());
    const check = byId(report.checks, "serial-ports");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /none connected/);
    assert.equal(report.overall, "pass");
  });

  it("does not treat an unrepaired config file as a fault on a fresh install", async () => {
    const report = await runSystemCheck(input({ configView: EMPTY_CONFIG, patCallsign: "" }));
    assert.equal(byId(report.checks, "config-file").status, "pass");
    assert.match(byId(report.checks, "config-file").detail, /No callsign set yet/);
    assert.equal(byId(report.checks, "secure-storage").status, "pass");
  });

  it("warns that setup is unfinished when no callsign is set", async () => {
    const report = await runSystemCheck(input({ configView: EMPTY_CONFIG, patCallsign: "" }));
    const check = byId(report.checks, "station-identity");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /complete setup/i);
  });

  it("passes when the engine is running as the configured callsign", async () => {
    const report = await runSystemCheck(input());
    const check = byId(report.checks, "station-identity");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /configured as W1AW/);
  });

  it("warns when the engine is running under a different callsign than configured", async () => {
    // Means the derived config was written but the restart did not take.
    const report = await runSystemCheck(input({ patCallsign: "K1ABC" }));
    const check = byId(report.checks, "station-identity");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /Set to W1AW.*has K1ABC/);
    assert.match(check.hint ?? "", /Re-save your callsign/);
  });

  it("summarises a configured station", async () => {
    const report = await runSystemCheck(
      input({
        configView: {
          ...EMPTY_CONFIG,
          station: { callsign: "W1AW", gridSquare: "FN31pr", shareWithWinlink: true },
          profiles: [
            {
              id: "p1",
              name: "IC-7300",
              mode: "ardop",
              ardop: { hostPort: 8515 },
              hamlib: null,
              txMode: "auto",
              ptt: defaultPtt(),
              driveLevel: DEFAULT_DRIVE_LEVEL,
              busyDetLevel: DEFAULT_BUSYDET_LEVEL,
              interface: { type: "usb", usb: { serialPort: null, audioInput: null, audioOutput: null } },
            },
          ],
          activeProfileId: "p1",
          hasWinlinkPassword: true,
        },
        patCallsign: "W1AW",
    eventStreamAttached: true,
      }),
    );
    const check = byId(report.checks, "config-file");
    assert.match(check.detail, /W1AW/);
    assert.match(check.detail, /1 radio profile\b/);
    assert.match(byId(report.checks, "secure-storage").detail, /a Winlink password is stored/);
  });

  it("warns, without failing, when the config file had to be repaired", async () => {
    const report = await runSystemCheck(
      input({ configView: { ...EMPTY_CONFIG, warnings: ["Radio profile 2 was unreadable and has been dropped."] } }),
    );
    const check = byId(report.checks, "config-file");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /unreadable/);
    assert.equal(report.overall, "warn");
  });

  it("warns when the system has no secure credential storage", async () => {
    const report = await runSystemCheck(input({ configView: { ...EMPTY_CONFIG, secureStorageAvailable: false } }));
    const check = byId(report.checks, "secure-storage");
    assert.equal(check.status, "warn");
    assert.match(check.hint ?? "", /no keyring/);
  });

  it("fails serial enumeration when the native binding cannot load", async () => {
    const report = await runSystemCheck(
      input({
        listSerialPorts: async () => {
          throw new Error("Cannot find module bindings.node");
        },
      }),
    );
    assert.equal(byId(report.checks, "serial-ports").status, "fail");
    assert.equal(report.overall, "fail");
  });
});

describe("runSystemCheck: self-containment and presentation", () => {
  it("reports the app as self-contained when every binary is inside the bundle", async () => {
    const report = await runSystemCheck(input({ isPackaged: true }));
    const check = byId(report.checks, "components-bundled");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /^Yes/);
  });

  it("fails when a spawned binary is loaded from outside the packaged app", async () => {
    // The whole point of the check: a build that reaches outside itself must
    // not be shippable, and must say so rather than looking healthy.
    const report = await runSystemCheck(
      input({
        isPackaged: true,
        patState: { ...RUNNING_STATE, binaryPath: "/opt/homebrew/bin/pat" },
      }),
    );
    const check = byId(report.checks, "components-bundled");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /1 component loaded from outside/);
    assert.match(check.hint ?? "", /not self-contained/);
    assert.equal(report.overall, "fail");
  });

  it("does not judge self-containment in a development build", async () => {
    const report = await runSystemCheck(
      input({ isPackaged: false, patState: { ...RUNNING_STATE, binaryPath: "/repo/resources/bin/pat" } }),
    );
    const check = byId(report.checks, "components-bundled");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /Development build/);
  });

  it("rejects a sibling directory that merely shares a prefix", async () => {
    const report = await runSystemCheck(
      input({
        isPackaged: true,
        resourcesRoot: "/app/resources",
        patState: { ...RUNNING_STATE, binaryPath: "/app/resources-evil/pat" },
      }),
    );
    assert.equal(byId(report.checks, "components-bundled").status, "fail");
  });

  it("prints no filesystem path on a healthy system", async () => {
    // A health screen states what was checked and whether it passed. Printing
    // absolute paths made a self-contained app look like it reached outside
    // itself, which is the opposite of reassurance.
    //
    // Scoped to passing checks on purpose: a FAILING check may legitimately
    // name a path, because "failed to spawn X at <path>" is what someone needs
    // when reporting the problem. The rule is that a healthy app shows none.
    const report = await runSystemCheck(input({ isPackaged: true }));
    assert.equal(report.overall, "pass", "fixture must be healthy for this test to mean anything");

    for (const check of report.checks) {
      for (const text of [check.detail, check.hint ?? ""]) {
        assert.doesNotMatch(text, /(^|\s)\/[A-Za-z]/, `check "${check.id}" leaks a path: ${text}`);
      }
    }
  });
});

describe("runSystemCheck: Winlink session events", () => {
  it("passes when the event stream is attached", async () => {
    const report = await runSystemCheck(input());
    assert.equal(byId(report.checks, "pat-events").status, "pass");
  });

  it("warns when Pat is running but nothing is listening for prompts", async () => {
    // This is the state where pressing Connect would hang for two minutes.
    const report = await runSystemCheck(input({ eventStreamAttached: false }));
    const check = byId(report.checks, "pat-events");
    assert.equal(check.status, "warn");
    assert.match(check.hint ?? "", /time out/);
  });

  it("stays pending, not failed, while Pat is still starting", async () => {
    const report = await runSystemCheck(
      input({
        eventStreamAttached: false,
        patState: {
          state: "starting",
          pid: 1,
          binaryPath: HEALTHY_BINARY.path,
          binary: HEALTHY_BINARY,
          httpPort: 17812,
          lastError: null,
        },
      }),
    );
    assert.equal(byId(report.checks, "pat-events").status, "pending");
  });
});
