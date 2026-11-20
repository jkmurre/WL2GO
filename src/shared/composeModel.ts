// Everything that decides what an outgoing message says.
//
// Pure and in shared/ so it is unit-testable: .tsx cannot be type-stripped by
// `node --test`, and this is the part where being subtly wrong is invisible in
// review but obvious to whoever receives the message.
//
// The formats here are not ours to invent. Quoting matches Pat's byte for byte
// so replies read the same in every Winlink client, and the Acknowledge text
// follows Winlink Express's wording.

import type { MailMessage, MailMessageSummary } from "./ipcContract.ts";

/** Pat rejects a subject longer than this (fbb/message.go:132-135). */
export const MAX_SUBJECT_LENGTH = 128;

/** What compose holds while it is being written. */
export interface ComposeDraft {
  /** Local id, ours alone. The Winlink MID is assigned by Pat at send. */
  id: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  /** Peer-to-peer only: never relayed through the CMS. */
  p2pOnly: boolean;
  attachments: ComposeAttachment[];
}

export interface ComposeAttachment {
  name: string;
  contentType: string;
  sizeBytes: number;
}

export function emptyDraft(id: string): ComposeDraft {
  return { id, to: "", cc: "", subject: "", body: "", p2pOnly: false, attachments: [] };
}

/**
 * Splits an address field the way Pat does.
 *
 * Pat's SplitFunc treats whitespace, commas and semicolons alike
 * (app/utils.go:11-13). Matching it means what the operator sees in the field is
 * what Pat will parse -- and Winlink operators type all three.
 */
export function parseAddresses(input: string): string[] {
  const seen = new Set<string>();
  const addresses: string[] = [];

  for (const token of input.split(/[\s,;]+/)) {
    const address = token.trim();
    if (!address) continue;
    // Case-insensitive: callsigns are conventionally upper case, and W1AW twice
    // in one field should not become two recipients. The same rule collapses
    // Bob@example.org and bob@example.org, which is right -- but note the
    // address itself is stored AS TYPED, since an internet mail server is
    // entitled to treat its local part as case-sensitive.
    const key = address.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }

  return addresses;
}

/**
 * Is this an internet email address rather than a Winlink one?
 *
 * The "@" is the whole test, and deliberately so. Winlink addresses are
 * callsigns, tactical addresses and group addresses, none of which contain one;
 * anything that does is routed out through the CMS's internet gateway. fbb
 * classifies the same way -- an address it parses with proto "SMTP" is exactly
 * one with an "@" in it (fbb/message.go:30-33).
 */
export function isInternetAddress(address: string): boolean {
  return address.includes("@");
}

/**
 * Every internet recipient of a draft, across both To and Cc.
 *
 * Re-parsed as one field so an address in BOTH is named once: parseAddresses
 * only dedupes within a field, and "adds bob@x.org, bob@x.org to your accept
 * list" reads like a bug.
 */
export function internetRecipients(draft: Pick<ComposeDraft, "to" | "cc">): string[] {
  return parseAddresses(`${draft.to} ${draft.cc}`).filter(isInternetAddress);
}

/**
 * A deliverable-looking email address: one "@", a dot in the domain, no spaces.
 *
 * Used ONLY to warn. Winlink's address space is wider than callsign-or-email --
 * tactical addresses, group addresses, "SMTP:" proto prefixes -- and a shape
 * test that blocked Send would take the operator's only way out of a false
 * negative, on the day it matters. So a token with no "@" is never questioned
 * at all, and one with an "@" gets a note under the field. The CMS is the
 * authority on whether an address exists; this only catches the typo.
 */
const DELIVERABLE_EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Non-blocking notes about the recipients.
 *
 * Separate from validateDraft on purpose: those problems disable Send, these
 * never do.
 */
export function addressWarnings(draft: Pick<ComposeDraft, "to" | "cc" | "p2pOnly">): string[] {
  const warnings: string[] = [];

  const malformed = [...parseAddresses(draft.to), ...parseAddresses(draft.cc)]
    .filter((address) => isInternetAddress(address) && !DELIVERABLE_EMAIL.test(address));
  for (const address of malformed) {
    warnings.push(`${address} does not look like a complete email address.`);
  }

  // Peer-to-peer is a direct station-to-station exchange that never reaches the
  // CMS, and the CMS is what holds the internet gateway. So an email address in
  // a P2P-only message is not merely undelivered -- it also never reaches the
  // accept list, which is what would have let that person reply.
  const internet = internetRecipients(draft);
  if (draft.p2pOnly && internet.length > 0) {
    warnings.push(
      `Peer-to-peer only bypasses the Winlink CMS, and the CMS is what carries mail to the internet. ` +
        `${internet.join(", ")} will not receive this.`,
    );
  }

  return warnings;
}

export interface ValidationProblem {
  field: "to" | "subject" | "body";
  message: string;
}

/**
 * Checks a draft against the rules Pat will apply.
 *
 * Mirrored rather than left to the server on purpose. Pat's own web UI silently
 * substitutes "<No subject>" and "<No message body>" to get past these
 * (web/src/js/modules/composer/index.js:97-101) -- an operator who forgot their
 * body should be told, not have a placeholder transmitted over their callsign.
 */
export function validateDraft(draft: ComposeDraft): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  if (parseAddresses(draft.to).length === 0) {
    problems.push({ field: "to", message: "Add at least one recipient." });
  }
  if (!draft.subject.trim()) {
    problems.push({ field: "subject", message: "Winlink requires a subject." });
  } else if (draft.subject.length > MAX_SUBJECT_LENGTH) {
    problems.push({
      field: "subject",
      message: `Subjects can be at most ${MAX_SUBJECT_LENGTH} characters; this one is ${draft.subject.length}.`,
    });
  }
  if (!draft.body.trim()) {
    problems.push({ field: "body", message: "Winlink will not accept an empty message." });
  }

  return problems;
}

/** Winlink's own date format, used in the quote header and the ack body. */
export function formatWinlinkDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown date";

  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

/**
 * Quotes a message for a reply, in Pat's exact format.
 *
 * `--- {date} {sender} wrote: ---` then every line prefixed with ">", no space
 * after it (web/src/js/modules/composer/index.js:357-365). Matching this is
 * what makes a WL2GO reply look like every other Winlink reply in the thread.
 */
export function quoteBody(message: Pick<MailMessage, "date" | "from" | "body">): string {
  const header = `--- ${formatWinlinkDate(message.date)} ${message.from} wrote: ---\n`;
  const lines = (message.body ?? "").split("\n");
  return header + lines.map((line) => `>${line}`).join("\n") + "\n";
}

/** Adds a prefix unless the subject already carries it. */
function prefixSubject(subject: string, prefix: string): string {
  return subject.startsWith(prefix) ? subject : `${prefix}${subject}`;
}

/**
 * Is this address the operator themselves?
 *
 * Two forms count. A Winlink user is addressed by bare callsign from inside the
 * network and as `callsign@winlink.org` from the public internet
 * (https://winlink.org/HELP), and a message that arrived through the gateway
 * can carry either. Matching only the bare form would put the operator's own
 * internet address in a Reply All -- which then routes out through the CMS and
 * back, spending RF time to deliver a copy to the person sending it.
 *
 * The domain is checked rather than accepting any `callsign@...`: N1CALL at
 * some unrelated provider is a different mailbox, possibly a different person,
 * and dropping a real recipient from a Cc is worse than the fault being fixed.
 */
export function isOwnAddress(address: string, mycall: string): boolean {
  const call = mycall.trim().toUpperCase();
  if (!call) return false;
  const candidate = address.trim().toUpperCase();
  return candidate === call || candidate === `${call}@WINLINK.ORG`;
}

export interface ReplyContext {
  /** The operator's own callsign, so Reply All does not copy them in. */
  mycall: string;
}

export function buildReply(id: string, message: MailMessage, _context: ReplyContext): ComposeDraft {
  return {
    ...emptyDraft(id),
    to: message.from,
    subject: prefixSubject(message.subject, "Re: "),
    // Two blank lines first: the operator writes above the quote, which is
    // where every mail client puts the cursor.
    body: `\n\n${quoteBody(message)}`,
  };
}

/**
 * Reply All.
 *
 * Recipients follow Pat's rule (web/src/js/modules/composer/index.js:357-372):
 * everyone in To and Cc, minus ourselves and minus the sender -- who is already
 * the To of the reply. Copying yourself on a net with a dozen stations is the
 * kind of thing that is embarrassing rather than harmful, but it is also
 * trivially avoidable.
 */
export function buildReplyAll(id: string, message: MailMessage, context: ReplyContext): ComposeDraft {
  const sender = message.from.toUpperCase();
  const cc = [...message.to, ...message.cc].filter(
    (address) => !isOwnAddress(address, context.mycall) && address.toUpperCase() !== sender,
  );

  return {
    ...buildReply(id, message, context),
    cc: parseAddresses(cc.join(", ")).join(", "),
  };
}

/** Ordinary forward: quoted body, attachments carried, subject prefixed. */
export function buildForward(id: string, message: MailMessage): ComposeDraft {
  return {
    ...emptyDraft(id),
    subject: prefixSubject(message.subject, "Fw: "),
    body: quoteBody(message),
    attachments: message.attachments.map((file) => ({
      name: file.name,
      contentType: "",
      sizeBytes: file.sizeBytes,
    })),
  };
}

/** The line that marks a message forwarded without changes. */
export const FORWARD_UNCHANGED_NOTICE = "This message was forwarded without changes";

/**
 * Forward Without Changes.
 *
 * The operator supplies recipients and nothing else: the body and attachments
 * go out as received, and the SUBJECT IS NOT PREFIXED -- "without changes"
 * means what it says, and the prepended notice already announces what happened.
 *
 * This is the behaviour Winlink Express operators expect, and it is the reason
 * ordinary Forward exists separately: that one quotes and lets you edit.
 */
export function buildForwardUnchanged(id: string, message: MailMessage): ComposeDraft {
  return {
    ...emptyDraft(id),
    subject: message.subject,
    body: `${FORWARD_UNCHANGED_NOTICE}\n\n${message.body ?? ""}`,
    attachments: message.attachments.map((file) => ({
      name: file.name,
      contentType: "",
      sizeBytes: file.sizeBytes,
    })),
  };
}

/**
 * Edit, on a message still waiting in the outbox.
 *
 * The message as queued, back as a draft: nothing is added or quoted, because
 * this is the operator's own unsent message and they are correcting it, not
 * replying to it. The attachment BYTES are fetched separately and stored with
 * the draft; this only describes them.
 */
export function draftFromQueued(id: string, message: MailMessage): ComposeDraft {
  return {
    id,
    to: message.to.join(", "),
    cc: message.cc.join(", "),
    subject: message.subject,
    body: message.body ?? "",
    p2pOnly: message.p2pOnly,
    attachments: message.attachments.map((file) => ({
      name: file.name,
      contentType: "",
      sizeBytes: file.sizeBytes,
    })),
  };
}

export interface AcknowledgementContext {
  mycall: string;
  /** When the acknowledgement is being made, not when the message arrived. */
  acknowledgedAt: string;
}

/**
 * Acknowledge.
 *
 * Never opens for editing, so this text IS the feature. The subject and the
 * opening line follow Winlink Express; the message id and the timestamp are
 * WL2GO additions -- Express omits both, and without them an acknowledgement
 * is ambiguous the moment two messages share a subject.
 */
export function buildAcknowledgement(
  id: string,
  message: MailMessageSummary,
  context: AcknowledgementContext,
): ComposeDraft {
  const body =
    `The following message was received by ${context.mycall}.\n\n` +
    `Message ID:   ${message.mid}\n` +
    `Acknowledged: ${formatWinlinkDate(context.acknowledgedAt)} UTC\n`;

  return {
    ...emptyDraft(id),
    to: message.from,
    subject: `ACK: ${message.subject}`,
    body,
  };
}

/** The form fields Pat's compose endpoint reads. Nothing else is looked at. */
export function draftToFields(draft: ComposeDraft, sentAt: string): Record<string, string> {
  return {
    to: parseAddresses(draft.to).join(","),
    cc: parseAddresses(draft.cc).join(","),
    subject: draft.subject.trim(),
    body: draft.body,
    // Pat checks only that the field is non-empty (api/mailbox.go:323-325).
    p2ponly: draft.p2pOnly ? "true" : "",
    date: sentAt,
  };
}
