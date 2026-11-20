// Owns one Winlink session at a time, and turns Pat's failures into something
// an operator can act on.
//
// Pat reports every session failure identically -- HTTP 500 "Session failure"
// (api/api.go:365) -- whether the callsign was missing, the CMS was unreachable
// or the login was rejected. That is useless on its own, so this classifies the
// failure against what it already knows: whether a callsign is set, whether the
// event stream is attached, and what the last events said.

import type {
  ConnectionState,
  PatProgress,
  PatStatus,
  SessionStage,
  SessionTransport,
} from "../../shared/ipcContract.ts";
import { canAdvanceTo, stageFromLogLine } from "../../shared/sessionStage.ts";

/** The alias Pat expands into the CMS telnet URL, substituting {mycall}. */
export const TELNET_ALIAS = "telnet";

export interface PatConnectionApi {
  connect(url: string): Promise<{ NumReceived: number }>;
  disconnect(dirty?: boolean): Promise<void>;
}

export interface PatConnectionOptions {
  getApi: () => PatConnectionApi | null;
  /** Empty until onboarding is done; connecting without one cannot work. */
  getCallsign: () => string;
  /** False until Pat's /ws is answering; see the note on refusal below. */
  isEventStreamAttached: () => boolean;
  onStateChange: (state: ConnectionState) => void;
  onLog?: (message: string) => void;
}

function idleState(): ConnectionState {
  return {
    stage: "idle",
    transport: "telnet",
    messagesReceived: null,
    progress: null,
    error: null,
    eventsAttached: false,
  };
}

/**
 * Classifies a failed session.
 *
 * Pure and exported so the mapping is testable without a Pat: this is the
 * difference between an operator who knows what to fix and one staring at
 * "Session failure".
 */
export interface ConnectFailureContext {
  callsign: string;
  attached: boolean;
  /**
   * How the session was dialled. Telnet failures and RF failures share Pat's
   * one error string but almost never share a cause.
   */
  transport?: "telnet" | "ardop";
  /**
   * Whether OUR modem was up when the dial started.
   *
   * Passed in, never re-read. By the time a session fails the modem has already
   * been stopped in the finally, so asking it now would report every RMS
   * no-answer as a modem failure -- the same trap the `attached` field documents
   * below, where a dying session takes the event stream with it.
   */
  modemStarted?: boolean;
  /** The last stage the session reached, which says how far it got. */
  reachedStage?: string;
  /**
   * True when WE asked Pat to end the session -- the operator's Disconnect or
   * Stop, or WL2GO's own teardown. Pat still reports such a session as a
   * failure ("Exchange failed: connection lost"), and without this flag that
   * wording fell through to the catch-all and told the operator to check
   * their Winlink password for a session they ended themselves.
   */
  aborted?: boolean;
}

export function describeConnectFailure(error: unknown, context: ConnectFailureContext): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (!context.callsign) {
    return "No callsign is set. Finish setup in Settings before connecting.";
  }
  if (!context.attached) {
    return "Not connected to the protocol engine's event stream, so a login prompt could not be answered.";
  }
  // Before any diagnosis: a session we ended on purpose is not a mystery to
  // explain, whatever error Pat wraps around the torn-down link.
  if (context.aborted) {
    return "The session was disconnected before the mail exchange completed.";
  }

  if (context.transport === "ardop") {
    const overRadio = describeRadioFailure(raw, context);
    if (overRadio) return overRadio;
  }
  if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(raw)) {
    return "The protocol engine stopped responding during the session.";
  }
  if (/ENOTFOUND|EAI_AGAIN|dns/i.test(raw)) {
    return "Could not reach Winlink: this machine has no working internet connection.";
  }
  if (/ETIMEDOUT|timed out/i.test(raw)) {
    return "Winlink did not respond in time. The CMS may be busy or unreachable.";
  }
  if (/Session failure/i.test(raw)) {
    // Pat's catch-all. Everything more specific was ruled out above.
    return "Winlink refused the session. Check your callsign and Winlink password in Settings.";
  }
  return raw;
}

/**
 * The RF-only causes, told apart by HOW FAR the session got.
 *
 * Pat returns the same "Session failure" whether the modem was unreachable, the
 * station never answered, or the login was rejected -- but the stage the
 * session reached before dying distinguishes all three, because each stage is
 * only entered once the previous thing worked. Returns null to fall through to
 * the shared causes.
 */
function describeRadioFailure(raw: string, context: ConnectFailureContext): string | null {
  if (context.modemStarted === false) {
    return "The modem was not running, so nothing could be transmitted.";
  }

  // Pat could not reach the TNC. Its own wording, from app/connect.go:285.
  if (/ARDOP TNC initialization failed|connection refused/i.test(raw)) {
    return (
      "The protocol engine could not reach the modem. The modem is running, so this is usually a " +
      "port conflict — try \"Reset modem\" and connect again."
    );
  }

  switch (context.reachedStage) {
    case "starting-modem":
    case "dialing":
      // Never got a reply to the connect request. The overwhelmingly common RF
      // outcome, and none of the causes are things WL2GO can fix.
      return (
        "The station did not answer. Check the radio is tuned to the right frequency and is " +
        "transmitting, and that the band is open to that station."
      );
    case "handshaking":
      // The link came up, so the radio path works; the session died during the
      // Winlink login. That is a credentials problem, not a propagation one.
      return (
        "The station answered but the session did not complete. Check your Winlink password in " +
        "Settings — the radio link itself was working."
      );
    case "connected":
    // The sign-off stages sit PAST connected: the link worked and the mail
    // exchange was over or nearly so when it died. Left out of this switch
    // when they were added, they fell through to the "Winlink refused /
    // check your password" catch-all -- the exact wrong advice for a
    // session that already logged in and exchanged traffic.
    case "signing-off":
    case "sending-id":
      return "The connection to the station dropped part-way through the session.";
    default:
      return null;
  }
}

export class PatConnectionManager {
  private readonly opts: PatConnectionOptions;
  private state: ConnectionState = idleState();
  private active = false;
  /** Set by disconnect()/abort() so the failure Pat then reports is described
   * as our own doing, not diagnosed as Winlink refusing the session. */
  private abortRequested = false;

  constructor(options: PatConnectionOptions) {
    this.opts = options;
  }

  getState(): ConnectionState {
    return { ...this.state, eventsAttached: this.opts.isEventStreamAttached() };
  }

  isConnecting(): boolean {
    return this.active;
  }

  /** Reflects a status frame from the event stream into the session state. */
  applyStatus(status: PatStatus): void {
    if (!this.active) return;
    if (status.connected) this.advance("connected");
  }

  /**
   * Reflects one of Pat's log lines into the session stage.
   *
   * The only view of an RF connect while it is happening. /api/connect does not
   * return until the session is over and /api/status says nothing between
   * "dialing" and "connected", so without this an ARDOP call that stalls
   * mid-handshake looks identical to one that never left the ground.
   *
   * Recognising nothing is the normal case: stageFromLogLine returns null for
   * every line but two, and null changes nothing.
   */
  applyLogLine(line: string): void {
    if (!this.active) return;
    const stage = stageFromLogLine(line);
    if (stage) this.advance(stage);
  }

  /**
   * Moves the stage forward, never back.
   *
   * Pat's "Connected to ..." log line and its connected:true status frame
   * describe the same moment and arrive in either order. Without the ordering
   * check the later one would drag the display backwards and the operator would
   * watch a live session appear to un-connect itself.
   */
  private advance(stage: SessionStage): void {
    if (!canAdvanceTo(this.state.stage, stage)) return;
    this.patch({ stage });
  }

  applyProgress(progress: PatProgress): void {
    if (!this.active) return;
    this.patch({ progress });
  }

  /** Pushes the current state even when nothing else changed, e.g. on attach. */
  notify(): void {
    this.opts.onStateChange(this.getState());
  }

  /**
   * Marks the modem as starting, before Pat is asked for anything.
   *
   * RF only, and set by the caller rather than inferred, because this stage is
   * the one thing in the list that WL2GO does itself: Pat knows nothing about
   * ardopcf until it is already listening.
   */
  beginModemStart(): void {
    this.active = true;
    this.state = { ...idleState(), transport: "ardop" };
    this.patch({ stage: "starting-modem", error: null });
  }

  /**
   * RF only: the modem is up and listening for a clear channel before dialing.
   * Like beginModemStart, set by the caller rather than inferred -- the check
   * is WL2GO's own doing, and Pat knows nothing about it.
   */
  beginChannelCheck(): void {
    if (this.active) this.patch({ stage: "checking-channel" });
  }

  /**
   * RF only: mail is done and the disconnect is going out. Driven by a
   * specific ardopcf console line (modemActivity.ts), so it goes through
   * advance(): only forward from "connected", and a late line after the
   * session has finished or failed moves nothing.
   */
  beginSignOff(): void {
    if (!this.active || this.state.stage !== "connected") return;
    this.advance("signing-off");
  }

  /**
   * RF only: the final IDFrame / CW ID is actually keying up. Entered from
   * "connected" OR "signing-off", because the two close branches order the
   * DISCONNECT trace and the ID lines differently -- and NOT from anything
   * earlier, so a mid-session ten-minute IDFrame advances nothing.
   */
  beginSendingId(): void {
    if (!this.active) return;
    if (this.state.stage !== "connected" && this.state.stage !== "signing-off") return;
    this.advance("sending-id");
  }

  /**
   * Ends the session with a named reason, without having dialled.
   *
   * For the failures that happen BEFORE Pat is asked for anything -- the modem
   * refusing to start, chiefly. Those never reach connect()'s catch, so without
   * this the UI would sit on "starting the modem" for ever.
   */
  failSession(reason: string): void {
    this.active = false;
    this.patch({ stage: "failed", error: reason, progress: null });
  }

  /**
   * Runs a session and resolves when it is over.
   *
   * `url` defaults to the telnet alias, which Pat expands from connect_aliases
   * and substitutes {mycall} into, so the CMS address stays Pat's business.
   */
  async connect(
    transport: SessionTransport = "telnet",
    url: string = TELNET_ALIAS,
    context: {
      modemStarted?: boolean;
      /**
       * Awaited between Pat's /api/connect resolving and the session being
       * marked finished. This is where an RF session waits out the modem's
       * final station ID: Pat reports the session over the moment the
       * DISCONNECT exchange completes, which is up to three seconds BEFORE
       * ardopcf's deferred IDFrame + CW ID even starts. Success path only --
       * a failed session should say so at once, and the connection manager's
       * own teardown still protects any ID a failure leaves in flight.
       */
      beforeFinish?: () => Promise<unknown>;
    } = {},
  ): Promise<ConnectionState> {
    // A radio session has already gone through beginModemStart, so `active` is
    // legitimately set. Only a second TELNET dial is a mistake.
    if (this.active && transport === "telnet") throw new Error("A session is already in progress.");

    const callsign = this.opts.getCallsign();
    if (!callsign) {
      throw new Error("No callsign is set. Finish setup in Settings before connecting.");
    }

    // Refused rather than attempted. Pat asks promptUnconfirmedAccount() before
    // it even parses the transport (connect.go:46), and with no prompter that
    // blocks for a two-minute timeout and then fails with nothing explaining it.
    if (!this.opts.isEventStreamAttached()) {
      throw new Error(
        "Not connected to the protocol engine yet. Wait a moment and try again — connecting now would hang.",
      );
    }

    const api = this.opts.getApi();
    if (!api) throw new Error("The protocol engine is not running.");

    this.active = true;
    this.abortRequested = false;
    // Not advance(): dialing must be reachable from starting-modem AND from a
    // finished or failed session, which advance() deliberately refuses.
    this.state = { ...this.state, transport };
    this.patch({ stage: "dialing", error: null, progress: null, messagesReceived: null });
    this.opts.onLog?.(
      transport === "ardop"
        ? `Connecting to Winlink as ${callsign} over the air (${url})`
        : `Connecting to Winlink as ${callsign} over Telnet`,
    );

    try {
      const result = await api.connect(url);
      // Still `active` here, so the sign-off stages driven by the modem's
      // console keep advancing while the ID goes out. Never allowed to throw:
      // the session's mail exchange already succeeded, and no watcher bug may
      // turn that into a failure.
      if (context.beforeFinish) {
        try {
          await context.beforeFinish();
        } catch {
          // Deliberate: see above.
        }
      }
      this.active = false;
      this.patch({ stage: "finished", messagesReceived: result.NumReceived, progress: null });
      this.opts.onLog?.(`Session finished; ${result.NumReceived} message(s) received`);
    } catch (err: unknown) {
      this.active = false;
      // attached is true by construction: the guard above already refused to
      // start otherwise. Re-reading it here would be wrong -- a session that
      // dies often takes the event stream with it, so every CMS refusal would
      // be reported as "not attached" and point the operator at the wrong thing.
      const described = describeConnectFailure(err, {
        callsign,
        attached: true,
        transport,
        // The stage BEFORE this failure is what says how far the session got,
        // so it is read before patch() overwrites it with "failed".
        reachedStage: this.state.stage,
        aborted: this.abortRequested,
        ...(context.modemStarted === undefined ? {} : { modemStarted: context.modemStarted }),
      });
      this.patch({ stage: "failed", error: described, progress: null });
      this.opts.onLog?.(`Session failed: ${described}`);
    }

    return this.getState();
  }

  /**
   * Aborts the session the connect() call is still awaiting.
   *
   * Deliberately does not settle connect() itself: Pat finishes that request on
   * its own once the abort lands, and inventing a second completion path here
   * would let the two disagree about what happened.
   */
  async disconnect(): Promise<ConnectionState> {
    const api = this.opts.getApi();
    if (!api || !this.active) return this.getState();

    this.opts.onLog?.("Disconnecting from Winlink");
    this.abortRequested = true;
    await api.disconnect(false);
    return this.getState();
  }

  /**
   * Abandons the session without the polite handshake.
   *
   * `dirty` is the whole difference. A clean disconnect asks the remote station
   * and Pat keeps transmitting DISC frames until it answers or gives up -- the
   * log that prompted this shows fifteen seconds of them after two presses of
   * Disconnect. Someone reaching for a stop button has already decided they do
   * not care whether the other end is told.
   */
  async abort(): Promise<ConnectionState> {
    const api = this.opts.getApi();
    if (!api || !this.active) return this.getState();

    this.opts.onLog?.("Aborting the session");
    this.abortRequested = true;
    await api.disconnect(true);
    return this.getState();
  }

  private patch(changes: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...changes };
    this.notify();
  }
}
