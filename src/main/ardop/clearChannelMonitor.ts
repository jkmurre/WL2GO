// The 10-second clear-channel window that runs before every RF dial.
//
// Driven entirely by the modem's BUSY TRUE/FALSE notifications -- ardopcf's
// busy detector is the thing that can tell a signal from static, and it only
// runs while the modem is in DISC, which is exactly the pre-dial state this
// monitor exists for. Vendor patch 0008 makes the modem report the CURRENT
// state to a freshly attached host, so a channel that is already busy when the
// listener connects is seen too, not only one that becomes busy afterwards.
//
// Pure logic with injectable timers, so it runs under node --test with no
// Electron and no real clock.

import type { ChannelHoldDecision } from "../../shared/ipcContract.ts";

/** How the check ended: dial, dial anyway, or don't. */
export type ChannelVerdict = "clear" | "force" | "abort";

export interface ChannelCheckUpdate {
  phase: "monitoring" | "holding";
  /** Whole seconds left in the clear window while monitoring; null on hold. */
  secondsRemaining: number | null;
  /** True exactly once, on the first transition to holding: show the dialog. */
  promptOperator: boolean;
}

export interface ClearChannelMonitorOptions {
  /** The clear window. Defaults to 10 seconds, per the operating requirement. */
  clearWindowMs?: number;
  onUpdate?: (update: ChannelCheckUpdate) => void;
  /** Injectable for tests; default to the real timers. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_CLEAR_WINDOW_MS = 10_000;

/**
 * Two states and one promise.
 *
 * `monitoring` counts down the clear window a second at a time; reaching zero
 * resolves "clear". A BUSY TRUE moves to `holding`, which has no timer at all:
 * it waits for BUSY FALSE (a fresh, FULL window -- that is what "consecutive"
 * means) or for the operator. The hold dialog is requested only on the FIRST
 * hold: a marginal signal fluttering in and out must not re-prompt on every
 * flutter, so after "wait" the amber TX dot and the status line carry the
 * state and the Stop button remains the way out.
 */
export class ClearChannelMonitor {
  private readonly clearWindowMs: number;
  private readonly onUpdate: ((update: ChannelCheckUpdate) => void) | undefined;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => void;

  private phase: "monitoring" | "holding" = "monitoring";
  private secondsRemaining = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private prompted = false;
  private started = false;
  private settled = false;
  private resolveVerdict: ((verdict: ChannelVerdict) => void) | null = null;
  private readonly verdict: Promise<ChannelVerdict>;

  constructor(options: ClearChannelMonitorOptions = {}) {
    this.clearWindowMs = options.clearWindowMs ?? DEFAULT_CLEAR_WINDOW_MS;
    this.onUpdate = options.onUpdate;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
    this.verdict = new Promise<ChannelVerdict>((resolve) => {
      this.resolveVerdict = resolve;
    });
  }

  /** Resolves exactly once with the verdict. Starts the clock on first call. */
  wait(): Promise<ChannelVerdict> {
    if (!this.started && !this.settled) {
      this.started = true;
      this.beginWindow();
    }
    return this.verdict;
  }

  /**
   * Feed one BUSY notification. Level-idempotent: TRUE while already holding
   * and FALSE while already monitoring change nothing -- the initial BUSY
   * FALSE that patch 0008 sends on attach must NOT restart a running window.
   */
  handleBusy(busy: boolean): void {
    if (this.settled) return;
    if (busy && this.phase === "monitoring") {
      this.stopTimer();
      this.phase = "holding";
      const firstHold = !this.prompted;
      this.prompted = true;
      this.onUpdate?.({ phase: "holding", secondsRemaining: null, promptOperator: firstHold });
    } else if (!busy && this.phase === "holding") {
      this.phase = "monitoring";
      if (this.started) this.beginWindow();
    }
  }

  /**
   * The operator's answer from the hold dialog (or Stop routed as "abort").
   * "wait" is deliberately a no-op: waiting is already what the machine does.
   */
  decide(decision: ChannelHoldDecision): void {
    if (decision === "force") this.settle("force");
    else if (decision === "abort") this.settle("abort");
  }

  /** External failure -- the host socket died, the session is being torn down. */
  cancel(): void {
    this.settle("abort");
  }

  /** A fresh, full window. Called on start and on every hold-to-clear return. */
  private beginWindow(): void {
    this.stopTimer();
    this.secondsRemaining = Math.max(1, Math.ceil(this.clearWindowMs / 1000));
    this.onUpdate?.({ phase: "monitoring", secondsRemaining: this.secondsRemaining, promptOperator: false });
    this.scheduleTick();
  }

  private scheduleTick(): void {
    // One tick per remaining "second". A sub-second window (tests) shrinks the
    // tick with it, so the countdown still runs its full length.
    const tickMs = Math.min(1000, this.clearWindowMs);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.secondsRemaining -= 1;
      if (this.secondsRemaining <= 0) {
        this.settle("clear");
        return;
      }
      this.onUpdate?.({ phase: "monitoring", secondsRemaining: this.secondsRemaining, promptOperator: false });
      this.scheduleTick();
    }, tickMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  private settle(verdict: ChannelVerdict): void {
    if (this.settled) return;
    this.settled = true;
    this.stopTimer();
    this.resolveVerdict?.(verdict);
  }
}
