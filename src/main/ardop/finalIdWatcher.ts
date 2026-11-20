// Holds the session teardown until the modem has sent the final station ID.
//
// The bug this exists for was deterministic: when the far station closes the
// link with a DISC frame, ardopcf does not send the final IDFrame + CW ID
// inline -- it arms tmrFinalID for three seconds later (ARQ.c, ARDOPC.c:1909)
// and reports DISCONNECTED to the host immediately. Pat's /api/connect then
// resolves, WL2GO's teardown SIGTERMed the modem ~2.7 s after the disconnect,
// and the mandatory ID lost the race by a third of a second, every time. The
// other close branch sends the ID synchronously inside frame processing and
// survived only because Pat happened to take seconds to return.
//
// So the teardown asks this watcher "is the sign-off done?" before stopping
// the modem. It is fed from the modem's console stream (modemActivity.ts):
// the "SendID"/"Sending CW ID of" lines and the PTT edges. It is deliberately
// signal-driven rather than branch-driven -- tmrFinalID is armed in six
// different places in ardopcf, and enumerating them would break on the next
// vendored-source bump. Whatever path the ID takes, it announces itself the
// same way: an ID log line, keying, and a final PTT-FALSE.
//
// One subtlety decides the shape of the "done" detection: SendID() transmits
// the IDFrame (Mod4FSKDataAndPlay returns only when it has been sent, PTT
// dropping at the end) and THEN calls sendCWID(), which keys PTT again. So a
// PTT-FALSE after an ID line is not proof the sign-off is over -- the CW
// keying follows within milliseconds. "Done" is therefore PTT low AND nothing
// new for a short grace, not the first falling edge.
//
// Pure logic with injectable timers, like clearChannelMonitor.ts, so it runs
// under node --test with no Electron and no real clock.

/** How the sign-off wait ended. Only "timeout" means an ID was likely lost. */
export type SignOffOutcome =
  /** The session never keyed the transmitter, so no ID is owed. */
  | "no-transmit"
  /** An ID went out and the transmitter is back off. The good ending. */
  | "id-complete"
  /** Transmitted, but no ID appeared within the grace: nothing was pending. */
  | "quiet"
  /** The cap expired with the ID still unseen or unfinished. */
  | "timeout"
  /** The operator pressed Stop. Stop means now; the wait must not delay it. */
  | "aborted";

export interface FinalIdWatcherOptions {
  /** How long after the last activity to wait for a deferred ID to start. */
  quietGraceMs?: number;
  /** After an ID's final PTT-FALSE, how long to confirm nothing follows. */
  doneGraceMs?: number;
  /** The absolute most a teardown may be held, whatever is still moving. */
  capMs?: number;
  /** Injectable for tests; default to the real timers. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * The deferred ID fires 3 s after the disconnect exchange and the teardown
 * asks within about the same 3 s, so six seconds of quiet is generous -- and a
 * genuinely idle modem costs the operator those seconds exactly once, at the
 * end of a session that owed an ID it never announced.
 */
const DEFAULT_QUIET_GRACE_MS = 6_000;
/** IDFrame-to-CW handoff is same-thread and takes milliseconds; 1.5 s is ample. */
const DEFAULT_DONE_GRACE_MS = 1_500;
/**
 * Measured budget for a real sign-off (DISCONNECTED to CW key-up finished) was
 * 8.3 s: 1.8 s of IDFrame and 6.3 s of 12 WPM CW. 20 s leaves room for a busy
 * channel deferring the ID a while without holding a stuck teardown for ever.
 */
const DEFAULT_CAP_MS = 20_000;

export class FinalIdWatcher {
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => void;

  private pttOn = false;
  /** Any PTT-TRUE this session. A session that never keyed owes no ID. */
  private transmitted = false;
  /** An ID log line ("SendID" or "Sending CW ID of") has been seen. */
  private idStarted = false;
  private aborted = false;

  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private waiting = false;
  private resolveOutcome: ((outcome: SignOffOutcome) => void) | null = null;
  private readonly quietGraceMs: number;
  private readonly doneGraceMs: number;
  private readonly capMs: number;

  constructor(options: FinalIdWatcherOptions = {}) {
    this.quietGraceMs = options.quietGraceMs ?? DEFAULT_QUIET_GRACE_MS;
    this.doneGraceMs = options.doneGraceMs ?? DEFAULT_DONE_GRACE_MS;
    this.capMs = options.capMs ?? DEFAULT_CAP_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer));
  }

  /** A PTT edge from the modem console. Feed every one; order matters. */
  noteTransmit(on: boolean): void {
    if (on) this.transmitted = true;
    this.pttOn = on;
    this.reevaluate();
  }

  /** An ID announcement line. Fires for the IDFrame AND again for the CW ID. */
  noteIdStart(): void {
    this.idStarted = true;
    this.reevaluate();
  }

  /**
   * Stop pressed. Resolves a pending wait immediately and marks any wait
   * still to come as not-to-be-waited-for: the operator has decided the
   * transmitter goes off NOW, mandatory ID or not.
   */
  markAborted(): void {
    this.aborted = true;
    if (this.waiting) this.settle("aborted");
  }

  /**
   * Back to a blank session. Called when a session begins and when the modem
   * stops. A wait still pending here is resolved rather than left hanging --
   * a modem that is already gone cannot send anything to wait for.
   */
  reset(): void {
    if (this.waiting && !this.settled) this.settle("quiet");
    this.stopTimer();
    if (this.capTimer !== null) {
      this.clearTimeoutFn(this.capTimer);
      this.capTimer = null;
    }
    this.pttOn = false;
    this.transmitted = false;
    this.idStarted = false;
    this.aborted = false;
    this.settled = false;
    this.waiting = false;
    this.resolveOutcome = null;
  }

  /**
   * Resolves when the sign-off is over, one way or another. Ask once, when the
   * session's mail exchange has finished; the teardown may not stop the modem
   * until this settles. Never rejects.
   */
  wait(): Promise<SignOffOutcome> {
    if (this.waiting || this.settled) {
      // A second caller shares the first wait's answer; asking again after it
      // settled means the teardown already has its answer too.
      return this.promise ?? Promise.resolve(this.aborted ? "aborted" : "quiet");
    }
    this.waiting = true;
    this.promise = new Promise<SignOffOutcome>((resolve) => {
      this.resolveOutcome = resolve;
    });
    if (this.aborted) this.settle("aborted");
    else if (!this.transmitted) this.settle("no-transmit");
    else {
      this.capTimer = this.setTimeoutFn(() => {
        this.capTimer = null;
        this.settle("timeout");
      }, this.capMs);
      this.reevaluate();
    }
    return this.promise;
  }

  private promise: Promise<SignOffOutcome> | null = null;

  /**
   * The one place the grace timers are decided, re-run on every event:
   *
   *   PTT up                     -> no grace timer; the cap is the only clock.
   *   PTT down, ID seen          -> doneGrace, then "id-complete". A new ID
   *                                 line or key-up cancels and re-arms.
   *   PTT down, no ID yet        -> quietGrace, then "quiet".
   */
  private reevaluate(): void {
    if (!this.waiting || this.settled) return;
    this.stopTimer();
    if (this.pttOn) return;
    if (this.idStarted) {
      this.graceTimer = this.setTimeoutFn(() => {
        this.graceTimer = null;
        this.settle("id-complete");
      }, this.doneGraceMs);
    } else {
      this.graceTimer = this.setTimeoutFn(() => {
        this.graceTimer = null;
        this.settle("quiet");
      }, this.quietGraceMs);
    }
  }

  private stopTimer(): void {
    if (this.graceTimer !== null) {
      this.clearTimeoutFn(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private settle(outcome: SignOffOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.stopTimer();
    if (this.capTimer !== null) {
      this.clearTimeoutFn(this.capTimer);
      this.capTimer = null;
    }
    this.resolveOutcome?.(outcome);
  }
}
