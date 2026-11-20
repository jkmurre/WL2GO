// What a Winlink session is doing, as one vocabulary for both transports.
//
// Pure, and in shared/, for the reason profileWizard.ts is: the Toolbar and the
// StatusBar each grew their own switch over the old `phase` field, so "is a
// session busy" had two definitions that happened to agree. Adding RF stages
// would have made that three. The rules live here and the components render
// what they decide.

import type { CheckStatus, ConnectionState, SessionStage } from "./ipcContract.ts";

/** A steady dot, as opposed to CheckStatus's four; matches the renderer's DotStatus. */
export type StageTone = CheckStatus | "idle";

/** Nothing else may start while one of these is true. */
export function isSessionBusy(state: ConnectionState | null): boolean {
  if (!state) return false;
  return state.stage === "starting-modem" || state.stage === "checking-channel" ||
    state.stage === "dialing" || state.stage === "handshaking" ||
    state.stage === "connected" || state.stage === "signing-off" ||
    state.stage === "sending-id";
}

/** The session is over, one way or the other. */
export function isTerminalStage(stage: SessionStage): boolean {
  return stage === "finished" || stage === "failed";
}

/**
 * Maps a line Pat logged onto the stage it announces, or null.
 *
 * Null for anything unrecognised, and that is the whole discipline: an
 * unrecognised line advances nothing. Pat logs a great deal during a session,
 * and a loose match -- anything containing "connect", say -- would move the
 * display on the strength of a line about something else. Only these exact
 * prefixes count, each one read out of Pat's source:
 *
 *   app/connect.go:181   "Connecting to %s (%s)..."   -- dialling has begun
 *   app/exchange.go:207  "Connected to %s (%s)"       -- link up, FBB starting
 *
 * Note how close those two are in wording. That is exactly why this matches on
 * the specific prefix rather than on a keyword.
 */
export function stageFromLogLine(line: string): SessionStage | null {
  const text = line.trim();
  if (text.startsWith("Connecting to ")) return "dialing";
  if (text.startsWith("Connected to ")) return "handshaking";
  return null;
}

/**
 * Whether a stage may follow the one already reached.
 *
 * A session only moves forward. Without this a late log line could drag the
 * display backwards -- Pat's "Connected to ..." arrives on the socket after our
 * own status handler has already seen connected:true, and the operator would
 * watch the session appear to un-connect itself.
 *
 * Terminal stages are absorbing: nothing a log line says after a session failed
 * may make it look alive again.
 */
const ORDER: readonly SessionStage[] = [
  "idle",
  "starting-modem",
  "checking-channel",
  "dialing",
  "handshaking",
  "connected",
  "signing-off",
  "sending-id",
];

export function canAdvanceTo(current: SessionStage, next: SessionStage): boolean {
  if (isTerminalStage(current)) return false;
  if (isTerminalStage(next)) return true;
  const from = ORDER.indexOf(current);
  const to = ORDER.indexOf(next);
  if (from === -1 || to === -1) return false;
  return to > from;
}

/**
 * The session line in the status bar: a dot and a sentence.
 *
 * "Not connected" is a resting state and gets a steady dot; anything actually
 * happening animates.
 */
export function describeStage(state: ConnectionState | null): { tone: StageTone; label: string } {
  if (!state) return { tone: "idle", label: "Not connected" };

  // Transfer progress outranks the stage, because it is the more specific
  // thing to say about the same moment -- and it is the only part that moves
  // while a long message goes over the air.
  const progress = state.progress;
  if (progress && !progress.done && progress.bytes_total > 0) {
    const percent = Math.min(100, Math.round((progress.bytes_transferred / progress.bytes_total) * 100));
    const what = progress.receiving ? "Receiving" : "Sending";
    return { tone: "pending", label: `${what} ${progress.subject || progress.mid} — ${percent}%` };
  }

  const overRadio = state.transport === "ardop";

  switch (state.stage) {
    case "idle":
      return { tone: "idle", label: "Not connected" };
    case "starting-modem":
      return { tone: "pending", label: "Starting the modem" };
    case "checking-channel":
      return { tone: "pending", label: "Listening for a clear channel" };
    case "dialing":
      return { tone: "pending", label: overRadio ? "Calling the station" : "Connecting to Winlink" };
    case "handshaking":
      return { tone: "pending", label: "Signing in to Winlink" };
    case "connected":
      return { tone: "pass", label: "Connected" };
    case "signing-off":
      // No mention of the station ID: at this point only the disconnect has
      // been requested. The ID gets its own stage when it actually keys up.
      return { tone: "pending", label: "Signing off" };
    case "sending-id":
      return { tone: "pending", label: "Sending station ID" };
    case "failed":
      return { tone: "fail", label: state.error ?? "Session failed" };
    case "finished":
      return { tone: "pass", label: describeFinished(state.messagesReceived) };
  }
}

function describeFinished(received: number | null): string {
  if (received === 0 || received === null) return "Session complete — no new messages";
  return `Session complete — ${received} new message${received === 1 ? "" : "s"}`;
}
