import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findOrphans, parseProcessList, reapOrphans } from "./orphanReaper.ts";

const BIN = "/Applications/WL2GO.app/Contents/Resources/bin";

// Verbatim shape of `ps -axo pid=,ppid=,command=` on macOS, including the
// leading padding ps uses for short pids.
const PS = `
 1158     1 ${BIN}/darwin/arm64/ardopcf --hostbind 127.0.0.1 -m -c /dev/cu.usbmodem21101:19200 -G 18602 18600 1 1
 1276     1 ${BIN}/darwin/arm64/rigctld -m 3094 -T 127.0.0.1 -t 4532 -r /dev/cu.usbmodem21103
 2001  1999 ${BIN}/darwin/arm64/ardopcf --hostbind 127.0.0.1 -m 8515 1 1
 3050     1 /opt/homebrew/bin/ardopcf 8515
 4100     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
`;

describe("parseProcessList", () => {
  it("keeps the command intact, spaces and all", () => {
    const entries = parseProcessList(PS);
    assert.equal(entries.length, 5);
    assert.equal(entries[0].pid, 1158);
    assert.equal(entries[0].ppid, 1);
    assert.match(entries[0].command, /ardopcf --hostbind 127\.0\.0\.1 -m -c/);
  });

  it("ignores anything that is not a process line", () => {
    assert.deepEqual(parseProcessList("PID PPID COMMAND\n\n  not a line\n"), []);
  });
});

describe("findOrphans", () => {
  it("takes only our own binaries that have been reparented to init", () => {
    const found = findOrphans(parseProcessList(PS), BIN).map((p) => p.pid);
    assert.deepEqual(found, [1158, 1276]);
  });

  it("spares a live sibling instance's children", () => {
    // pid 2001 is ours and in our directory, but its parent is a running
    // WL2GO. Killing it would take down another instance's session mid-air.
    const found = findOrphans(parseProcessList(PS), BIN).map((p) => p.pid);
    assert.equal(found.includes(2001), false);
  });

  it("spares a separately installed copy the operator may be using", () => {
    // /opt/homebrew/bin/ardopcf is orphaned by our test, but it is not ours.
    const found = findOrphans(parseProcessList(PS), BIN).map((p) => p.pid);
    assert.equal(found.includes(3050), false);
  });

  it("does not match a directory that merely starts with the same letters", () => {
    const entries = parseProcessList(` 10 1 ${BIN}-old/darwin/arm64/ardopcf 8515\n`);
    assert.deepEqual(findOrphans(entries, BIN), []);
  });

  it("never returns our own process", () => {
    const entries = parseProcessList(` 42 1 ${BIN}/darwin/arm64/ardopcf 8515\n`);
    assert.deepEqual(findOrphans(entries, BIN, 42), []);
  });
});

describe("reapOrphans", () => {
  function harness(alive: number[]) {
    const signals: Array<[number, string]> = [];
    const living = new Set(alive);
    return {
      signals,
      living,
      kill: (pid: number, signal: NodeJS.Signals) => {
        if (!living.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        signals.push([pid, String(signal)]);
        if (signal === "SIGKILL") living.delete(pid);
      },
    };
  }

  it("asks politely first, so the sound card and serial port are released", async () => {
    const h = harness([1158, 1276]);
    // Both exit on SIGTERM: drop them from the living set when they get it.
    const kill = (pid: number, signal: NodeJS.Signals) => {
      h.kill(pid, signal);
      if (signal === "SIGTERM") h.living.delete(pid);
    };
    const killed = await reapOrphans({
      resourcesBinDir: BIN,
      listProcesses: async () => PS,
      kill,
      wait: async () => {},
    });
    assert.deepEqual(killed, [1158, 1276]);
    assert.deepEqual(h.signals, [
      [1158, "SIGTERM"],
      [1276, "SIGTERM"],
    ]);
  });

  it("escalates to SIGKILL for anything still holding on", async () => {
    const h = harness([1158, 1276]);
    await reapOrphans({
      resourcesBinDir: BIN,
      listProcesses: async () => PS,
      kill: h.kill,
      wait: async () => {},
    });
    assert.deepEqual(h.signals.filter(([, s]) => s === "SIGKILL"), [
      [1158, "SIGKILL"],
      [1276, "SIGKILL"],
    ]);
  });

  it("starts the app anyway when the process list cannot be read", async () => {
    // A reaper that refuses to start is worse than the leak it prevents.
    const logs: string[] = [];
    const killed = await reapOrphans({
      resourcesBinDir: BIN,
      listProcesses: async () => {
        throw new Error("ps: not found");
      },
      onLog: (m) => logs.push(m),
      wait: async () => {},
    });
    assert.deepEqual(killed, []);
    assert.match(logs[0] ?? "", /Could not check for leftover subprocesses/);
  });

  it("says nothing and does nothing when the machine is clean", async () => {
    const logs: string[] = [];
    const killed = await reapOrphans({
      resourcesBinDir: BIN,
      listProcesses: async () => " 4100 1 /usr/bin/something-else\n",
      onLog: (m) => logs.push(m),
      wait: async () => {},
    });
    assert.deepEqual(killed, []);
    assert.deepEqual(logs, []);
  });

  it("names the binary in the log, not the whole command line", async () => {
    const logs: string[] = [];
    await reapOrphans({
      resourcesBinDir: BIN,
      listProcesses: async () => ` 1158 1 ${BIN}/darwin/arm64/ardopcf --hostbind 127.0.0.1 8515\n`,
      kill: () => {},
      onLog: (m) => logs.push(m),
      wait: async () => {},
    });
    assert.match(logs[0] ?? "", /leftover ardopcf \(pid 1158\)/);
  });
});
