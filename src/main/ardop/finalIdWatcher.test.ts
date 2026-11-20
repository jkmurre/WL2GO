import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FinalIdWatcher, type SignOffOutcome } from "./finalIdWatcher.ts";

/**
 * A hand-cranked clock that honours each timer's delay: the watcher keeps a
 * grace timer AND the overall cap outstanding at once, and which fires first
 * is the whole behaviour under test.
 */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { due: number; fn: () => void }>();
  return {
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { due: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => {
      pending.delete(timer as unknown as number);
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let soonest: [number, { due: number; fn: () => void }] | null = null;
        for (const entry of pending) {
          if (entry[1].due <= target && (!soonest || entry[1].due < soonest[1].due)) soonest = entry;
        }
        if (!soonest) break;
        now = soonest[1].due;
        pending.delete(soonest[0]);
        soonest[1].fn();
      }
      now = target;
    },
  };
}

function build() {
  const timers = fakeTimers();
  const watcher = new FinalIdWatcher({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { timers, watcher };
}

/** Whether the promise has settled yet, without waiting on it. */
async function settledValue(promise: Promise<SignOffOutcome>): Promise<SignOffOutcome | "pending"> {
  return Promise.race([promise, Promise.resolve("pending" as const)]);
}

describe("FinalIdWatcher", () => {
  it("resolves no-transmit immediately for a session that never keyed", async () => {
    const { watcher } = build();
    assert.equal(await watcher.wait(), "no-transmit");
  });

  it("resolves aborted immediately once Stop was pressed", async () => {
    const { watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteTransmit(false);
    watcher.markAborted();
    assert.equal(await watcher.wait(), "aborted");
  });

  it("aborts a wait already in progress without any delay", async () => {
    const { watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteTransmit(false);
    const wait = watcher.wait();
    assert.equal(await settledValue(wait), "pending");
    watcher.markAborted();
    assert.equal(await wait, "aborted");
  });

  it("waits out the deferred ID: quiet gap, then IDFrame, then CW, then done", async () => {
    // The failing branch from the logs: DISCONNECTED reaches Pat ~2.7 s
    // before tmrFinalID fires, so the wait starts with the channel quiet and
    // the ID still to come -- and the ID is TWO keyings, because SendID()
    // finishes the IDFrame before sendCWID() keys PTT again.
    const { timers, watcher } = build();
    watcher.noteTransmit(true); // the session's END frame
    watcher.noteTransmit(false);
    const wait = watcher.wait();

    timers.advance(3_000); // inside the 6 s quiet grace: still waiting
    assert.equal(await settledValue(wait), "pending");

    watcher.noteIdStart(); // "SendID ..."
    watcher.noteTransmit(true); // IDFrame keys up
    timers.advance(2_000);
    watcher.noteTransmit(false); // IDFrame done -- NOT the end of the sign-off
    assert.equal(await settledValue(wait), "pending");

    watcher.noteIdStart(); // "Sending CW ID of ..." follows within ms
    watcher.noteTransmit(true);
    timers.advance(6_500); // the CW ID takes ~6.3 s on the air
    assert.equal(await settledValue(wait), "pending");
    watcher.noteTransmit(false);

    timers.advance(1_500); // the done grace confirms nothing else follows
    assert.equal(await wait, "id-complete");
  });

  it("does not mistake the IDFrame's PTT-FALSE for the end of the sign-off", async () => {
    const { timers, watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteTransmit(false);
    const wait = watcher.wait();
    watcher.noteIdStart();
    watcher.noteTransmit(true);
    watcher.noteTransmit(false);
    // Within the done grace the CW keying arrives; the grace must re-arm.
    timers.advance(1_000);
    watcher.noteTransmit(true);
    timers.advance(1_500);
    assert.equal(await settledValue(wait), "pending");
    watcher.noteTransmit(false);
    timers.advance(1_500);
    assert.equal(await wait, "id-complete");
  });

  it("resolves id-complete after only a grace when the ID went out inline", async () => {
    // The other close branch: SendID ran synchronously during frame
    // processing, so by the time the teardown asks, it is already over.
    const { timers, watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteIdStart();
    watcher.noteTransmit(false);
    const wait = watcher.wait();
    timers.advance(1_500);
    assert.equal(await wait, "id-complete");
  });

  it("resolves quiet when nothing announces an ID within the grace", async () => {
    const { timers, watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteTransmit(false);
    const wait = watcher.wait();
    timers.advance(5_999);
    assert.equal(await settledValue(wait), "pending");
    timers.advance(1);
    assert.equal(await wait, "quiet");
  });

  it("a key-up during the quiet grace re-arms it rather than resolving", async () => {
    const { timers, watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteTransmit(false);
    const wait = watcher.wait();
    timers.advance(5_000);
    watcher.noteTransmit(true); // something is still going out
    timers.advance(7_000); // well past the original grace
    assert.equal(await settledValue(wait), "pending");
    watcher.noteTransmit(false);
    timers.advance(6_000);
    assert.equal(await wait, "quiet");
  });

  it("gives up at the cap when the ID never finishes", async () => {
    const { timers, watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteTransmit(false);
    const wait = watcher.wait();
    watcher.noteIdStart();
    watcher.noteTransmit(true); // keyed and never released
    timers.advance(20_000);
    assert.equal(await wait, "timeout");
  });

  it("returns the same promise to a second caller", async () => {
    const { timers, watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteIdStart();
    watcher.noteTransmit(false);
    const first = watcher.wait();
    const second = watcher.wait();
    timers.advance(1_500);
    assert.equal(await first, "id-complete");
    assert.equal(await second, "id-complete");
  });

  it("reset settles a pending wait and clears the slate for the next session", async () => {
    const { timers, watcher } = build();
    watcher.noteTransmit(true);
    watcher.noteTransmit(false);
    const wait = watcher.wait();
    watcher.reset(); // the modem died under the wait
    assert.equal(await wait, "quiet");

    // The next session starts clean: no leaked PTT history, no settled wait.
    watcher.noteTransmit(true);
    watcher.noteIdStart();
    watcher.noteTransmit(false);
    const next = watcher.wait();
    timers.advance(1_500);
    assert.equal(await next, "id-complete");
  });
});
