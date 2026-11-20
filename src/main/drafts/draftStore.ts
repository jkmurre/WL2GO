// Unsent messages.
//
// A SEPARATE DATABASE from the mailbox cache, and that separation is the point.
// mailbox.db is derived state: "Rebuild index" clears it and a schema change
// drops it wholesale, both safe because every row mirrors a file Pat owns. A
// draft is the opposite -- it exists nowhere else, and losing one to a cache
// rebuild would be inexcusable.
//
// The invariant, stated once: mailbox.db is disposable, drafts.db is not.
//
// Drafts also never reach Pat. Pat has four folders and no drafts among them,
// and its outbox means "will transmit on the next connection" -- so parking an
// unfinished message there would eventually send it. Nothing here is visible to
// Pat until the operator presses Send.
//
// No Electron import, so it is testable under `node --test`.

import { DatabaseSync } from "node:sqlite";
import type { ComposeDraft } from "../../shared/composeModel.ts";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (
  id         TEXT    NOT NULL PRIMARY KEY,
  callsign   TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  to_field   TEXT    NOT NULL,
  cc_field   TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  p2p_only   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_by_callsign ON drafts (callsign, updated_at DESC);

-- Attachment CONTENT, not a path to it. A draft whose attachment cannot be sent
-- because the operator moved or deleted the file is a bad failure on the day it
-- matters. Winlink attachments are small by necessity, and Pat re-encodes
-- images anyway, so the cost of copying them is trivial.
--
-- (This is not a reversal of "do not BLOB attachments into SQLite" -- that rule
-- is about the mailbox MIRROR, where the bytes already exist in Pat's mailbox.)
CREATE TABLE IF NOT EXISTS draft_attachments (
  draft_id     TEXT    NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  bytes        BLOB    NOT NULL,
  PRIMARY KEY (draft_id, position)
);
`;

/** One attachment, content included. */
export interface DraftAttachment {
  name: string;
  contentType: string;
  bytes: Buffer;
}

/** A draft as the message list needs it. */
export interface DraftSummary {
  id: string;
  updatedAt: string;
  to: string;
  subject: string;
  /** The start of the body, so an untitled draft is still recognisable. */
  preview: string;
  attachmentCount: number;
}

export interface StoredDraft {
  draft: ComposeDraft;
  attachments: DraftAttachment[];
}

interface DraftRow {
  id: string;
  updated_at: string;
  to_field: string;
  cc_field: string;
  subject: string;
  body: string;
  p2p_only: number;
}

/** Enough of the body to recognise a draft by, on one line. */
function previewOf(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export class DraftStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Without this the attachment cascade below is silently inert.
    this.db.exec("PRAGMA foreign_keys = ON");
    this.applySchema();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Creates or updates a draft, replacing its attachments wholesale.
   *
   * Whole-draft replacement rather than field-level updates: compose holds the
   * entire message in memory and saves the lot, so a partial update could only
   * ever produce a draft that does not match what is on screen.
   */
  save(callsign: string, draft: ComposeDraft, attachments: readonly DraftAttachment[], now = new Date()): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO drafts (id, callsign, updated_at, to_field, cc_field, subject, body, p2p_only)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             callsign = excluded.callsign,
             updated_at = excluded.updated_at,
             to_field = excluded.to_field,
             cc_field = excluded.cc_field,
             subject = excluded.subject,
             body = excluded.body,
             p2p_only = excluded.p2p_only`,
        )
        .run(
          draft.id,
          callsign,
          now.toISOString(),
          draft.to,
          draft.cc,
          draft.subject,
          draft.body,
          draft.p2pOnly ? 1 : 0,
        );

      this.db.prepare(`DELETE FROM draft_attachments WHERE draft_id = ?`).run(draft.id);

      const insert = this.db.prepare(
        `INSERT INTO draft_attachments (draft_id, position, name, content_type, bytes) VALUES (?, ?, ?, ?, ?)`,
      );
      attachments.forEach((file, position) => {
        insert.run(draft.id, position, file.name, file.contentType, file.bytes);
      });
    });
  }

  get(callsign: string, id: string): StoredDraft | null {
    const row = this.db
      .prepare(
        `SELECT id, updated_at, to_field, cc_field, subject, body, p2p_only
           FROM drafts WHERE callsign = ? AND id = ?`,
      )
      .get(callsign, id) as unknown as DraftRow | undefined;

    if (!row) return null;

    const files = this.db
      .prepare(
        `SELECT name, content_type, bytes FROM draft_attachments WHERE draft_id = ? ORDER BY position ASC`,
      )
      .all(id) as unknown as { name: string; content_type: string; bytes: Uint8Array }[];

    const attachments = files.map((file) => ({
      name: file.name,
      contentType: file.content_type,
      // SQLite hands back a Uint8Array; everything downstream expects a Buffer.
      bytes: Buffer.from(file.bytes),
    }));

    return {
      draft: {
        id: row.id,
        to: row.to_field,
        cc: row.cc_field,
        subject: row.subject,
        body: row.body,
        p2pOnly: row.p2p_only !== 0,
        attachments: attachments.map((file) => ({
          name: file.name,
          contentType: file.contentType,
          sizeBytes: file.bytes.length,
        })),
      },
      attachments,
    };
  }

  /** Every draft for one operator, most recently edited first. */
  list(callsign: string): DraftSummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.updated_at, d.to_field, d.subject, d.body,
                (SELECT COUNT(*) FROM draft_attachments a WHERE a.draft_id = d.id) AS attachment_count
           FROM drafts d WHERE d.callsign = ? ORDER BY d.updated_at DESC`,
      )
      .all(callsign) as unknown as (DraftRow & { attachment_count: number })[];

    return rows.map((row) => ({
      id: row.id,
      updatedAt: row.updated_at,
      to: row.to_field,
      subject: row.subject,
      preview: previewOf(row.body),
      attachmentCount: Number(row.attachment_count),
    }));
  }

  delete(callsign: string, id: string): boolean {
    const result = this.db.prepare(`DELETE FROM drafts WHERE callsign = ? AND id = ?`).run(callsign, id);
    return Number(result.changes) > 0;
  }

  count(callsign: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE callsign = ?`)
      .get(callsign) as unknown as { n: number };
    return Number(row.n);
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
   * Creates the schema.
   *
   * Deliberately unlike the mailbox cache, which drops and rebuilds on any
   * version mismatch. There is nothing to rebuild drafts FROM, so a future
   * schema change here has to migrate rather than discard -- and this is the
   * place a later version will need to notice that.
   */
  private applySchema(): void {
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}
