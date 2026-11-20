// Pat's message JSON -> WL2GO's message shape.
//
// Pure: no Electron, no IO, no database. The wire format is the part most
// likely to surprise us and the part hardest to exercise against a live Pat, so
// it is separated out and tested on its own.
//
// Pat's JSONMessage has a hand-written MarshalJSON with NO json tags
// (api/mailbox.go:65-101), so every key is the Go field name verbatim and
// capitalised, and every key is always present -- there is no omitempty.

import type { MailAttachment, MailBox, MailMessage } from "../../shared/ipcContract.ts";
import { MAIL_BOXES } from "../../shared/ipcContract.ts";

/** Pat rejects a MID longer than this (fbb/message.go:123-126). */
const MAX_MID_LENGTH = 12;

/** Sorts last, for a message whose date we could not make sense of. */
const UNKNOWN_DATE = new Date(0).toISOString();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMailBox(value: unknown): value is MailBox {
  return typeof value === "string" && (MAIL_BOXES as readonly string[]).includes(value);
}

/**
 * One address.
 *
 * fbb.Address is an untagged struct {Proto, Addr} (fbb/message.go:30-33), so it
 * arrives as {"Proto":"","Addr":"N1CALL"} -- Proto is "" for Winlink callsigns
 * and "SMTP" for internet mail. Only the address itself is kept: the protocol is
 * implied by the address and showing it would only clutter the UI.
 */
function toAddress(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (!isRecord(raw)) return null;
  const addr = raw["Addr"];
  return typeof addr === "string" && addr.trim() ? addr.trim() : null;
}

/**
 * A list of addresses.
 *
 * Pat sends JSON `null`, not `[]`, when the header is absent: both To and Cc are
 * built by appending to a nil slice (fbb/message.go:278-291). Pat's own web UI
 * guards for this, and so must we.
 */
function toAddressList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const addresses: string[] = [];
  for (const entry of raw) {
    const address = toAddress(entry);
    if (address) addresses.push(address);
  }
  return addresses;
}

function toAttachments(raw: unknown): MailAttachment[] {
  if (!Array.isArray(raw)) return [];
  const files: MailAttachment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = entry["Name"];
    if (typeof name !== "string" || !name) continue;
    const size = entry["Size"];
    files.push({ name, sizeBytes: typeof size === "number" && size >= 0 ? size : 0 });
  }
  return files;
}

/**
 * Pat's date, normalised to UTC.
 *
 * It arrives as RFC3339 carrying the SERVER's local offset, because ParseDate
 * ends with date.Local() (fbb/message.go:598). Two messages an hour apart can
 * therefore compare wrongly as strings if the offset changed between them --
 * across a DST boundary, say. Normalising to UTC makes lexical order and
 * chronological order the same thing, which is what the folder index relies on.
 */
function toIsoDate(raw: unknown): string {
  if (typeof raw !== "string") return UNKNOWN_DATE;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? UNKNOWN_DATE : new Date(parsed).toISOString();
}

/**
 * One message from Pat's JSON, or null if it cannot be keyed.
 *
 * Null rather than throwing: one unusable message in a folder of two hundred
 * must not cost the operator the other hundred and ninety-nine. The caller logs
 * the count it skipped.
 *
 * `box` is a parameter because Pat's JSON does not carry it -- the folder is in
 * the request path, not the response.
 */
export function mapPatMessage(box: MailBox, raw: unknown): MailMessage | null {
  if (!isRecord(raw)) return null;

  // The MID is our primary key, so a message without one has nowhere to live.
  const mid = raw["MID"];
  if (typeof mid !== "string") return null;
  const trimmed = mid.trim();
  if (!trimmed || trimmed.length > MAX_MID_LENGTH) return null;

  const from = toAddress(raw["From"]) ?? "";
  const subject = typeof raw["Subject"] === "string" ? raw["Subject"] : "";

  // Present but empty on the listing endpoint, which gates it behind an
  // unexported inclBody (api/mailbox.go:95-99). "" and "not fetched yet" are
  // different states, so an empty string becomes null rather than being cached
  // as a body we then never fetch.
  const rawBody = raw["Body"];
  const body = typeof rawBody === "string" && rawBody !== "" ? rawBody : null;

  return {
    box,
    mid: trimmed,
    date: toIsoDate(raw["Date"]),
    from,
    to: toAddressList(raw["To"]),
    cc: toAddressList(raw["Cc"]),
    subject,
    unread: raw["Unread"] === true,
    p2pOnly: raw["P2POnly"] === true,
    attachments: toAttachments(raw["Files"]),
    body,
  };
}

export interface MappedFolder {
  messages: MailMessage[];
  /** Entries Pat returned that could not be mapped. Reported, never silent. */
  skipped: number;
}

/** A whole folder listing. */
export function mapPatFolder(box: MailBox, raw: unknown): MappedFolder {
  if (!Array.isArray(raw)) return { messages: [], skipped: 0 };

  const messages: MailMessage[] = [];
  let skipped = 0;
  for (const entry of raw) {
    const message = mapPatMessage(box, entry);
    if (message) messages.push(message);
    else skipped += 1;
  }
  return { messages, skipped };
}
