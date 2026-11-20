import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RigControl, describeRigctldFailure } from "./rigControl.ts";
import type { RadioProfile } from "../../shared/configSchema.ts";

const RIG = { model: 3094, device: "/dev/cu.usbmodem21101", baud: 19200, port: 45401 };

function profile(over: Partial<RadioProfile> = {}): RadioProfile {
  return {
    id: "p1",
    name: "7300Mk2",
    mode: "ardop",
    ardop: { hostPort: 8515 },
    hamlib: RIG,
    txMode: "auto",
    ptt: { method: "rigctld", port: null, baud: 19200, keyHex: "", unkeyHex: "" },
    driveLevel: 100,
    busyDetLevel: 5,
    interface: { type: "usb", usb: { serialPort: null, audioInput: null, audioOutput: null } },
    ...over,
  };
}

/**
 * Pointed at a binary that does not exist, so start() always fails.
 *
 * That is the shape of every real startup failure too -- rigctld exits before
 * its port opens -- and it is the case the retry bound exists for.
 */
function control(over: Partial<ConstructorParameters<typeof RigControl>[0]> = {}) {
  const errors: string[] = [];
  const exits: number[] = [];
  const rig = new RigControl({
    resourcesBinDir: "/nonexistent/bin",
    onError: (message) => errors.push(message),
    onUnexpectedExit: () => exits.push(1),
    ...over,
  });
  return { rig, errors, exits };
}

describe("RigControl.sync", () => {
  it("does nothing, and reports nothing changed, for a profile with no rig", async () => {
    // "No rig" is also the starting state, so the first sync of a rig-less
    // profile is genuinely a no-op -- false means "nothing changed", which is
    // what tells the caller Pat does not need restarting.
    const { rig, errors } = control();
    assert.equal(await rig.sync(profile({ hamlib: null })), false);
    assert.equal(rig.isRunning(), false);
    assert.equal(rig.address(), null);
    assert.deepEqual(errors, []);
  });

  it("reports nothing changed when an unrelated setting is saved", async () => {
    // broadcastConfig fires this on EVERY config mutation. Doing work here
    // would drop the radio out from under a Pat that is working.
    const { rig } = control();
    await rig.sync(profile({ hamlib: null }));
    assert.equal(await rig.sync(profile({ hamlib: null, driveLevel: 60 })), false);
  });

  it("does NOT treat a failed startup as a crash to recover from", async () => {
    // The runaway loop. start() registers its exit handler before waiting for
    // the port, so a rigctld that dies immediately -- radio off, wrong CAT
    // port -- fires onExit while start() is still being awaited. Acting on that
    // respawns rigctld AND restarts Pat, roughly every ten seconds, for ever.
    const { rig, exits } = control();
    await rig.sync(profile());
    assert.deepEqual(exits, [], "a startup failure must not enter the crash-recovery path");
  });

  it("names the likely cause instead of reporting an exit code", async () => {
    const { rig, errors } = control();
    await rig.sync(profile());
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /not found|rebuild it/i);
  });

  it("gives up after repeated failures rather than restarting Pat for ever", async () => {
    // Each recovery attempt bounces the protocol engine too, so an unbounded
    // retry against a radio that is simply switched off is worse than stopping.
    const { rig, errors } = control();
    for (let attempt = 0; attempt < 6; attempt++) await rig.sync(profile());
    assert.ok(errors.length <= 3, `retried ${errors.length} times`);
    assert.match(errors[errors.length - 1] ?? "", /stopped retrying/);
  });

  it("tries again once the settings change, so fixing them is enough", async () => {
    const { rig, errors } = control();
    for (let attempt = 0; attempt < 4; attempt++) await rig.sync(profile());
    const exhausted = errors.length;
    await rig.sync(profile({ hamlib: { ...RIG, device: "/dev/cu.usbmodem21103" } }));
    assert.ok(errors.length > exhausted, "a corrected profile must be retried");
  });

  it("serialises concurrent calls, so a burst cannot leave a process unowned", async () => {
    // broadcastConfig fires this on every mutation and onboarding saves two
    // milliseconds apart -- the same burst PatIdentitySync coalesces for.
    const { rig } = control();
    await Promise.all([rig.sync(profile()), rig.sync(profile()), rig.sync(profile())]);
    assert.equal(rig.isRunning(), false);
  });
});

describe("RigControl.ensure", () => {
  it("does nothing for a profile with no rig", async () => {
    const { rig, errors } = control();
    assert.equal(await rig.ensure(profile({ hamlib: null })), false);
    assert.equal(rig.isRunning(), false);
    assert.deepEqual(errors, []);
  });

  it("tries the daemon again after sync() exhausted the failure bound", async () => {
    // The state the operator was trapped in: rigctld's restarts failed while
    // the radio was off, the bound stopped further attempts, and no config
    // change was coming. A connect attempt is the operator saying "try again",
    // so it carries the same licence a settings change does.
    const { rig, errors } = control();
    for (let attempt = 0; attempt < 4; attempt++) await rig.sync(profile());
    const exhausted = errors.length;
    await rig.ensure(profile());
    assert.ok(errors.length > exhausted, "a connect attempt must retry a rig that gave up");
  });

  it("reports a daemon start attempt, so the caller can bounce Pat", async () => {
    // true is the signal that Pat's once-at-startup rig connection is stale.
    // A start that FAILS still returns true -- the daemon Pat knew is gone
    // either way, and Pat restarting onto no rig matches reality.
    const { rig } = control();
    assert.equal(await rig.ensure(profile()), true);
  });

  it("serialises with sync(), like everything else on the queue", async () => {
    const { rig } = control();
    await Promise.all([rig.sync(profile()), rig.ensure(profile()), rig.sync(profile())]);
    assert.equal(rig.isRunning(), false);
  });
});

describe("describeRigctldFailure", () => {
  it("reads an immediate exit as the CAT port, which is what it almost always is", () => {
    const described = describeRigctldFailure(RIG, "rigctld exited with code=2 signal=null before opening its port");
    assert.match(described, /\/dev\/cu\.usbmodem21101 could not/);
    assert.doesNotMatch(described, /exited with code/);
  });

  it("names a port conflict and what to quit", () => {
    const described = describeRigctldFailure(RIG, "listen EADDRINUSE 127.0.0.1:45401");
    assert.match(described, /already in use/);
    assert.match(described, /WSJT-X|fldigi/);
  });

  it("passes a missing-binary message through, since it already names the fix", () => {
    const raw = "rigctld binary not found at /x/rigctld. Run: npm run build:rigctld";
    assert.equal(describeRigctldFailure(RIG, raw), raw);
  });
});
