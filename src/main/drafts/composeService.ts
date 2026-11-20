// Turning a draft into a message Pat will send.
//
// Owns the draft store and the send path. Electron-free -- the file picker lives
// in the IPC layer and hands bytes down -- so this is testable under
// `node --test`.

import {
  buildAcknowledgement,
  draftFromQueued,
  draftToFields,
  validateDraft,
  type ComposeDraft,
} from "../../shared/composeModel.ts";
import type { DraftSummaryView, MailBox, MailMessage, SendResult } from "../../shared/ipcContract.ts";
import type { MultipartFile } from "../util/multipart.ts";
import type { DraftAttachment, DraftStore } from "./draftStore.ts";

/** The slice of PatApiClient this needs. */
export interface ComposeApi {
  postMessage(fields: Record<string, string>, files: readonly MultipartFile[]): Promise<void>;
  getAttachment(box: string, mid: string, name: string): Promise<{ name: string; contentType: string; bytes: Buffer }>;
}

export interface ComposeServiceOptions {
  store: DraftStore;
  getApi: () => ComposeApi | null;
  getCallsign: () => string;
  /** Reads a message out of the mailbox cache, for replies and acknowledgements. */
  getMessage: (box: MailBox, mid: string) => MailMessage | null;
  /**
   * Reads a message WITH its body, fetching it from Pat if the cache has only
   * the summary. Edit needs the text; replies make do with the cache.
   */
  loadMessage?: (box: MailBox, mid: string) => Promise<MailMessage | null>;
  /** Removes a message from Pat's outbox. Resolves false if Pat refused. */
  removeQueued?: (mid: string) => Promise<boolean>;
  /** True while a session is running, when Pat may be sending the outbox. */
  sessionBusy?: () => boolean;
  /** Called after the outbox gains a message, so the mailbox re-syncs. */
  onQueued: () => void;
  onDraftsChanged: (drafts: DraftSummaryView[]) => void;
  onLog?: (message: string) => void;
  now?: () => Date;
}

export class ComposeService {
  private readonly opts: ComposeServiceOptions;

  constructor(options: ComposeServiceOptions) {
    this.opts = options;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private requireCallsign(): string {
    const callsign = this.opts.getCallsign();
    if (!callsign) throw new Error("Finish setup in Settings before sending mail.");
    return callsign;
  }

  private requireApi(): ComposeApi {
    const api = this.opts.getApi();
    if (!api) throw new Error("The protocol engine is not running.");
    return api;
  }

  list(): DraftSummaryView[] {
    const callsign = this.opts.getCallsign();
    return callsign ? this.opts.store.list(callsign) : [];
  }

  get(id: string): ComposeDraft | null {
    const callsign = this.opts.getCallsign();
    return callsign ? (this.opts.store.get(callsign, id)?.draft ?? null) : null;
  }

  /**
   * Saves a draft's text, leaving its attachments alone.
   *
   * Attachments are added and removed through their own calls, which already
   * hold the bytes; a text save must not have to carry megabytes back and forth
   * over IPC on every keystroke.
   */
  save(draft: ComposeDraft): void {
    const callsign = this.requireCallsign();
    const existing = this.opts.store.get(callsign, draft.id);
    const attachments = this.keepNamed(existing?.attachments ?? [], draft.attachments.map((f) => f.name));

    this.opts.store.save(callsign, draft, attachments, this.now());
    this.announce();
  }

  delete(id: string): void {
    const callsign = this.requireCallsign();
    this.opts.store.delete(callsign, id);
    this.announce();
  }

  /** Adds already-read files to a draft, keeping what is there. */
  attach(id: string, files: readonly DraftAttachment[]): void {
    const callsign = this.requireCallsign();
    const existing = this.opts.store.get(callsign, id);
    if (!existing) return;

    // Same name replaces rather than duplicates: attaching a file twice is
    // almost always a correction, not a request for two copies.
    const byName = new Map(existing.attachments.map((file) => [file.name, file]));
    for (const file of files) byName.set(file.name, file);

    const merged = [...byName.values()];
    this.opts.store.save(
      callsign,
      { ...existing.draft, attachments: merged.map(describe) },
      merged,
      this.now(),
    );
    this.announce();
  }

  /**
   * Copies an existing message's attachments onto a draft.
   *
   * Used by Forward and Forward Without Changes: the bytes live in Pat's
   * mailbox, never in our cache, so they are fetched back out and stored on the
   * draft like any other attachment.
   */
  async carryAttachments(box: MailBox, mid: string, draftId: string): Promise<DraftAttachment[]> {
    const message = this.opts.getMessage(box, mid);
    if (!message || message.attachments.length === 0) return [];

    const api = this.requireApi();
    const files: DraftAttachment[] = [];
    for (const file of message.attachments) {
      const fetched = await api.getAttachment(box, mid, file.name);
      files.push({ name: fetched.name, contentType: fetched.contentType, bytes: fetched.bytes });
    }

    this.attach(draftId, files);
    return files;
  }

  /**
   * Validates a draft, queues it in Pat's outbox, and discards the draft.
   *
   * Validated here rather than left to Pat. Pat's own UI substitutes
   * "<No subject>" and "<No message body>" to get past the same checks
   * (web/src/js/modules/composer/index.js:97-101) -- an operator who forgot
   * their body should be told, not have a placeholder go out over their
   * callsign.
   */
  async send(draft: ComposeDraft): Promise<SendResult> {
    const callsign = this.requireCallsign();

    const problems = validateDraft(draft);
    if (problems.length > 0) {
      return { sent: false, problems: problems.map((p) => p.message) };
    }

    const api = this.requireApi();
    // Saved before sending: if the post fails, the operator still has their
    // message rather than having watched it vanish.
    this.save(draft);

    const stored = this.opts.store.get(callsign, draft.id);
    const attachments = stored?.attachments ?? [];

    // Refused, not sent silently. On a forward the draft lists the original's
    // attachment NAMES immediately, while the BYTES are fetched from Pat
    // afterwards -- so a fetch that failed leaves a draft claiming files the
    // store does not have. Sending then quietly drops them, and the operator
    // has every reason to believe they went.
    const missing = draft.attachments
      .map((file) => file.name)
      .filter((name) => !attachments.some((stored) => stored.name === name));
    if (missing.length > 0) {
      return {
        sent: false,
        problems: [
          `These attachments could not be read and the message was not sent: ${missing.join(", ")}. ` +
            `Remove them or attach them again.`,
        ],
      };
    }

    const files = attachments.map((file) => ({
      field: "files",
      filename: file.name,
      contentType: file.contentType,
      bytes: file.bytes,
    }));

    await api.postMessage(draftToFields(draft, this.now().toISOString()), files);

    // Only once Pat has it: the draft is the only copy until this point.
    this.opts.store.delete(callsign, draft.id);
    this.announce();
    this.opts.onLog?.(`Queued a message to ${draft.to} in the outbox`);
    this.opts.onQueued();

    return { sent: true, problems: [] };
  }

  /**
   * Takes a message back out of the outbox for editing.
   *
   * It becomes a draft, and the queued copy is removed: from here it is an
   * ordinary unsent message that goes out only when Send is pressed again. The
   * alternative -- editing while the original stays queued -- would put the old
   * version on the air if a session started mid-edit, and the corrected one
   * after it.
   *
   * Ordered so a failure can never lose the message or send it twice: the
   * draft (attachment bytes included) is stored BEFORE the queued copy is
   * removed, and if Pat will not remove it the draft is dropped again, leaving
   * things exactly as they were.
   */
  async editQueued(mid: string): Promise<ComposeDraft> {
    if (this.opts.sessionBusy?.()) {
      throw new Error("A Winlink session is in progress. Edit the message after it ends.");
    }
    const callsign = this.requireCallsign();
    const api = this.requireApi();
    if (!this.opts.loadMessage || !this.opts.removeQueued) throw new Error("The mailbox is not ready yet.");

    const message = await this.opts.loadMessage("out", mid);
    if (!message) throw new Error("That message is no longer in the Outbox. It may already have been sent.");

    const files: DraftAttachment[] = [];
    for (const file of message.attachments) {
      const fetched = await api.getAttachment("out", mid, file.name);
      files.push({ name: fetched.name, contentType: fetched.contentType, bytes: fetched.bytes });
    }

    const draft = { ...draftFromQueued(cryptoId(), message), attachments: files.map(describe) };
    this.opts.store.save(callsign, draft, files, this.now());

    let removed = false;
    try {
      removed = await this.opts.removeQueued(mid);
    } finally {
      if (!removed) this.opts.store.delete(callsign, draft.id);
    }
    if (!removed) {
      throw new Error("The message could not be taken out of the Outbox, so it was left there unchanged.");
    }

    this.announce();
    this.opts.onLog?.(`Moved a queued message to ${draft.to} back to Drafts for editing`);
    return draft;
  }

  /**
   * Acknowledges a message.
   *
   * One click, straight to the outbox, no compose window: this is what
   * Winlink Express does, and it is why the generated text is the feature
   * rather than a starting point.
   */
  async acknowledge(box: MailBox, mid: string): Promise<void> {
    const callsign = this.requireCallsign();
    const api = this.requireApi();

    const message = this.opts.getMessage(box, mid);
    if (!message) throw new Error("That message is no longer in the mailbox.");

    const ack = buildAcknowledgement(cryptoId(), message, {
      mycall: callsign,
      acknowledgedAt: this.now().toISOString(),
    });

    // Never written to the draft store: it is complete by construction and the
    // operator never sees it before it goes.
    await api.postMessage(draftToFields(ack, this.now().toISOString()), []);
    this.opts.onLog?.(`Acknowledged ${mid} to ${ack.to}`);
    this.opts.onQueued();
  }

  private announce(): void {
    this.opts.onDraftsChanged(this.list());
  }

  /** Drops stored attachments the draft no longer lists, keeping the rest. */
  private keepNamed(stored: readonly DraftAttachment[], names: readonly string[]): DraftAttachment[] {
    const wanted = new Set(names);
    return stored.filter((file) => wanted.has(file.name));
  }
}

function describe(file: DraftAttachment) {
  return { name: file.name, contentType: file.contentType, sizeBytes: file.bytes.length };
}

/** A local draft id. Never a Winlink MID -- Pat mints that at send. */
export function cryptoId(): string {
  return globalThis.crypto.randomUUID();
}
