import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { MailboxDb, toFtsQuery } from "./mailboxDb.ts";
import type { MailBox, MailMessage } from "../../shared/ipcContract.ts";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function openDb(): MailboxDb {
  const dir = mkdtempSync(path.join(tmpdir(), "wl2go-mailbox-"));
  dirs.push(dir);
  return new MailboxDb(path.join(dir, "mailbox.db"));
}

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    box: "in" as MailBox,
    mid: "E88DNN8D4ONK",
    date: "2026-08-24T14:32:00.000Z",
    from: "N1CALL",
    to: ["W1AW"],
    cc: [],
    subject: "Test message",
    unread: true,
    p2pOnly: false,
    attachments: [],
    body: null,
    ...overrides,
  };
}

describe("MailboxDb round-tripping", () => {
  it("stores and returns a message with every field intact", () => {
    const db = openDb();
    const original = message({
      to: ["W1AW", "N0CALL"],
      cc: ["ops@example.org"],
      p2pOnly: true,
      attachments: [{ name: "photo.jpg", sizeBytes: 40213 }],
      body: "hello",
    });

    db.upsertMessages("N1CALL", [original]);

    assert.deepEqual(db.getMessage("N1CALL", "in", "E88DNN8D4ONK"), original);
  });

  it("omits bodies from a folder listing, since the list never shows them", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ body: "a body" })]);

    const listed = db.listFolder("N1CALL", "in");

    assert.equal(listed.length, 1);
    assert.equal((listed[0] as MailMessage).body, null);
    // ...but it is still there for the reading pane.
    assert.equal(db.getMessage("N1CALL", "in", "E88DNN8D4ONK")?.body, "a body");
  });

  it("returns null for a message that is not cached", () => {
    assert.equal(openDb().getMessage("N1CALL", "in", "NOPE"), null);
  });

  it("orders a folder newest first", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [
      message({ mid: "OLD", date: "2026-08-01T00:00:00.000Z" }),
      message({ mid: "NEW", date: "2026-08-24T00:00:00.000Z" }),
      message({ mid: "MID", date: "2026-08-12T00:00:00.000Z" }),
    ]);

    assert.deepEqual(
      db.listFolder("N1CALL", "in").map((m) => m.mid),
      ["NEW", "MID", "OLD"],
    );
  });
});

describe("MailboxDb keying", () => {
  it("keeps the same MID in two folders as two rows", () => {
    // A message you sent lives in `sent`; the same MID can come back to `in`.
    // Keying on the MID alone would collapse them into one.
    const db = openDb();
    db.upsertMessages("N1CALL", [
      message({ box: "sent", subject: "as sent" }),
      message({ box: "in", subject: "as received" }),
    ]);

    assert.equal(db.getMessage("N1CALL", "sent", "E88DNN8D4ONK")?.subject, "as sent");
    assert.equal(db.getMessage("N1CALL", "in", "E88DNN8D4ONK")?.subject, "as received");
  });

  it("keeps two operators' mailboxes apart", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ subject: "for N1CALL" })]);
    db.upsertMessages("W1AW", [message({ subject: "for W1AW" })]);

    assert.equal(db.getMessage("N1CALL", "in", "E88DNN8D4ONK")?.subject, "for N1CALL");
    assert.equal(db.getMessage("W1AW", "in", "E88DNN8D4ONK")?.subject, "for W1AW");
    assert.equal(db.listFolder("N1CALL", "in").length, 1);
  });

  it("is idempotent: re-syncing the same listing changes nothing", () => {
    const db = openDb();
    const messages = [message(), message({ mid: "SECOND" })];

    const first = db.upsertMessages("N1CALL", messages);
    const second = db.upsertMessages("N1CALL", messages);

    assert.deepEqual(first, { inserted: 2, updated: 0 });
    assert.deepEqual(second, { inserted: 0, updated: 2 });
    assert.equal(db.listFolder("N1CALL", "in").length, 2);
  });

  it("updates the fields a re-sync can legitimately change", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ unread: true, subject: "before" })]);
    db.upsertMessages("N1CALL", [message({ unread: false, subject: "after" })]);

    const stored = db.getMessage("N1CALL", "in", "E88DNN8D4ONK");
    assert.equal(stored?.unread, false);
    assert.equal(stored?.subject, "after");
  });
});

describe("MailboxDb body retention", () => {
  it("keeps a fetched body when the folder listing re-syncs over it", () => {
    // The listing never carries a body. Taking its NULL would discard the body
    // we already fetched, on every single re-sync.
    const db = openDb();
    db.upsertMessages("N1CALL", [message()]);
    db.setBody("N1CALL", "in", "E88DNN8D4ONK", "the real body");

    db.upsertMessages("N1CALL", [message({ body: null, subject: "re-synced" })]);

    const stored = db.getMessage("N1CALL", "in", "E88DNN8D4ONK");
    assert.equal(stored?.body, "the real body");
    assert.equal(stored?.subject, "re-synced");
  });

  it("reports whether a body was stored", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message()]);

    assert.equal(db.setBody("N1CALL", "in", "E88DNN8D4ONK", "x"), true);
    assert.equal(db.setBody("N1CALL", "in", "GONE", "x"), false);
  });
});

describe("MailboxDb folder index and counts", () => {
  it("indexes a folder by MID for diffing", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ unread: true }), message({ mid: "READ", unread: false, body: "b" })]);

    const index = db.folderIndex("N1CALL", "in");

    assert.deepEqual(index.get("E88DNN8D4ONK"), { unread: true, hasBody: false });
    assert.deepEqual(index.get("READ"), { unread: false, hasBody: true });
    assert.equal(index.size, 2);
  });

  it("counts totals and unread per folder, reporting zero for empty ones", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [
      message({ mid: "A", unread: true }),
      message({ mid: "B", unread: true }),
      message({ mid: "C", unread: false }),
      message({ mid: "D", box: "sent", unread: false }),
    ]);

    const counts = db.counts("N1CALL");

    assert.deepEqual(counts.in, { total: 3, unread: 2 });
    assert.deepEqual(counts.sent, { total: 1, unread: 0 });
    assert.deepEqual(counts.out, { total: 0, unread: 0 });
    assert.deepEqual(counts.archive, { total: 0, unread: 0 });
  });

  it("marks a message read without touching the rest of the row", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ unread: true, body: "keep me" })]);

    assert.equal(db.setUnread("N1CALL", "in", "E88DNN8D4ONK", false), true);

    const stored = db.getMessage("N1CALL", "in", "E88DNN8D4ONK");
    assert.equal(stored?.unread, false);
    assert.equal(stored?.body, "keep me");
    assert.equal(db.counts("N1CALL").in.unread, 0);
  });
});

describe("MailboxDb removal", () => {
  it("deletes named messages and reports how many went", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ mid: "A" }), message({ mid: "B" }), message({ mid: "C" })]);

    assert.equal(db.deleteMessages("N1CALL", "in", ["A", "C", "NEVER_EXISTED"]), 2);
    assert.deepEqual(
      db.listFolder("N1CALL", "in").map((m) => m.mid),
      ["B"],
    );
  });

  it("does nothing when given no MIDs", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message()]);

    assert.equal(db.deleteMessages("N1CALL", "in", []), 0);
    assert.equal(db.listFolder("N1CALL", "in").length, 1);
  });

  it("clears one operator's cache and leaves the other's alone", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ mid: "A" }), message({ mid: "B", box: "sent" })]);
    db.upsertMessages("W1AW", [message({ mid: "A" })]);

    assert.equal(db.clearCallsign("N1CALL"), 2);
    assert.equal(db.listFolder("N1CALL", "in").length, 0);
    assert.equal(db.listFolder("W1AW", "in").length, 1);
  });
});

describe("MailboxDb persistence", () => {
  it("reopens an existing database without losing anything", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wl2go-mailbox-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "mailbox.db");

    const first = new MailboxDb(dbPath);
    first.upsertMessages("N1CALL", [message({ body: "persisted" })]);
    first.close();

    const second = new MailboxDb(dbPath);
    assert.equal(second.getMessage("N1CALL", "in", "E88DNN8D4ONK")?.body, "persisted");
    second.close();
  });

  it("rebuilds rather than refusing a database from a newer version of WL2GO", () => {
    // The cache is derived state: a downgrade should cost a re-sync, not an app
    // that cannot open its own mailbox.
    const dir = mkdtempSync(path.join(tmpdir(), "wl2go-mailbox-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "mailbox.db");

    const first = new MailboxDb(dbPath);
    first.upsertMessages("N1CALL", [message()]);
    first.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 999");
    raw.close();

    const second = new MailboxDb(dbPath);
    assert.equal(second.listFolder("N1CALL", "in").length, 0, "stale rows should have been dropped");
    // ...and it is usable again immediately.
    second.upsertMessages("N1CALL", [message()]);
    assert.equal(second.listFolder("N1CALL", "in").length, 1);
    second.close();
  });
});

describe("MailboxDb journal mode", () => {
  it("actually runs in WAL on a real file, not just in the pragma we send", () => {
    // Asserting the pragma against :memory: proves nothing -- SQLite silently
    // reports "memory" there. Only a file-backed database can confirm it.
    const dir = mkdtempSync(path.join(tmpdir(), "wl2go-mailbox-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "mailbox.db");

    const db = new MailboxDb(dbPath);
    db.upsertMessages("N1CALL", [message()]);
    db.close();

    const raw = new DatabaseSync(dbPath);
    const mode = raw.prepare("PRAGMA journal_mode").get() as unknown as { journal_mode: string };
    raw.close();

    assert.equal(mode.journal_mode, "wal");
  });
});

describe("toFtsQuery", () => {
  it("quotes and prefix-matches each word", () => {
    assert.equal(toFtsQuery("net check"), '"net"* AND "check"*');
  });

  it("returns null when nothing searchable is left", () => {
    // The caller reads null as "no query", not "no results" -- an empty search
    // box must show the folder, not an empty list.
    assert.equal(toFtsQuery(""), null);
    assert.equal(toFtsQuery("   "), null);
    assert.equal(toFtsQuery('"""'), null);
    assert.equal(toFtsQuery("-"), null);
    assert.equal(toFtsQuery("()"), null);
  });

  it("strips FTS5 operators rather than passing them through", () => {
    // Handing an operator boolean syntax they did not know they typed is worse
    // than ignoring it.
    assert.equal(toFtsQuery("storm AND rain"), '"storm"* AND "AND"* AND "rain"*');
    assert.equal(toFtsQuery("net -check"), '"net"* AND "check"*');
    assert.equal(toFtsQuery('say "hello"'), '"say"* AND "hello"*');
  });

  it("keeps non-ASCII words", () => {
    assert.equal(toFtsQuery("växjö"), '"växjö"*');
  });
});

describe("MailboxDb.contactRows", () => {
  it("returns the address fields of every folder, newest first, for one callsign", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [
      message({ mid: "AAA", date: "2026-08-20T00:00:00.000Z", from: "W1AW", to: ["N1CALL"] }),
      message({
        mid: "BBB",
        box: "sent",
        date: "2026-08-24T00:00:00.000Z",
        from: "N1CALL",
        to: ["N0CALL"],
        cc: ["ops@example.org"],
        body: "never read",
      }),
    ]);
    db.upsertMessages("N0CALL", [message({ mid: "CCC", from: "K1ABC" })]);

    assert.deepEqual(db.contactRows("N1CALL"), [
      { date: "2026-08-24T00:00:00.000Z", from: "N1CALL", to: ["N0CALL"], cc: ["ops@example.org"] },
      { date: "2026-08-20T00:00:00.000Z", from: "W1AW", to: ["N1CALL"], cc: [] },
    ]);
  });
});

describe("MailboxDb.search", () => {
  function seeded(): MailboxDb {
    const db = openDb();
    db.upsertMessages("N1CALL", [
      message({ mid: "AAA", subject: "Sunday net check-in", from: "N1CALL" }),
      message({ mid: "BBB", subject: "Weather", from: "W1AW", box: "sent" }),
      message({ mid: "CCC", subject: "Supplies", from: "N0CALL", box: "archive" }),
    ]);
    db.setBody("N1CALL", "in", "AAA", "All stations please acknowledge.");
    db.setBody("N1CALL", "sent", "BBB", "Heavy rainfall expected overnight.");
    db.setBody("N1CALL", "archive", "CCC", "We need more generators and fuel.");
    return db;
  }

  it("finds a message by a word in its subject", () => {
    const hits = seeded().search("N1CALL", "weather");
    assert.deepEqual(
      hits.map((h) => h.mid),
      ["BBB"],
    );
  });

  it("finds a message by a word only in its body", () => {
    // The whole point of search over a folder listing.
    const hits = seeded().search("N1CALL", "generators");
    assert.deepEqual(
      hits.map((h) => h.mid),
      ["CCC"],
    );
  });

  it("finds a message by its sender", () => {
    const hits = seeded().search("N1CALL", "N0CALL");
    assert.deepEqual(
      hits.map((h) => h.mid),
      ["CCC"],
    );
  });

  it("searches every folder, and says which one each hit is in", () => {
    // Not scoped to the selected folder: the main reason to search is that you
    // cannot remember where something is.
    const db = seeded();

    for (const [query, box, mid] of [
      ["acknowledge", "in", "AAA"],
      ["rainfall", "sent", "BBB"],
      ["generators", "archive", "CCC"],
    ] as const) {
      const hits = db.search("N1CALL", query);
      assert.deepEqual(
        hits.map((h) => [h.box, h.mid]),
        [[box, mid]],
        `searching "${query}" should have found ${mid} in ${box}`,
      );
    }
  });

  it("matches on a prefix, so results appear while still typing", () => {
    const hits = seeded().search("N1CALL", "gener");
    assert.deepEqual(
      hits.map((h) => h.mid),
      ["CCC"],
    );
  });

  it("requires every word to match", () => {
    assert.equal(seeded().search("N1CALL", "heavy rainfall").length, 1);
    assert.equal(seeded().search("N1CALL", "heavy generators").length, 0);
  });

  it("returns a body snippet showing why a message matched", () => {
    const hits = seeded().search("N1CALL", "rainfall");
    assert.match(hits[0]?.snippet ?? "", /rainfall/);
  });

  it("does not leak another operator's mail", () => {
    const db = seeded();
    db.upsertMessages("W1AW", [message({ mid: "ZZZ", subject: "Weather" })]);

    assert.deepEqual(
      db.search("N1CALL", "weather").map((h) => h.mid),
      ["BBB"],
    );
  });

  it("survives hostile input instead of throwing", () => {
    // Unbalanced quotes and stray operators are ordinary mid-typing states.
    const db = seeded();
    for (const query of ['"', '""', "(", ")", "*", "-", "^", "NEAR(", "a AND", 'x"y(z']) {
      assert.doesNotThrow(() => db.search("N1CALL", query), `query ${query} threw`);
    }
  });

  it("returns nothing for an empty query", () => {
    assert.deepEqual(seeded().search("N1CALL", "   "), []);
  });
});

describe("MailboxDb search index maintenance", () => {
  it("stops returning a message that was deleted", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ mid: "AAA", subject: "generators" })]);
    assert.equal(db.search("N1CALL", "generators").length, 1);

    db.deleteMessages("N1CALL", "in", ["AAA"]);

    assert.equal(db.search("N1CALL", "generators").length, 0, "the FTS index kept a deleted message");
  });

  it("follows a subject that changed on re-sync", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ mid: "AAA", subject: "before" })]);
    db.upsertMessages("N1CALL", [message({ mid: "AAA", subject: "after" })]);

    assert.equal(db.search("N1CALL", "before").length, 0, "the FTS index kept a stale subject");
    assert.equal(db.search("N1CALL", "after").length, 1);
  });

  it("indexes a body fetched after the message was first cached", () => {
    // Bodies arrive later than the row, so the update trigger is what makes
    // body search work at all.
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ mid: "AAA" })]);
    assert.equal(db.search("N1CALL", "acknowledge").length, 0);

    db.setBody("N1CALL", "in", "AAA", "Please acknowledge receipt.");

    assert.equal(db.search("N1CALL", "acknowledge").length, 1);
  });

  it("clears the index when an operator's cache is dropped", () => {
    const db = openDb();
    db.upsertMessages("N1CALL", [message({ mid: "AAA", subject: "generators" })]);
    db.clearCallsign("N1CALL");

    assert.equal(db.search("N1CALL", "generators").length, 0);
  });
});
