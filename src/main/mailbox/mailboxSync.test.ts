import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { MailboxDb } from "./mailboxDb.ts";
import { MailboxSync, type MailboxApi } from "./mailboxSync.ts";
import { FolderStore } from "../folders/folderStore.ts";
import type { MailBox, MailFolderCounts } from "../../shared/ipcContract.ts";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** One entry in Pat's own wire shape. */
function patMessage(mid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MID: mid,
    Date: "2026-08-24T14:32:00Z",
    From: { Proto: "", Addr: "N1CALL" },
    To: [{ Proto: "", Addr: "W1AW" }],
    Cc: null,
    Subject: `Subject ${mid}`,
    Body: "",
    BodyHTML: "",
    Files: [],
    P2POnly: false,
    Unread: true,
    ...overrides,
  };
}

/** A Pat that serves whatever folders the test puts in it, and counts calls. */
class FakePat implements MailboxApi {
  folders: Record<string, Record<string, unknown>[]> = { in: [], out: [], sent: [], archive: [] };
  bodies: Record<string, string> = {};
  listCalls: string[] = [];
  readCalls: { box: string; mid: string; read: boolean }[] = [];
  moveCalls: { fromBox: string; mid: string; toBox: string }[] = [];
  deleteCalls: { box: string; mid: string }[] = [];
  failReadWith: Error | null = null;
  failMoveWith: Error | null = null;
  failDeleteWith: Error | null = null;

  getMailbox(box: string): Promise<unknown[]> {
    this.listCalls.push(box);
    return Promise.resolve(this.folders[box] ?? []);
  }

  getMessage(box: string, mid: string): Promise<unknown> {
    const entry = (this.folders[box] ?? []).find((m) => m["MID"] === mid);
    if (!entry) return Promise.reject(new Error("not found"));
    return Promise.resolve({ ...entry, Body: this.bodies[mid] ?? "" });
  }

  setRead(box: string, mid: string, read: boolean): Promise<void> {
    if (this.failReadWith) return Promise.reject(this.failReadWith);
    this.readCalls.push({ box, mid, read });
    const entry = (this.folders[box] ?? []).find((m) => m["MID"] === mid);
    if (entry) entry["Unread"] = !read;
    return Promise.resolve();
  }

  moveMessage(fromBox: string, mid: string, toBox: string): Promise<void> {
    if (this.failMoveWith) return Promise.reject(this.failMoveWith);
    this.moveCalls.push({ fromBox, mid, toBox });

    const source = this.folders[fromBox] ?? [];
    const index = source.findIndex((m) => m["MID"] === mid);
    if (index >= 0) {
      const [entry] = source.splice(index, 1);
      (this.folders[toBox] ??= []).push(entry!);
    }
    return Promise.resolve();
  }

  deleteMessage(box: string, mid: string): Promise<void> {
    if (this.failDeleteWith) return Promise.reject(this.failDeleteWith);
    this.deleteCalls.push({ box, mid });

    const source = this.folders[box] ?? [];
    const index = source.findIndex((m) => m["MID"] === mid);
    if (index >= 0) source.splice(index, 1);
    return Promise.resolve();
  }

  /** How many times a folder listing was requested. The expensive call. */
  listCount(box?: string): number {
    return box ? this.listCalls.filter((b) => b === box).length : this.listCalls.length;
  }
}

interface Harness {
  db: MailboxDb;
  folders: FolderStore;
  folderChanges: number;
  pat: FakePat;
  sync: MailboxSync;
  changes: { counts: MailFolderCounts; boxes: MailBox[] }[];
  setNow: (value: number) => void;
  setCallsign: (value: string) => void;
}

function harness(options: { callsign?: string } = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "wl2go-sync-"));
  dirs.push(dir);

  const db = new MailboxDb(path.join(dir, "mailbox.db"));
  const folders = new FolderStore(path.join(dir, "folders.db"));
  let folderChanges = 0;
  const pat = new FakePat();
  const changes: { counts: MailFolderCounts; boxes: MailBox[] }[] = [];
  let clock = 1_000_000;
  let callsign = options.callsign ?? "N1CALL";

  const sync = new MailboxSync({
    db,
    getApi: () => pat,
    getCallsign: () => callsign,
    onChanged: (counts, boxes) => changes.push({ counts, boxes }),
    folders,
    onFoldersChanged: () => (folderChanges += 1),
    coalesceMs: 0,
    selfWriteQuietMs: 1500,
    now: () => clock,
  });

  return {
    db,
    folders,
    get folderChanges() {
      return folderChanges;
    },
    pat,
    sync,
    changes,
    setNow: (value) => (clock = value),
    setCallsign: (value) => (callsign = value),
  };
}

describe("MailboxSync reconcile", () => {
  it("brings new messages into the cache", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA"), patMessage("BBB")];

    const changed = await h.sync.reconcile(["in"]);

    assert.deepEqual(changed, ["in"]);
    assert.deepEqual(
      h.db.listFolder("N1CALL", "in").map((m) => m.mid),
      ["AAA", "BBB"],
    );
  });

  it("removes messages that are no longer in the folder", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA"), patMessage("BBB")];
    await h.sync.reconcile(["in"]);

    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);

    assert.deepEqual(
      h.db.listFolder("N1CALL", "in").map((m) => m.mid),
      ["AAA"],
    );
  });

  it("follows a message that moved to another folder in one pass", async () => {
    // A move is a rename, so it leaves one folder and appears in the other.
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in", "archive"]);

    h.pat.folders["in"] = [];
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["in", "archive"]);

    assert.equal(h.db.listFolder("N1CALL", "in").length, 0);
    assert.deepEqual(
      h.db.listFolder("N1CALL", "archive").map((m) => m.mid),
      ["AAA"],
    );
  });

  it("reports no change when nothing moved, so the UI does not churn", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];

    await h.sync.reconcile(["in"]);
    const afterFirst = h.changes.length;
    const changed = await h.sync.reconcile(["in"]);

    assert.deepEqual(changed, []);
    assert.equal(h.changes.length, afterFirst, "an idle reconcile should push no update");
  });

  it("notices a message that became read outside WL2GO", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA", { Unread: true })];
    await h.sync.reconcile(["in"]);

    h.pat.folders["in"] = [patMessage("AAA", { Unread: false })];
    const changed = await h.sync.reconcile(["in"]);

    assert.deepEqual(changed, ["in"]);
    assert.equal(h.db.getMessage("N1CALL", "in", "AAA")?.unread, false);
  });

  it("does nothing at all without a callsign", async () => {
    const h = harness({ callsign: "" });
    h.pat.folders["in"] = [patMessage("AAA")];

    assert.deepEqual(await h.sync.reconcile(["in"]), []);
    assert.equal(h.pat.listCount(), 0, "should not even ask Pat");
  });
});

describe("MailboxSync trigger coalescing", () => {
  it("collapses a burst of mailbox events into one reconcile", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];

    h.sync.notifyExternalChange();
    h.sync.notifyExternalChange();
    h.sync.notifyExternalChange();
    await h.sync.flush();

    assert.equal(h.pat.listCount("in"), 1, `expected one listing, got ${h.pat.listCount("in")}`);
  });

  it("reconciles every folder on a mailbox event, since Pat does not say which", async () => {
    const h = harness();
    h.sync.syncAll();
    await h.sync.flush();

    assert.deepEqual([...new Set(h.pat.listCalls)].sort(), ["archive", "in", "out", "sent"]);
  });
});

describe("MailboxSync self-write suppression", () => {
  it("does not re-list a folder because of its own mark-read write", async () => {
    // Pat's SetUnread rewrites the whole .b2f, which trips its fsnotify watch
    // and sends us UpdateMailbox. Without suppression, reading five messages
    // costs five full folder listings.
    const h = harness();
    h.pat.folders["in"] = ["AAA", "BBB", "CCC", "DDD", "EEE"].map((mid) => patMessage(mid));
    await h.sync.reconcile(["in"]);
    const baseline = h.pat.listCount("in");

    for (const mid of ["AAA", "BBB", "CCC", "DDD", "EEE"]) {
      await h.sync.markRead("in", mid, true);
      // Pat's echo of our own write.
      h.sync.notifyExternalChange();
    }
    // Nothing has re-listed yet: every echo landed inside a quiet window.
    assert.equal(h.pat.listCount("in"), baseline, "no listing should happen while the operator is still reading");

    // The deferred pass then runs ONCE for all five, rather than once each.
    await h.sync.flush();

    assert.equal(
      h.pat.listCount("in") - baseline,
      1,
      `five mark-reads should cost one deferred listing, got ${h.pat.listCount("in") - baseline}`,
    );
    assert.equal(h.pat.readCalls.length, 5, "and every mark-read must still reach Pat");
  });

  it("defers a mailbox event rather than dropping it, so real arrivals survive", async () => {
    // A message can genuinely arrive in the same moment we mark one read.
    // Dropping the event would hide it until something else happened.
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);

    await h.sync.markRead("in", "AAA", true);
    h.pat.folders["in"] = [patMessage("AAA", { Unread: false }), patMessage("NEW")];
    h.sync.notifyExternalChange();

    assert.ok(h.sync.isQuiet(), "the write should have opened a quiet window");

    // Once the window passes, the deferred reconcile runs.
    h.setNow(2_000_000);
    await h.sync.flush();

    assert.deepEqual(
      h.db.listFolder("N1CALL", "in").map((m) => m.mid),
      ["AAA", "NEW"],
    );
  });

  it("marks read in Pat and in the cache together", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);

    await h.sync.markRead("in", "AAA", true);

    assert.deepEqual(h.pat.readCalls, [{ box: "in", mid: "AAA", read: true }]);
    assert.equal(h.db.getMessage("N1CALL", "in", "AAA")?.unread, false);
    assert.equal(h.db.counts("N1CALL").in.unread, 0);
  });

  it("treats Pat's 500 for a vanished message as a stale cache, not an error", async () => {
    // readHandler omits the os.IsNotExist check its neighbours have, so a
    // message that moved or was deleted comes back as a 500.
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);

    h.pat.failReadWith = new Error("Pat API ... returned status 500: no such file or directory");
    h.pat.folders["in"] = [];

    await h.sync.markRead("in", "AAA", true);

    // Did not throw at the caller, and scheduled the folder for a re-sync.
    h.setNow(2_000_000);
    await h.sync.flush();
    assert.equal(h.db.listFolder("N1CALL", "in").length, 0, "the stale row should be gone");
  });
});

describe("MailboxSync bodies", () => {
  it("fetches a body on first open and caches it", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    h.pat.bodies["AAA"] = "the message text";
    await h.sync.reconcile(["in"]);

    assert.equal(h.db.getMessage("N1CALL", "in", "AAA")?.body, null, "the listing carries no body");

    const loaded = await h.sync.loadBody("in", "AAA");

    assert.equal(loaded?.body, "the message text");
    assert.equal(h.db.getMessage("N1CALL", "in", "AAA")?.body, "the message text");
  });

  it("does not ask Pat twice for the same body", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    h.pat.bodies["AAA"] = "body";
    await h.sync.reconcile(["in"]);

    let fetches = 0;
    const original = h.pat.getMessage.bind(h.pat);
    h.pat.getMessage = (box, mid) => {
      fetches += 1;
      return original(box, mid);
    };

    await h.sync.loadBody("in", "AAA");
    await h.sync.loadBody("in", "AAA");

    assert.equal(fetches, 1);
  });

  it("survives a message that vanished before its body was fetched", async () => {
    const h = harness();
    assert.equal(await h.sync.loadBody("in", "GONE").catch(() => "threw"), "threw");
  });
});

describe("MailboxSync rebuild", () => {
  it("discards the cache and refills it from Pat", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);
    h.db.upsertMessages("N1CALL", [
      { box: "in", mid: "STALE", date: "2026-01-01T00:00:00.000Z", from: "X", to: [], cc: [], subject: "ghost", unread: false, p2pOnly: false, attachments: [], body: null },
    ]);

    await h.sync.rebuild();

    assert.deepEqual(
      h.db.listFolder("N1CALL", "in").map((m) => m.mid),
      ["AAA"],
      "the ghost row should not have survived",
    );
  });
});

describe("MailboxSync identity changes", () => {
  it("abandons a pass when the operator changes while a folder is being listed", async () => {
    // A folder listing can take seconds. An identity change during one restarts
    // Pat, which is then serving a DIFFERENT operator's mailbox -- writing that
    // listing would file W1AW's messages under N1CALL.
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];

    const originalList = h.pat.getMailbox.bind(h.pat);
    h.pat.getMailbox = (box) => {
      // The restart lands mid-await, before anything has been written.
      h.setCallsign("W1AW");
      return originalList(box);
    };

    await h.sync.reconcile(["in"]);

    assert.equal(h.db.listFolder("N1CALL", "in").length, 0, "nothing should be filed under the old callsign");
    assert.equal(h.db.listFolder("W1AW", "in").length, 0, "and nothing under the new one from this stale pass");
  });

  it("stops after the first folder rather than writing the remaining three", async () => {
    const h = harness();
    for (const box of ["in", "out", "sent", "archive"]) h.pat.folders[box] = [patMessage("AAA")];

    const originalList = h.pat.getMailbox.bind(h.pat);
    h.pat.getMailbox = (box) => {
      h.setCallsign("W1AW");
      return originalList(box);
    };

    await h.sync.reconcile(["in", "out", "sent", "archive"]);

    assert.equal(h.pat.listCount(), 1, `expected to stop after one folder, listed ${h.pat.listCount()}`);
  });
});

describe("MailboxSync archive", () => {
  it("moves a message to Archive and mirrors it without re-listing", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in", "archive"]);
    const baseline = h.pat.listCount();

    await h.sync.archiveMessage("in", "AAA");

    assert.deepEqual(h.pat.moveCalls, [{ fromBox: "in", mid: "AAA", toBox: "archive" }]);
    assert.equal(h.db.listFolder("N1CALL", "in").length, 0);
    assert.deepEqual(
      h.db.listFolder("N1CALL", "archive").map((m) => m.mid),
      ["AAA"],
    );
    assert.equal(h.pat.listCount(), baseline, "archiving should not provoke a folder listing");
  });

  it("carries an already-fetched body across the move", async () => {
    // The move preserves the MID, so it is the same message -- re-fetching a
    // body we already paid for would be waste.
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    h.pat.bodies["AAA"] = "the message text";
    await h.sync.reconcile(["in"]);
    await h.sync.loadBody("in", "AAA");

    await h.sync.archiveMessage("in", "AAA");

    assert.equal(h.db.getMessage("N1CALL", "archive", "AAA")?.body, "the message text");
  });

  it("reports both folders as changed", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);
    h.changes.length = 0;

    await h.sync.archiveMessage("in", "AAA");

    assert.deepEqual(h.changes.at(-1)?.boxes, ["in", "archive"]);
    assert.equal(h.changes.at(-1)?.counts.archive.total, 1);
  });

  it("is a no-op on a message already in Archive", async () => {
    const h = harness();
    await h.sync.archiveMessage("archive", "AAA");
    assert.deepEqual(h.pat.moveCalls, []);
  });

  it("re-syncs rather than reporting when the move fails", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);

    h.pat.failMoveWith = new Error("Pat API ... returned status 400");
    await h.sync.archiveMessage("in", "AAA");

    // Did not throw at the caller, and the cache still reflects Pat.
    h.setNow(2_000_000);
    await h.sync.flush();
    assert.equal(h.db.listFolder("N1CALL", "in").length, 1);
  });
});

describe("MailboxSync delete", () => {
  it("removes the message from Pat and the cache without re-listing", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);
    const baseline = h.pat.listCount();

    const ok = await h.sync.deleteMessage("archive", "AAA");

    assert.equal(ok, true);
    assert.deepEqual(h.pat.deleteCalls, [{ box: "archive", mid: "AAA" }]);
    assert.equal(h.db.listFolder("N1CALL", "archive").length, 0);
    assert.equal(h.pat.listCount(), baseline, "deleting should not provoke a folder listing");
  });

  it("treats a message that was already gone as a stale cache", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);

    h.pat.failDeleteWith = new Error("Pat API ... returned status 404");
    h.pat.folders["archive"] = [];
    assert.equal(await h.sync.deleteMessage("archive", "AAA"), false, "the caller is told Pat refused");

    h.setNow(2_000_000);
    await h.sync.flush();
    assert.equal(h.db.listFolder("N1CALL", "archive").length, 0, "the stale row should be gone either way");
  });
});

describe("MailboxSync search", () => {
  it("searches the cache for the current operator", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA", { Subject: "Sunday net" })];
    await h.sync.reconcile(["in"]);

    assert.deepEqual(
      h.sync.search("sunday").map((r) => r.mid),
      ["AAA"],
    );
  });

  it("returns nothing before a callsign is set", () => {
    assert.deepEqual(harness({ callsign: "" }).sync.search("anything"), []);
  });
});

describe("MailboxSync user folders", () => {
  it("filing from Inbox archives the message and files it", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA"), patMessage("BBB", { Unread: false })];
    await h.sync.reconcile(["in", "archive"]);
    const nets = h.sync.createFolder("Nets");

    await h.sync.move("in", "AAA", { folderId: nets.id });

    assert.deepEqual(h.pat.moveCalls, [{ fromBox: "in", mid: "AAA", toBox: "archive" }]);
    assert.deepEqual(
      h.sync.listUserFolder(nets.id).map((m) => m.mid),
      ["AAA"],
    );
    // Filed messages are shown in their folder, not twice.
    assert.deepEqual(h.sync.listFolder("archive"), []);
    assert.equal(h.sync.counts().archive.total, 0);
    assert.deepEqual(
      h.sync.userFolders().map(({ name, total, unread }) => ({ name, total, unread })),
      [{ name: "Nets", total: 1, unread: 1 }],
    );
    assert.ok(h.folderChanges > 0);
  });

  it("moving between folders and back to Archive only changes the label", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);
    const a = h.sync.createFolder("A");
    const b = h.sync.createFolder("B");

    await h.sync.move("archive", "AAA", { folderId: a.id });
    await h.sync.move("archive", "AAA", { folderId: b.id });
    assert.deepEqual(h.sync.listUserFolder(a.id), []);
    assert.equal(h.sync.listUserFolder(b.id).length, 1);

    await h.sync.move("archive", "AAA", { box: "archive" });
    assert.equal(h.sync.listFolder("archive").length, 1);
    assert.deepEqual(h.pat.moveCalls, [], "no move on disk was needed");
  });

  it("moving out of a folder to Inbox moves the file and drops the label", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);
    const a = h.sync.createFolder("A");
    await h.sync.move("archive", "AAA", { folderId: a.id });

    await h.sync.move("archive", "AAA", { box: "in" });

    assert.deepEqual(h.pat.moveCalls, [{ fromBox: "archive", mid: "AAA", toBox: "in" }]);
    assert.equal(h.folders.filedMap("N1CALL").size, 0);
    assert.equal(h.sync.listFolder("in").length, 1);
  });

  it("keeps the label when Pat refuses the move", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);
    const a = h.sync.createFolder("A");
    await h.sync.move("archive", "AAA", { folderId: a.id });

    h.pat.failMoveWith = new Error("Pat API ... returned status 500");
    await h.sync.move("archive", "AAA", { box: "in" });

    assert.equal(h.folders.filedMap("N1CALL").get("AAA"), a.id);
  });

  it("does not file anything when archiving fails", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);
    const a = h.sync.createFolder("A");

    h.pat.failMoveWith = new Error("Pat API ... returned status 500");
    await h.sync.move("in", "AAA", { folderId: a.id });

    assert.equal(h.folders.filedMap("N1CALL").size, 0);
  });

  it("deleting a folder returns its messages to Archive", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);
    const a = h.sync.createFolder("A");
    await h.sync.move("archive", "AAA", { folderId: a.id });

    h.sync.deleteFolder(a.id);

    assert.deepEqual(h.sync.userFolders(), []);
    assert.equal(h.sync.listFolder("archive").length, 1);
  });

  it("keeps filings through a rebuild of the cache", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);
    const a = h.sync.createFolder("A");
    await h.sync.move("archive", "AAA", { folderId: a.id });

    await h.sync.rebuild();

    assert.equal(h.sync.listUserFolder(a.id).length, 1);
  });

  it("forgets a filing once the message leaves Archive behind our back", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);
    const a = h.sync.createFolder("A");
    await h.sync.move("archive", "AAA", { folderId: a.id });

    h.pat.folders["archive"] = [];
    await h.sync.reconcile(["archive"]);

    assert.equal(h.folders.filedMap("N1CALL").size, 0);
  });

  it("un-files a message that is deleted permanently", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA")];
    await h.sync.reconcile(["archive"]);
    const a = h.sync.createFolder("A");
    await h.sync.move("archive", "AAA", { folderId: a.id });

    await h.sync.deleteMessage("archive", "AAA");

    assert.equal(h.folders.filedMap("N1CALL").size, 0);
  });

  it("names the folder a search hit is filed in", async () => {
    const h = harness();
    h.pat.folders["archive"] = [patMessage("AAA", { Subject: "Sunday net" })];
    await h.sync.reconcile(["archive"]);
    const a = h.sync.createFolder("Nets");
    await h.sync.move("archive", "AAA", { folderId: a.id });

    assert.equal(h.sync.search("sunday")[0]?.folderName, "Nets");
  });

  it("refuses a folder that no longer exists", async () => {
    const h = harness();
    h.pat.folders["in"] = [patMessage("AAA")];
    await h.sync.reconcile(["in"]);

    await assert.rejects(h.sync.move("in", "AAA", { folderId: "missing" }), /no longer exists/);
    assert.deepEqual(h.pat.moveCalls, []);
  });
});
