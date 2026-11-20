// Keeps the local cache in step with Pat's mailbox.
//
// Reconciles rather than streams, because Pat gives us no choice: the only
// mailbox event on /ws is {"UpdateMailbox":true} (api/wshub.go:143-151), which
// carries no box, no MID and no operation. Finding out what changed means
// listing the folders and diffing.
//
// That listing is not cheap. Pat reads every attachment of every message to
// produce it (fbb/message.go:352), so the cost is O(bytes on disk), not
// O(message count). Everything here exists to make sure we pay it as rarely as
// correctness allows: triggers are coalesced, reconciles never overlap, and our
// own writes do not provoke one.
//
// No Electron import: this runs under `node --test`. moduleBoundary.test.ts
// enforces it.

import type {
  MailBox,
  MailFolderCounts,
  MailMessage,
  MailMessageSummary,
  MailSearchResult,
  MoveTarget,
  RecentContact,
  UserFolder,
} from "../../shared/ipcContract.ts";
import { MAIL_BOXES } from "../../shared/ipcContract.ts";
import { collectRecentContacts } from "../../shared/addressCompletion.ts";
import { mapPatFolder, mapPatMessage } from "./patMessageMapper.ts";
import type { MailboxDb } from "./mailboxDb.ts";
import type { FolderStore } from "../folders/folderStore.ts";

/** The Pat folders a message can be moved INTO. Never the Outbox. */
type MovableBox = "in" | "sent" | "archive";

/** The slice of PatApiClient this needs. Narrow, so tests need no HTTP. */
export interface MailboxApi {
  getMailbox(box: string): Promise<unknown[]>;
  getMessage(box: string, mid: string): Promise<unknown>;
  setRead(box: string, mid: string, read: boolean): Promise<void>;
  moveMessage(fromBox: string, mid: string, toBox: string): Promise<void>;
  deleteMessage(box: string, mid: string): Promise<void>;
}

export interface MailboxSyncOptions {
  db: MailboxDb;
  /** Null while Pat is not running; a sync then simply does not happen. */
  getApi: () => MailboxApi | null;
  /** Whose mailbox Pat is currently serving. Empty before onboarding. */
  getCallsign: () => string;
  onChanged: (counts: MailFolderCounts, boxes: MailBox[]) => void;
  /**
   * The operator's own folders. Optional so the cache works without them; when
   * present, a filed message is listed and counted under its folder rather
   * than under Archive, where it actually lives.
   */
  folders?: FolderStore | null;
  /** The folder list or any folder's contents changed. */
  onFoldersChanged?: () => void;
  onLog?: (message: string) => void;
  onError?: (message: string) => void;
  /** Collapses a burst of triggers into one reconcile. */
  coalesceMs?: number;
  /**
   * How long our own writes keep us from reacting to the mailbox events they
   * cause. See notifyExternalChange.
   */
  selfWriteQuietMs?: number;
  /** Injectable clock, so the quiet window is testable without waiting. */
  now?: () => number;
}

const DEFAULT_COALESCE_MS = 300;
const DEFAULT_SELF_WRITE_QUIET_MS = 1500;

/**
 * Plenty for an operator's working circle, and small enough that the renderer
 * can filter it on every keystroke without noticing.
 */
const RECENT_CONTACT_LIMIT = 500;

export class MailboxSync {
  private readonly opts: MailboxSyncOptions;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  /** Boxes waiting to be reconciled. Empty set never runs. */
  private pending = new Set<MailBox>();
  /** No mailbox event before this time is ours to react to. */
  private quietUntil = 0;

  constructor(options: MailboxSyncOptions) {
    this.opts = options;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /**
   * Pat says the mailbox changed.
   *
   * Deferred rather than dropped when it lands inside the quiet window. Dropping
   * would be wrong: a message can genuinely arrive in the moment after we mark
   * one read, and that operator would not see it until something else happened.
   * Deferring to the end of the window collapses a burst of our own writes into
   * a single reconcile while still catching anything real underneath them.
   */
  notifyExternalChange(): void {
    this.request(MAIL_BOXES);
  }

  /** Reconciles every folder. Used at startup and after a session. */
  syncAll(): void {
    this.request(MAIL_BOXES);
  }

  private request(boxes: readonly MailBox[]): void {
    for (const box of boxes) this.pending.add(box);

    if (this.running) {
      // Something changed mid-pass. Go round again rather than interleaving.
      this.rerun = true;
      return;
    }
    if (this.timer) return;

    // Never earlier than the end of the quiet window: a reconcile that starts
    // inside it would be reacting to our own write.
    const delay = Math.max(this.opts.coalesceMs ?? DEFAULT_COALESCE_MS, this.quietUntil - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
  }

  /** Runs anything pending now and waits for it. For tests, and for quit. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.drain();
      return;
    }
    await this.running;
  }

  private async drain(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }

    this.running = (async () => {
      do {
        this.rerun = false;
        const boxes = [...this.pending];
        this.pending.clear();
        if (boxes.length === 0) return;
        try {
          await this.reconcile(boxes);
        } catch (err: unknown) {
          this.opts.onError?.(err instanceof Error ? err.message : String(err));
        }
      } while (this.rerun);
    })();

    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  /**
   * Brings the named folders into line with Pat and reports what moved.
   *
   * Diff-based and idempotent: a redundant trigger costs a listing, never
   * corruption.
   */
  async reconcile(boxes: readonly MailBox[]): Promise<MailBox[]> {
    const api = this.opts.getApi();
    const callsign = this.opts.getCallsign();
    // Nothing to mirror into: Pat serves <mbox>/<MYCALL>, so without a callsign
    // there is no mailbox, and rows keyed on "" would be someone else's later.
    if (!api || !callsign) return [];

    const changed: MailBox[] = [];
    for (const box of boxes) {
      const result = await this.reconcileFolder(api, callsign, box);

      // Abandoned rather than continued: see the note in reconcileFolder.
      if (result === "stale") {
        this.opts.onLog?.("Station identity changed mid-sync; abandoning this pass");
        this.request(boxes);
        break;
      }
      if (result === "changed") changed.push(box);
    }

    if (changed.length) {
      this.changed(callsign, changed);
    }
    return changed;
  }

  private async reconcileFolder(
    api: MailboxApi,
    callsign: string,
    box: MailBox,
  ): Promise<"changed" | "unchanged" | "stale"> {
    const listing = await api.getMailbox(box);

    // Checked here, between the listing and the first write, rather than once at
    // the top of the pass. A folder listing can take seconds, and an identity
    // change during one restarts Pat: it is then serving a DIFFERENT operator's
    // mailbox, and writing this listing would file their messages under the
    // previous callsign. The identity change triggers its own sync, so there is
    // nothing to salvage here.
    if (this.opts.getCallsign() !== callsign) return "stale";

    const { messages, skipped } = mapPatFolder(box, listing);
    if (skipped) {
      this.opts.onLog?.(`Skipped ${skipped} unreadable message(s) in ${box}`);
    }

    const cached = this.opts.db.folderIndex(callsign, box);

    // Gone from Pat means gone from us: deleted, or moved to another folder,
    // which is a rename and so shows up as an arrival there in the same pass.
    const live = new Set(messages.map((m) => m.mid));
    const removed = [...cached.keys()].filter((mid) => !live.has(mid));

    const { inserted, updated } = this.opts.db.upsertMessages(callsign, messages);
    const deleted = this.opts.db.deleteMessages(callsign, box, removed);

    // Against the LIVE listing, never the cache: "Rebuild index" empties the
    // cache first, and pruning against that would un-file everything.
    const pruned = box === "archive" ? (this.opts.folders?.prune(callsign, live) ?? 0) : 0;
    if (pruned) this.opts.onLog?.(`Forgot ${pruned} filing(s) for messages no longer in Archive`);

    // "updated" counts rows written, not rows that differ -- an unchanged folder
    // rewrites identical values. Compare against what we held instead, so an
    // idle reconcile reports no change and the UI does not churn.
    const flagsChanged = messages.some((m) => {
      const before = cached.get(m.mid);
      return before !== undefined && before.unread !== m.unread;
    });

    if (inserted || deleted || flagsChanged || pruned) {
      this.opts.onLog?.(
        `Synced ${box}: ${inserted} new, ${deleted} removed, ${messages.length} total (${updated} rechecked)`,
      );
      return "changed";
    }
    return "unchanged";
  }

  /**
   * One message's body, fetched from Pat the first time and cached after.
   *
   * Lazy on purpose. Fetching every body up front would run Pat's
   * single-message handler once per message, and each of those re-reads that
   * message's attachments -- turning a first sync into a full read of the
   * mailbox for text almost none of which will be opened.
   */
  async loadBody(box: MailBox, mid: string): Promise<MailMessage | null> {
    const callsign = this.opts.getCallsign();
    if (!callsign) return null;

    const cached = this.opts.db.getMessage(callsign, box, mid);
    if (cached && cached.body !== null) return cached;

    const api = this.opts.getApi();
    if (!api) return cached;

    const fetched = mapPatMessage(box, await api.getMessage(box, mid));
    if (!fetched) return cached;

    if (fetched.body !== null) {
      // The row may have vanished under us; store it if it did.
      if (!this.opts.db.setBody(callsign, box, mid, fetched.body)) {
        this.opts.db.upsertMessages(callsign, [fetched]);
      }
    }
    return this.opts.db.getMessage(callsign, box, mid) ?? fetched;
  }

  /**
   * Marks a message read in Pat and in the cache.
   *
   * Written through and then suppressed. Pat's SetUnread rewrites the whole
   * .b2f file (mailbox/syncdir.go:277-286), which trips its own fsnotify watch
   * and sends us {"UpdateMailbox":true} -- so without the quiet window, reading
   * ten messages would trigger ten full folder listings, one per click, spaced
   * far too widely for any debounce to absorb.
   */
  async markRead(box: MailBox, mid: string, read: boolean): Promise<void> {
    const callsign = this.opts.getCallsign();
    if (!callsign) return;

    const api = this.opts.getApi();
    if (!api) throw new Error("The protocol engine is not running.");

    // Set before the call, not after: Pat's write -- and the event it causes --
    // happens while we are still awaiting the response.
    this.quiet();

    try {
      await api.setRead(box, mid, read);
    } catch (err: unknown) {
      // Pat's readHandler has no os.IsNotExist check (api/mailbox.go:220-223),
      // so a message that moved or was deleted underneath us arrives as a 500
      // rather than a 404. That is a stale cache, not a failure to report:
      // re-sync and let the operator see the mailbox as it actually is.
      this.opts.onLog?.(`Could not mark ${mid} in ${box}; re-syncing the folder`);
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      this.request([box]);
      return;
    }

    this.quiet();
    if (this.opts.db.setUnread(callsign, box, mid, !read)) {
      this.changed(callsign, [box]);
    }
  }

  /**
   * Discards the cache for the current operator and rebuilds it from Pat.
   *
   * The recovery path for a cache that has drifted or been corrupted. Safe by
   * construction: everything here is a mirror of files Pat owns.
   */
  async rebuild(): Promise<void> {
    const callsign = this.opts.getCallsign();
    if (!callsign) return;

    this.opts.db.clearCallsign(callsign);
    this.opts.onLog?.(`Rebuilding the message index for ${callsign}`);
    this.changed(callsign, [...MAIL_BOXES]);
    await this.reconcile(MAIL_BOXES);
  }

  /**
   * Moves a message to Archive, which is what Delete means everywhere but
   * Archive itself.
   *
   * Reversible by construction: Archive is one of Pat's four real folders, so
   * this is a rename on disk and the message can be moved back. Nothing in
   * WL2GO destroys mail on a single click.
   */
  async archiveMessage(fromBox: MailBox, mid: string): Promise<void> {
    await this.moveBetweenBoxes(fromBox, mid, "archive");
  }

  /**
   * Moves a message to Inbox, Sent, Archive or one of the operator's folders.
   *
   * A user folder is a label over Archive, so filing a message archives it
   * first and then records the label; moving it out to a Pat folder moves the
   * file and drops the label. The label is only touched once Pat has done its
   * part, so a failed move never leaves a message filed somewhere it is not.
   */
  async move(fromBox: MailBox, mid: string, target: MoveTarget): Promise<void> {
    const callsign = this.opts.getCallsign();
    if (!callsign) return;
    const folders = this.opts.folders;

    if ("folderId" in target) {
      if (!folders) throw new Error("Folders are not available.");
      if (!folders.getFolder(callsign, target.folderId)) throw new Error("That folder no longer exists.");
      if (fromBox !== "archive" && !(await this.moveBetweenBoxes(fromBox, mid, "archive"))) return;
      folders.fileMessage(callsign, mid, target.folderId);
      this.changed(callsign, ["archive"]);
      return;
    }

    if (target.box === "archive" && fromBox === "archive") {
      // Out of a user folder, back into plain Archive: only the label changes.
      if (folders?.unfile(callsign, mid)) this.changed(callsign, ["archive"]);
      return;
    }

    if (!(await this.moveBetweenBoxes(fromBox, mid, target.box))) return;
    if (fromBox === "archive" && folders?.unfile(callsign, mid)) this.changed(callsign, ["archive"]);
  }

  /** A move on disk between two of Pat's folders. Resolves false if Pat refused it. */
  private async moveBetweenBoxes(fromBox: MailBox, mid: string, toBox: MovableBox): Promise<boolean> {
    const callsign = this.opts.getCallsign();
    if (!callsign) return false;

    const api = this.opts.getApi();
    if (!api) throw new Error("The protocol engine is not running.");
    if (fromBox === toBox) return true;

    const existing = this.opts.db.getMessage(callsign, fromBox, mid);

    // Opened before the call, as in markRead: Pat's rename fires its own watch
    // while we are still awaiting the response.
    this.quiet();
    try {
      await api.moveMessage(fromBox, mid, toBox);
    } catch (err: unknown) {
      this.opts.onLog?.(`Could not move ${mid} from ${fromBox} to ${toBox}; re-syncing`);
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      this.request([fromBox, toBox]);
      return false;
    }
    this.quiet();

    // Mirrored rather than re-listed. The move preserves the MID -- it is the
    // filename stem -- so the moved row is the same message, body and all,
    // and re-fetching a body we already have would be pure waste.
    this.opts.db.deleteMessages(callsign, fromBox, [mid]);
    if (existing) {
      this.opts.db.upsertMessages(callsign, [{ ...existing, box: toBox }]);
    }
    this.changed(callsign, [fromBox, toBox]);
    return true;
  }

  /**
   * Destroys a message.
   *
   * Pat's delete is os.Remove with no trash anywhere in the stack
   * (api/mailbox.go:103-122), so this is final. Reached from Archive after the
   * operator has confirmed, and from Edit on a queued message once its copy is
   * safely in Drafts. Resolves false if Pat refused, so that caller can undo.
   */
  async deleteMessage(box: MailBox, mid: string): Promise<boolean> {
    const callsign = this.opts.getCallsign();
    if (!callsign) return false;

    const api = this.opts.getApi();
    if (!api) throw new Error("The protocol engine is not running.");

    this.quiet();
    try {
      await api.deleteMessage(box, mid);
    } catch (err: unknown) {
      // A 404 means it was already gone, which is the outcome that was wanted;
      // either way the cache is what is wrong, so re-sync rather than report.
      this.opts.onLog?.(`Could not delete ${mid} from ${box}; re-syncing the folder`);
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      this.request([box]);
      return false;
    }
    this.quiet();

    this.opts.db.deleteMessages(callsign, box, [mid]);
    if (box === "archive") this.opts.folders?.unfile(callsign, mid);
    this.changed(callsign, [box]);
    return true;
  }

  /** Everyone in the cached traffic, newest first, for compose suggestions. */
  recentContacts(): RecentContact[] {
    const callsign = this.opts.getCallsign();
    if (!callsign) return [];
    return collectRecentContacts(this.opts.db.contactRows(callsign), callsign, RECENT_CONTACT_LIMIT);
  }

  /** Full-text search across every folder. Served from the cache. */
  search(query: string): MailSearchResult[] {
    const callsign = this.opts.getCallsign();
    if (!callsign) return [];
    const results = this.opts.db.search(callsign, query);
    const folders = this.opts.folders;
    if (!folders) return results;

    const filed = folders.filedMap(callsign);
    const names = new Map(folders.listFolders(callsign).map((f) => [f.id, f.name]));
    return results.map((result) => {
      const folderId = result.box === "archive" ? filed.get(result.mid) : undefined;
      const folderName = folderId ? names.get(folderId) : undefined;
      return folderName ? { ...result, folderName } : result;
    });
  }

  /**
   * Reads a folder straight out of the cache. Never touches Pat.
   *
   * Archive lists only what is NOT filed in a user folder: a filed message is
   * shown in its folder, and showing it twice would make the folder pointless.
   */
  listFolder(box: MailBox): MailMessageSummary[] {
    const callsign = this.opts.getCallsign();
    if (!callsign) return [];
    const rows = this.opts.db.listFolder(callsign, box);
    if (box !== "archive" || !this.opts.folders) return rows;
    const filed = this.opts.folders.filedMap(callsign);
    return rows.filter((row) => !filed.has(row.mid));
  }

  /** One user folder's messages: the archived rows filed into it. */
  listUserFolder(folderId: string): MailMessageSummary[] {
    const callsign = this.opts.getCallsign();
    if (!callsign || !this.opts.folders) return [];
    const filed = this.opts.folders.filedMap(callsign);
    return this.opts.db.listFolder(callsign, "archive").filter((row) => filed.get(row.mid) === folderId);
  }

  counts(): MailFolderCounts {
    return this.countsFor(this.opts.getCallsign());
  }

  /** The operator's folders, alphabetical, with what each holds. */
  userFolders(): UserFolder[] {
    const callsign = this.opts.getCallsign();
    const folders = this.opts.folders;
    if (!callsign || !folders) return [];

    const tally = new Map<string, { total: number; unread: number }>();
    const filed = folders.filedMap(callsign);
    // Counted against the cache, not the filings: a filing whose message has
    // not been listed yet is not a message the operator can open.
    for (const [mid, ref] of this.opts.db.folderIndex(callsign, "archive")) {
      const folderId = filed.get(mid);
      if (!folderId) continue;
      const count = tally.get(folderId) ?? { total: 0, unread: 0 };
      count.total += 1;
      if (ref.unread) count.unread += 1;
      tally.set(folderId, count);
    }
    return folders.listFolders(callsign).map((f) => ({ ...f, ...(tally.get(f.id) ?? { total: 0, unread: 0 }) }));
  }

  createFolder(name: string): UserFolder {
    const { callsign, folders } = this.requireFolders();
    const folder = folders.create(callsign, name);
    this.opts.onFoldersChanged?.();
    return { ...folder, total: 0, unread: 0 };
  }

  renameFolder(id: string, name: string): void {
    const { callsign, folders } = this.requireFolders();
    folders.rename(callsign, id, name);
    this.opts.onFoldersChanged?.();
  }

  /** Never deletes mail: the folder's messages fall back into Archive. */
  deleteFolder(id: string): void {
    const { callsign, folders } = this.requireFolders();
    if (folders.remove(callsign, id)) this.changed(callsign, ["archive"]);
  }

  private requireFolders(): { callsign: string; folders: FolderStore } {
    const callsign = this.opts.getCallsign();
    if (!callsign) throw new Error("Set your callsign before creating folders.");
    if (!this.opts.folders) throw new Error("Folders are not available.");
    return { callsign, folders: this.opts.folders };
  }

  /** The cache's counts, with filed messages taken out of Archive's. */
  private countsFor(callsign: string): MailFolderCounts {
    const counts = this.opts.db.counts(callsign);
    const folders = this.opts.folders;
    if (!callsign || !folders) return counts;

    const filed = folders.filedMap(callsign);
    if (filed.size === 0) return counts;
    let total = counts.archive.total;
    let unread = counts.archive.unread;
    for (const [mid, ref] of this.opts.db.folderIndex(callsign, "archive")) {
      if (!filed.has(mid)) continue;
      total -= 1;
      if (ref.unread) unread -= 1;
    }
    return { ...counts, archive: { total, unread } };
  }

  /** Reports a cache change, and a folder change when Archive was involved. */
  private changed(callsign: string, boxes: MailBox[]): void {
    this.opts.onChanged(this.countsFor(callsign), boxes);
    if (boxes.includes("archive")) this.opts.onFoldersChanged?.();
  }

  private quiet(): void {
    this.quietUntil = this.now() + (this.opts.selfWriteQuietMs ?? DEFAULT_SELF_WRITE_QUIET_MS);
  }

  /** Whether a mailbox event arriving now would be treated as our own doing. */
  isQuiet(): boolean {
    return this.now() < this.quietUntil;
  }
}
