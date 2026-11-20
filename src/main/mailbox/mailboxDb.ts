// The local mirror of Pat's mailbox.
//
// node:sqlite deliberately, not better-sqlite3: it is part of Node, so there is
// no native module to rebuild against Electron's ABI and nothing added to the
// dependency tree. Only DatabaseSync, exec, prepare, run/get/all and
// ON CONFLICT DO UPDATE are used -- all confirmed present in both the Node that
// runs the tests and the Node 24 that Electron 43 ships.
//
// No Electron import, by design: these tests run under `node --test`, outside
// Electron entirely. moduleBoundary.test.ts enforces it.

import { DatabaseSync } from "node:sqlite";
import type { ContactRow } from "../../shared/addressCompletion.ts";
import type {
  MailAttachment,
  MailBox,
  MailFolderCount,
  MailFolderCounts,
  MailMessage,
  MailMessageSummary,
  MailSearchResult,
} from "../../shared/ipcContract.ts";
import { MAIL_BOXES } from "../../shared/ipcContract.ts";

/**
 * Bumped on any schema change. The cache is derived state -- it can always be
 * rebuilt from Pat in seconds -- so ANY version that is not this one is dropped
 * and refilled rather than migrated. That covers an upgrade and a downgrade
 * with the same code path, and writing migrations for a cache would buy
 * nothing.
 */
const SCHEMA_VERSION = 2;

/** How many search hits are worth returning to a list the operator scans. */
const SEARCH_LIMIT = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  callsign    TEXT    NOT NULL,
  box         TEXT    NOT NULL,
  mid         TEXT    NOT NULL,
  date        TEXT    NOT NULL,
  from_addr   TEXT    NOT NULL,
  to_addrs    TEXT    NOT NULL,
  cc_addrs    TEXT    NOT NULL,
  subject     TEXT    NOT NULL,
  unread      INTEGER NOT NULL,
  p2p_only    INTEGER NOT NULL,
  attachments TEXT    NOT NULL,
  body        TEXT,
  PRIMARY KEY (callsign, box, mid)
);
CREATE INDEX IF NOT EXISTS messages_folder ON messages (callsign, box, date DESC);

-- Full-text search. External-content, so the message text is stored once:
-- messages is an ordinary rowid table, which is what lets FTS5 point at it
-- rather than keeping a second copy. FTS5 is compiled into both the Node that
-- runs the tests and the SQLite inside the packaged Electron.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject,
  from_addr,
  body,
  content='messages',
  content_rowid='rowid'
);

-- External content means FTS5 does not observe writes on its own; these keep it
-- in step. All three are needed: upsertMessages inserts on a new message and
-- updates on a re-sync, and reconcile deletes messages that left the folder.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, subject, from_addr, body)
    VALUES (new.rowid, new.subject, new.from_addr, new.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, from_addr, body)
    VALUES ('delete', old.rowid, old.subject, old.from_addr, old.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, from_addr, body)
    VALUES ('delete', old.rowid, old.subject, old.from_addr, old.body);
  INSERT INTO messages_fts (rowid, subject, from_addr, body)
    VALUES (new.rowid, new.subject, new.from_addr, new.body);
END;
`;

/** What a folder currently holds, keyed by MID, for diffing against Pat. */
export interface CachedRef {
  unread: boolean;
  hasBody: boolean;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

/** A row as SQLite hands it back. Null-prototype, so it is mapped, never spread. */
interface MessageRow {
  box: string;
  mid: string;
  date: string;
  from_addr: string;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  unread: number;
  p2p_only: number;
  attachments: string;
  body: string | null;
}

/**
 * Turns what the operator typed into a safe FTS5 query.
 *
 * Necessary, not defensive. Operator input goes straight into FTS5's own query
 * grammar, where a lone double quote, a stray bracket or a trailing "-" is a
 * syntax error that THROWS rather than returning nothing -- so typing half a
 * phrase would surface as an error mid-keystroke.
 *
 * Every character that carries meaning to FTS5 is dropped rather than escaped.
 * An operator searching their mail is looking for words, and silently handing
 * them boolean operators they did not know they had typed is worse than
 * ignoring them. Each surviving token is quoted, so it cannot be read as an
 * operator, and given a "*" for prefix matching -- which is what makes search
 * feel live while it is still being typed.
 *
 * Returns null when nothing searchable is left, which the caller treats as
 * "no query" rather than "no results".
 */
export function toFtsQuery(input: string): string | null {
  // Unicode-aware: callsigns and English are not the only things in a mailbox.
  const tokens = input.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;

  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseAttachments(raw: string): MailAttachment[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): MailAttachment[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const name = record["name"];
      if (typeof name !== "string") return [];
      const size = record["sizeBytes"];
      return [{ name, sizeBytes: typeof size === "number" ? size : 0 }];
    });
  } catch {
    return [];
  }
}

function toMessage(row: MessageRow): MailMessage {
  return {
    box: row.box as MailBox,
    mid: row.mid,
    date: row.date,
    from: row.from_addr,
    to: parseStringArray(row.to_addrs),
    cc: parseStringArray(row.cc_addrs),
    subject: row.subject,
    unread: row.unread !== 0,
    p2pOnly: row.p2p_only !== 0,
    attachments: parseAttachments(row.attachments),
    body: row.body,
  };
}

function emptyCounts(): MailFolderCounts {
  const counts = {} as MailFolderCounts;
  for (const box of MAIL_BOXES) counts[box] = { total: 0, unread: 0 };
  return counts;
}

export class MailboxDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // WAL so a long folder reconcile does not block the reads the UI is making.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.applySchema();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Every message in a folder, newest first, without bodies.
   *
   * Ordered by the UTC-normalised date the mapper produces, so lexical order is
   * chronological order and the index can serve it directly.
   */
  listFolder(callsign: string, box: MailBox): MailMessageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT box, mid, date, from_addr, to_addrs, cc_addrs, subject, unread, p2p_only, attachments, NULL AS body
           FROM messages WHERE callsign = ? AND box = ? ORDER BY date DESC, mid ASC`,
      )
      .all(callsign, box) as unknown as MessageRow[];

    return rows.map(toMessage);
  }

  getMessage(callsign: string, box: MailBox, mid: string): MailMessage | null {
    const row = this.db
      .prepare(
        `SELECT box, mid, date, from_addr, to_addrs, cc_addrs, subject, unread, p2p_only, attachments, body
           FROM messages WHERE callsign = ? AND box = ? AND mid = ?`,
      )
      .get(callsign, box, mid) as unknown as MessageRow | undefined;

    return row ? toMessage(row) : null;
  }

  /**
   * Full-text search across every folder for one operator.
   *
   * Deliberately not scoped to the selected folder: the main reason to search
   * is that you cannot remember where something is. Each hit carries its box so
   * the UI can say where it found it.
   */
  search(callsign: string, query: string): MailSearchResult[] {
    const match = toFtsQuery(query);
    if (!match) return [];

    const rows = this.db
      .prepare(
        `SELECT m.box, m.mid, m.date, m.from_addr, m.to_addrs, m.cc_addrs, m.subject,
                m.unread, m.p2p_only, m.attachments, NULL AS body,
                snippet(messages_fts, 2, '', '', '…', 12) AS snippet
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ? AND m.callsign = ?
          ORDER BY m.date DESC
          LIMIT ?`,
      )
      .all(match, callsign, SEARCH_LIMIT) as unknown as (MessageRow & { snippet: string | null })[];

    return rows.map((row) => ({ ...toMessage(row), snippet: row.snippet ?? "" }));
  }

  /**
   * The address fields of every cached message, newest first.
   *
   * Every folder, and no bodies: this feeds compose suggestions, which need
   * only who and when.
   */
  contactRows(callsign: string): ContactRow[] {
    const rows = this.db
      .prepare(
        `SELECT date, from_addr, to_addrs, cc_addrs
           FROM messages WHERE callsign = ? ORDER BY date DESC, mid ASC`,
      )
      .all(callsign) as unknown as Pick<MessageRow, "date" | "from_addr" | "to_addrs" | "cc_addrs">[];

    return rows.map((row) => ({
      date: row.date,
      from: row.from_addr,
      to: parseStringArray(row.to_addrs),
      cc: parseStringArray(row.cc_addrs),
    }));
  }

  /** What the cache holds for one folder, for diffing a fresh listing against. */
  folderIndex(callsign: string, box: MailBox): Map<string, CachedRef> {
    const rows = this.db
      .prepare(`SELECT mid, unread, body IS NOT NULL AS has_body FROM messages WHERE callsign = ? AND box = ?`)
      .all(callsign, box) as unknown as { mid: string; unread: number; has_body: number }[];

    const index = new Map<string, CachedRef>();
    for (const row of rows) {
      index.set(row.mid, { unread: row.unread !== 0, hasBody: row.has_body !== 0 });
    }
    return index;
  }

  /**
   * Writes a batch of messages.
   *
   * The body is preserved on conflict rather than overwritten: these messages
   * come from the folder listing, which never carries one (api/mailbox.go:58-62).
   * Taking the incoming NULL would throw away a body we already paid to fetch,
   * every time the folder re-syncs.
   */
  upsertMessages(callsign: string, messages: readonly MailMessage[]): UpsertResult {
    if (messages.length === 0) return { inserted: 0, updated: 0 };

    const existing = this.db.prepare(
      `SELECT 1 FROM messages WHERE callsign = ? AND box = ? AND mid = ?`,
    );
    const upsert = this.db.prepare(
      `INSERT INTO messages
         (callsign, box, mid, date, from_addr, to_addrs, cc_addrs, subject, unread, p2p_only, attachments, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (callsign, box, mid) DO UPDATE SET
         date = excluded.date,
         from_addr = excluded.from_addr,
         to_addrs = excluded.to_addrs,
         cc_addrs = excluded.cc_addrs,
         subject = excluded.subject,
         unread = excluded.unread,
         p2p_only = excluded.p2p_only,
         attachments = excluded.attachments,
         body = COALESCE(excluded.body, messages.body)`,
    );

    let inserted = 0;
    let updated = 0;

    this.transaction(() => {
      for (const message of messages) {
        const seen = existing.get(callsign, message.box, message.mid) !== undefined;
        upsert.run(
          callsign,
          message.box,
          message.mid,
          message.date,
          message.from,
          JSON.stringify(message.to),
          JSON.stringify(message.cc),
          message.subject,
          message.unread ? 1 : 0,
          message.p2pOnly ? 1 : 0,
          JSON.stringify(message.attachments),
          message.body,
        );
        if (seen) updated += 1;
        else inserted += 1;
      }
    });

    return { inserted, updated };
  }

  deleteMessages(callsign: string, box: MailBox, mids: readonly string[]): number {
    if (mids.length === 0) return 0;

    const remove = this.db.prepare(`DELETE FROM messages WHERE callsign = ? AND box = ? AND mid = ?`);
    let deleted = 0;
    this.transaction(() => {
      for (const mid of mids) {
        deleted += Number(remove.run(callsign, box, mid).changes);
      }
    });
    return deleted;
  }

  /** Stores a body fetched on demand. Returns false if the row is gone. */
  setBody(callsign: string, box: MailBox, mid: string, body: string): boolean {
    const result = this.db
      .prepare(`UPDATE messages SET body = ? WHERE callsign = ? AND box = ? AND mid = ?`)
      .run(body, callsign, box, mid);
    return Number(result.changes) > 0;
  }

  setUnread(callsign: string, box: MailBox, mid: string, unread: boolean): boolean {
    const result = this.db
      .prepare(`UPDATE messages SET unread = ? WHERE callsign = ? AND box = ? AND mid = ?`)
      .run(unread ? 1 : 0, callsign, box, mid);
    return Number(result.changes) > 0;
  }

  counts(callsign: string): MailFolderCounts {
    const rows = this.db
      .prepare(
        `SELECT box, COUNT(*) AS total, SUM(unread) AS unread
           FROM messages WHERE callsign = ? GROUP BY box`,
      )
      .all(callsign) as unknown as { box: string; total: number; unread: number | null }[];

    const counts = emptyCounts();
    for (const row of rows) {
      if (!(row.box in counts)) continue;
      const count: MailFolderCount = { total: Number(row.total), unread: Number(row.unread ?? 0) };
      counts[row.box as MailBox] = count;
    }
    return counts;
  }

  /** Drops one operator's cache. The recovery path behind "Rebuild message index". */
  clearCallsign(callsign: string): number {
    return Number(this.db.prepare(`DELETE FROM messages WHERE callsign = ?`).run(callsign).changes);
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Creates or resets the schema.
   *
   * ANY version that is not the current one is dropped and rebuilt -- older as
   * well as newer. Everything here mirrors Pat's mailbox and refills from it in
   * seconds, so an upgrade should cost a re-sync rather than a migration to
   * write and maintain, and a downgrade should cost a re-sync rather than an
   * unopenable app and a mailbox the operator cannot read.
   */
  private applySchema(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as unknown as { user_version: number } | undefined;
    const version = Number(row?.user_version ?? 0);

    if (version !== SCHEMA_VERSION) {
      // Triggers and the FTS table first: both depend on `messages`.
      for (const trigger of ["messages_ai", "messages_ad", "messages_au"]) {
        this.db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      }
      this.db.exec("DROP TABLE IF EXISTS messages_fts");
      this.db.exec("DROP TABLE IF EXISTS messages");
    }

    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}
