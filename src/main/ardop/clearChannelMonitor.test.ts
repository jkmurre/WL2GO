import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClearChannelMonitor, type ChannelCheckUpdate } from "./clearChannelMonitor.ts";

/**
 * A hand-cranked clock: the monitor only ever has one timer outstanding (the
 * next one-second tick), so advancing time is running that callback.
 */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimeoutFn: (fn: () => void, _ms: number) => {
      const id = nextId++;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => {
      pending.delete(timer as unknown as number);
    },
    tick(seconds = 1): void {
      for (let i = 0; i < seconds; i++) {
        const [entry] = pending;
        if (!entry) return;
        pending.delete(entry[0]);
        entry[1]();
      }
    },
    pendingCount: () => pending.size,
  };
}

function build(clearWindowMs = 10_000) {
  const timers = fakeTimers();
  const updates: ChannelCheckUpdate[] = [];
  const monitor = new ClearChannelMonitor({
    clearWindowMs,
    onUpdate: (u) => updates.push(u),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { timers, updates, monitor };
}

/** Whether the promise has settled yet, without waiting on it. */
async function settledValue<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([promise, Promise.resolve("pending" as const)]);
}

describe("ClearChannelMonitor", () => {
  it("resolves clear after the full window with no busy signal", async () => {
    const { timers, updates, monitor } = build();
    const verdict = monitor.wait();

    assert.deepEqual(updates[0], { phase: "monitoring", secondsRemaining: 10, promptOperator: false });
    timers.tick(9);
    assert.equal(await settledValue(verdict), "pending");
    timers.tick(1);
    assert.equal(await verdict, "clear");
    // The countdown the operator watched: 10 down to 1, then the verdict.
    const seconds = updates.filter((u) => u.phase === "monitoring").map((u) => u.secondsRemaining);
    assert.deepEqual(seconds, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("holds on busy, prompting exactly once, and restarts a FULL window on clear", async () => {
    const { timers, updates, monitor } = build();
    const verdict = monitor.wait();

    timers.tick(6); // 4 seconds remain
    monitor.handleBusy(true);
    assert.deepEqual(updates.at(-1), { phase: "holding", secondsRemaining: null, promptOperator: true });
    assert.equal(timers.pendingCount(), 0, "holding runs no timer");

    monitor.handleBusy(false);
    // Fresh window: the 4 remaining seconds are gone, this is 10 again.
    assert.deepEqual(updates.at(-1), { phase: "monitoring", secondsRemaining: 10, promptOperator: false });

    // A second hold does not re-prompt: the dialog fired once, the amber TX
    // dot carries the state from here on.
    monitor.handleBusy(true);
    assert.deepEqual(updates.at(-1), { phase: "holding", secondsRemaining: null, promptOperator: false });

    monitor.handleBusy(false);
    timers.tick(10);
    assert.equal(await verdict, "clear");
  });

  it("treats repeated same-level BUSY notifications as no-ops", async () => {
    const { timers, updates, monitor } = build();
    const verdict = monitor.wait();

    // Patch 0008 sends the current state on attach; BUSY FALSE while already
    // monitoring must not restart the window.
    timers.tick(3);
    const before = updates.length;
    monitor.handleBusy(false);
    assert.equal(updates.length, before);
    timers.tick(7);
    assert.equal(await verdict, "clear");
  });

  it("resolves force from either state and ignores everything after", async () => {
    const { timers, monitor } = build();
    const verdict = monitor.wait();
    monitor.handleBusy(true);
    monitor.decide("force");
    assert.equal(await verdict, "force");

    // Settled is settled: later inputs change nothing.
    monitor.handleBusy(false);
    monitor.decide("abort");
    timers.tick(20);
    assert.equal(await verdict, "force");
  });

  it("treats wait as a no-op and abort as final", async () => {
    const { monitor } = build();
    const verdict = monitor.wait();
    monitor.handleBusy(true);
    monitor.decide("wait");
    assert.equal(await settledValue(verdict), "pending");
    monitor.decide("abort");
    assert.equal(await verdict, "abort");
  });

  it("cancel resolves abort, for a host socket that dies mid-check", async () => {
    const { timers, monitor } = build();
    const verdict = monitor.wait();
    timers.tick(2);
    monitor.cancel();
    assert.equal(await verdict, "abort");
    assert.equal(timers.pendingCount(), 0, "no timer leaks past settlement");
  });

  it("wait() returns the same settled promise on every call", async () => {
    const { timers, monitor } = build();
    const first = monitor.wait();
    timers.tick(10);
    assert.equal(await first, "clear");
    assert.equal(await monitor.wait(), "clear");
  });
});
