import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DUMMY_RIG_MODEL,
  RIGCTLD_DEFAULT_PORT,
  RigctldProcessManager,
} from "./rigctldProcessManager.ts";

describe("RigctldProcessManager", () => {
  it("resolves rigctld from the vendored tree for this host", () => {
    const m = new RigctldProcessManager({ resourcesBinDir: "/r/bin" });
    assert.ok(m.binaryPath.includes("rigctld"));
    assert.ok(m.binaryPath.includes(process.platform));
    assert.ok(m.binaryPath.includes(process.arch));
  });

  it("defaults to Hamlib's own port and its hardware-free dummy backend", () => {
    const m = new RigctldProcessManager({ resourcesBinDir: "/r/bin" });
    assert.equal(RIGCTLD_DEFAULT_PORT, 4532);
    assert.equal(DUMMY_RIG_MODEL, 1);
    assert.equal(m.port, 4532);
    assert.deepEqual(m.buildArgs(), ["-m", "1", "-T", "127.0.0.1", "-t", "4532"]);
  });

  it("passes the radio's serial device and speed through when given", () => {
    const m = new RigctldProcessManager({
      resourcesBinDir: "/r/bin",
      model: 1035,
      port: 4599,
      device: "/dev/tty.usbserial-1420",
      baudRate: 38400,
    });
    assert.deepEqual(m.buildArgs(), [
      "-m",
      "1035",
      "-T",
      "127.0.0.1",
      "-t",
      "4599",
      "-r",
      "/dev/tty.usbserial-1420",
      "-s",
      "38400",
    ]);
  });

  it("omits the device flag entirely when no radio is configured", () => {
    const m = new RigctldProcessManager({ resourcesBinDir: "/r/bin" });
    assert.ok(!m.buildArgs().includes("-r"));
    assert.ok(!m.buildArgs().includes("-s"));
  });

  it("starts idle and is not running", () => {
    const m = new RigctldProcessManager({ resourcesBinDir: "/r/bin" });
    const state = m.getState();
    assert.equal(state.state, "idle");
    assert.equal(state.pid, null);
    assert.equal(m.isRunning(), false);
  });

  it("refuses to start a missing binary, naming the build command", async () => {
    const m = new RigctldProcessManager({ resourcesBinDir: "/r/bin" });
    await assert.rejects(m.start(500), /npm run build:rigctld/);
    assert.equal(m.getState().state, "failed");
  });

  it("stopping an unstarted manager is a no-op", async () => {
    const m = new RigctldProcessManager({ resourcesBinDir: "/r/bin" });
    await m.stop();
    assert.equal(m.getState().state, "stopped");
  });
});
