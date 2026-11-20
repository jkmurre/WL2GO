// The operator's own mail folders.
//
// Pat has four folders and lists no others (api/mailbox.go:37-49), so a user
// folder is a LABEL over Pat's Archive: a filed message lives on disk in
// archive/, and this store records which folder it was filed into. Pat's own
// web UI still sees every message, in Archive.
//
// A SEPARATE DATABASE from the mailbox cache, for the same reason drafts.db is.
// mailbox.db is disposable -- "Rebuild index" clears it and a schema change
// drops it -- but the folders and what was filed into them exist nowhere else.
// So, unlike the cache, a version this code does not recognise is never
// dropped.
//
// No Electron import, so it is testable under `node --test`.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = 1;

/** Long enough for any sensible name, short enough to fit the sidebar. */
export const MAX_FOLDER_NAME_LENGTH = 64;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT NOT NULL PRIMARY KEY,
  callsign   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- "Nets" and "nets" side by side in the sidebar would only ever be a mistake.
CREATE UNIQUE INDEX IF NOT EXISTS folders_name ON folders (callsign, name COLLATE NOCASE);

-- Keyed by MID alone within a callsign: a MID is the filename stem, so it is
-- unique within archive/, which is the only place a filed message can be.
CREATE TABLE IF NOT EXISTS filed (
  callsign  TEXT NOT NULL,
  mid       TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  PRIMARY KEY (callsign, mid)
);
CREATE INDEX IF NOT EXISTS filed_by_folder ON filed (folder_id);
`;

export interface FolderRecord {
  id: string;
  name: string;
}

/**
 * Trims and validates a folder name, throwing a message fit to show the
 * operator as-is.
 */
export function normalizeFolderName(raw: unknown): string {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("A folder needs a name.");
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new Error(`Folder names can be at most ${MAX_FOLDER_NAME_LENGTH} characters.`);
  }
  return name;
}

export class FolderStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Off by default in SQLite, and the cascade is what makes deleting a folder
    // return its messages to Archive.
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    const row = this.db.prepare("PRAGMA user_version").get() as unknown as { user_version: number } | undefined;
    if (Number(row?.user_version ?? 0) < SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Alphabetical, the order the sidebar shows them in. */
  listFolders(callsign: string): FolderRecord[] {
    const rows = this.db
      .prepare(`SELECT id, name FROM folders WHERE callsign = ? ORDER BY name COLLATE NOCASE, id`)
      .all(callsign) as unknown as FolderRecord[];
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  getFolder(callsign: string, id: string): FolderRecord | null {
    const row = this.db
      .prepare(`SELECT id, name FROM folders WHERE callsign = ? AND id = ?`)
      .get(callsign, id) as unknown as FolderRecord | undefined;
    return row ? { id: row.id, name: row.name } : null;
  }

  create(callsign: string, rawName: string): FolderRecord {
    const name = normalizeFolderName(rawName);
    this.assertNameFree(callsign, name, null);
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO folders (id, callsign, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, callsign, name, new Date().toISOString());
    return { id, name };
  }

  rename(callsign: string, id: string, rawName: string): FolderRecord {
    const name = normalizeFolderName(rawName);
    if (!this.getFolder(callsign, id)) throw new Error("That folder no longer exists.");
    this.assertNameFree(callsign, name, id);
    this.db.prepare(`UPDATE folders SET name = ? WHERE callsign = ? AND id = ?`).run(name, callsign, id);
    return { id, name };
  }

  /**
   * Deletes a folder. Its messages are NOT deleted: they were in Archive all
   * along, and the cascade simply un-files them.
   */
  remove(callsign: string, id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM folders WHERE callsign = ? AND id = ?`).run(callsign, id).changes) > 0;
  }

  fileMessage(callsign: string, mid: string, folderId: string): void {
    if (!this.getFolder(callsign, folderId)) throw new Error("That folder no longer exists.");
    this.db
      .prepare(
        `INSERT INTO filed (callsign, mid, folder_id) VALUES (?, ?, ?)
         ON CONFLICT (callsign, mid) DO UPDATE SET folder_id = excluded.folder_id`,
      )
      .run(callsign, mid, folderId);
  }

  unfile(callsign: string, mid: string): boolean {
    return Number(this.db.prepare(`DELETE FROM filed WHERE callsign = ? AND mid = ?`).run(callsign, mid).changes) > 0;
  }

  /** Every filed message for one operator, MID to folder id. */
  filedMap(callsign: string): Map<string, string> {
    const rows = this.db
      .prepare(`SELECT mid, folder_id FROM filed WHERE callsign = ?`)
      .all(callsign) as unknown as { mid: string; folder_id: string }[];
    return new Map(rows.map((row) => [row.mid, row.folder_id]));
  }

  /**
   * Forgets filings for messages no longer in Archive.
   *
   * Only ever handed a LIVE listing from Pat: a message deleted or moved out of
   * Archive behind our back (Pat's own web UI, say) should not silently reappear
   * in its old folder if it is ever archived again.
   */
  prune(callsign: string, liveArchiveMids: ReadonlySet<string>): number {
    const stale = [...this.filedMap(callsign).keys()].filter((mid) => !liveArchiveMids.has(mid));
    if (stale.length === 0) return 0;
    const remove = this.db.prepare(`DELETE FROM filed WHERE callsign = ? AND mid = ?`);
    this.db.exec("BEGIN");
    try {
      for (const mid of stale) remove.run(callsign, mid);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return stale.length;
  }

  private assertNameFree(callsign: string, name: string, exceptId: string | null): void {
    const clash = this.db
      .prepare(`SELECT id FROM folders WHERE callsign = ? AND name = ? COLLATE NOCASE`)
      .get(callsign, name) as unknown as { id: string } | undefined;
    if (clash && clash.id !== exceptId) throw new Error(`A folder named "${name}" already exists.`);
  }
}
