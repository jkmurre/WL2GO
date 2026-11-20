// The wire format of Pat's /ws endpoint, as read from api/wshub.go.
//
// Pure: no socket, no I/O. The protocol is the part most likely to be wrong and
// the part hardest to exercise against a live Pat, so it is separated from the
// connection handling and tested on its own.
//
// Pat -> us   {"Status":{...}} {"Progress":{...}} {"Notification":{...}}
//             {"LogLine":"..."} {"Prompt":{...}} {"PromptAbort":{...}}
//             {"Ping":true}
// us -> Pat   {"Pong":true}  {"prompt_response":{"id","value"}}

import type { PatPrompt, PatProgress, PatStatus } from "../../shared/ipcContract.ts";

export interface PatNotification {
  title: string;
  body: string;
}

export type PatWsEvent =
  /**
   * Pat pings every 4 minutes and drops the client if no Pong arrives within
   * KeepaliveInterval + 10s (wshub.go:194-207, 288). Answering is mandatory, not
   * courtesy -- an unanswered ping ends the session mid-transfer.
   */
  | { type: "ping" }
  | { type: "status"; status: PatStatus }
  | { type: "progress"; progress: PatProgress }
  | { type: "notification"; notification: PatNotification }
  | { type: "logLine"; line: string }
  | { type: "prompt"; prompt: PatPrompt }
  /** Pat withdrew a prompt -- it timed out or was answered elsewhere. */
  | { type: "promptAbort"; prompt: PatPrompt }
  /**
   * The mailbox changed on disk -- and that is the entire message.
   *
   * Pat sends a bare {"UpdateMailbox":true} with no box, no MID and no
   * operation (wshub.go:143-151): it is raw fsnotify over the four mailbox
   * directories, debounced to 100ms, covering create, write, remove and rename
   * alike. Finding out WHAT changed means re-listing and diffing.
   */
  | { type: "updateMailbox" }
  /** The callsign Pat is serving, sent once on connect (api/api.go:207). */
  | { type: "myCall"; callsign: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns one WebSocket frame into an event.
 *
 * Returns null for anything unrecognised rather than throwing: Pat may add
 * message kinds, and an unknown frame is not a reason to tear down a live
 * session.
 */
export function decodeWsMessage(raw: string): PatWsEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if ("Ping" in parsed) return { type: "ping" };
  if ("UpdateMailbox" in parsed) return { type: "updateMailbox" };
  if (typeof parsed["MyCall"] === "string") return { type: "myCall", callsign: parsed["MyCall"] };

  if (isRecord(parsed["Status"])) {
    return { type: "status", status: parsed["Status"] as unknown as PatStatus };
  }
  if (isRecord(parsed["Progress"])) {
    return { type: "progress", progress: parsed["Progress"] as unknown as PatProgress };
  }
  if (isRecord(parsed["Notification"])) {
    return { type: "notification", notification: parsed["Notification"] as unknown as PatNotification };
  }
  if (typeof parsed["LogLine"] === "string") {
    return { type: "logLine", line: parsed["LogLine"] };
  }

  const prompt = decodePrompt(parsed["Prompt"]);
  if (prompt) return { type: "prompt", prompt };

  const aborted = decodePrompt(parsed["PromptAbort"]);
  if (aborted) return { type: "promptAbort", prompt: aborted };

  return null;
}

const PROMPT_KINDS = new Set<PatPrompt["kind"]>([
  "password",
  "multi-select",
  "busy-channel",
  "pre-account-activation",
  "account-activation",
]);

function decodePrompt(raw: unknown): PatPrompt | null {
  if (!isRecord(raw)) return null;

  const id = raw["id"];
  const kind = raw["kind"];
  if (typeof id !== "string" || !id) return null;
  if (typeof kind !== "string" || !PROMPT_KINDS.has(kind as PatPrompt["kind"])) return null;

  const prompt: PatPrompt = {
    id,
    kind: kind as PatPrompt["kind"],
    message: typeof raw["message"] === "string" ? raw["message"] : "",
  };

  if (Array.isArray(raw["options"])) {
    prompt.options = raw["options"].filter(isRecord).map((option) => ({
      value: typeof option["value"] === "string" ? option["value"] : "",
      desc: typeof option["desc"] === "string" ? option["desc"] : undefined,
      checked: option["checked"] === true,
    }));
  }

  return prompt;
}

export function encodePong(): string {
  return JSON.stringify({ Pong: true });
}

/**
 * A reply to one prompt.
 *
 * The `error` field is deliberately omitted. Pat declares it as
 * `Err error` (api/types/prompt.go), a Go interface that cannot be unmarshalled
 * from JSON -- sending it risks the whole response failing to decode.
 */
export function encodePromptResponse(id: string, value: string): string {
  return JSON.stringify({ prompt_response: { id, value } });
}
