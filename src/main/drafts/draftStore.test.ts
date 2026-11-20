import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DraftStore } from "./draftStore.ts";
import { MailboxDb } from "../mailbox/mailboxDb.ts";
import { emptyDraft, type ComposeDraft } from "../../shared/composeModel.ts";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function newDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wl2go-drafts-"));
  dirs.push(dir);
  return dir;
}

function openStore(): DraftStore {
  return new DraftStore(path.join(newDir(), "drafts.db"));
}

function draft(overrides: Partial<ComposeDraft> = {}): ComposeDraft {
  return { ...emptyDraft("d1"), to: "W1AW", subject: "Net", body: "See you at 1900.", ...overrides };
}

describe("DraftStore round-tripping", () => {
  it("stores and returns a draft intact", () => {
    const store = openStore();
    store.save("N1CALL", draft({ cc: "K1ABC", p2pOnly: true }), []);

    const stored = store.get("N1CALL", "d1");

    assert.equal(stored?.draft.to, "W1AW");
    assert.equal(stored?.draft.cc, "K1ABC");
    assert.equal(stored?.draft.subject, "Net");
    assert.equal(stored?.draft.body, "See you at 1900.");
    assert.equal(stored?.draft.p2pOnly, true);
  });

  it("returns null for a draft that does not exist", () => {
    assert.equal(openStore().get("N1CALL", "nope"), null);
  });

  it("updates in place rather than creating a second draft", () => {
    const store = openStore();
    store.save("N1CALL", draft({ subject: "before" }), []);
    store.save("N1CALL", draft({ subject: "after" }), []);

    assert.equal(store.count("N1CALL"), 1);
    assert.equal(store.get("N1CALL", "d1")?.draft.subject, "after");
  });

  it("keeps two operators' drafts apart", () => {
    const store = openStore();
    store.save("N1CALL", draft({ subject: "mine" }), []);
    store.save("W1AW", draft({ id: "d2", subject: "theirs" }), []);

    assert.equal(store.get("N1CALL", "d2"), null, "one operator should not see another's draft");
    assert.equal(store.count("N1CALL"), 1);
  });

  it("survives being reopened", () => {
    const file = path.join(newDir(), "drafts.db");

    const first = new DraftStore(file);
    first.save("N1CALL", draft(), []);
    first.close();

    const second = new DraftStore(file);
    assert.equal(second.get("N1CALL", "d1")?.draft.subject, "Net");
    second.close();
  });
});

describe("DraftStore attachments", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it("stores attachment content, not a path to it", () => {
    // A draft whose attachment cannot be sent because the file moved is a bad
    // failure on the day it matters.
    const store = openStore();
    store.save("N1CALL", draft(), [{ name: "photo.jpg", contentType: "image/jpeg", bytes: jpeg }]);

    const stored = store.get("N1CALL", "d1");

    assert.equal(stored?.attachments.length, 1);
    assert.ok(Buffer.isBuffer(stored?.attachments[0]?.bytes));
    assert.ok(stored?.attachments[0]?.bytes.equals(jpeg), "attachment bytes did not survive");
  });

  it("preserves every byte value", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const store = openStore();
    store.save("N1CALL", draft(), [{ name: "raw.bin", contentType: "application/octet-stream", bytes: all }]);

    assert.ok(store.get("N1CALL", "d1")?.attachments[0]?.bytes.equals(all));
  });

  it("keeps attachments in the order they were added", () => {
    const store = openStore();
    store.save("N1CALL", draft(), [
      { name: "a.txt", contentType: "text/plain", bytes: Buffer.from("a") },
      { name: "b.txt", contentType: "text/plain", bytes: Buffer.from("b") },
      { name: "c.txt", contentType: "text/plain", bytes: Buffer.from("c") },
    ]);

    assert.deepEqual(
      store.get("N1CALL", "d1")?.attachments.map((f) => f.name),
      ["a.txt", "b.txt", "c.txt"],
    );
  });

  it("replaces attachments wholesale on save", () => {
    const store = openStore();
    store.save("N1CALL", draft(), [{ name: "old.txt", contentType: "text/plain", bytes: Buffer.from("x") }]);
    store.save("N1CALL", draft(), [{ name: "new.txt", contentType: "text/plain", bytes: Buffer.from("y") }]);

    assert.deepEqual(
      store.get("N1CALL", "d1")?.attachments.map((f) => f.name),
      ["new.txt"],
    );
  });

  it("reports attachment sizes on the draft itself", () => {
    const store = openStore();
    store.save("N1CALL", draft(), [{ name: "photo.jpg", contentType: "image/jpeg", bytes: jpeg }]);

    assert.deepEqual(store.get("N1CALL", "d1")?.draft.attachments, [
      { name: "photo.jpg", contentType: "image/jpeg", sizeBytes: jpeg.length },
    ]);
  });

  it("removes attachments with the draft, leaving nothing orphaned", () => {
    const store = openStore();
    store.save("N1CALL", draft(), [{ name: "photo.jpg", contentType: "image/jpeg", bytes: jpeg }]);
    store.delete("N1CALL", "d1");

    // Saving a new draft that reuses the id must not inherit the old files.
    store.save("N1CALL", draft(), []);
    assert.deepEqual(store.get("N1CALL", "d1")?.attachments, []);
  });
});

describe("DraftStore listing", () => {
  it("lists most recently edited first", () => {
    const store = openStore();
    store.save("N1CALL", draft({ id: "old", subject: "old" }), [], new Date("2026-08-01T00:00:00Z"));
    store.save("N1CALL", draft({ id: "new", subject: "new" }), [], new Date("2026-08-24T00:00:00Z"));

    assert.deepEqual(
      store.list("N1CALL").map((d) => d.id),
      ["new", "old"],
    );
  });

  it("previews the body so an untitled draft is still recognisable", () => {
    const store = openStore();
    store.save("N1CALL", draft({ subject: "", body: "  All stations\n  please stand by  " }), []);

    assert.equal(store.list("N1CALL")[0]?.preview, "All stations please stand by");
  });

  it("truncates a long preview", () => {
    const store = openStore();
    store.save("N1CALL", draft({ body: "x".repeat(500) }), []);

    const preview = store.list("N1CALL")[0]?.preview ?? "";
    assert.equal(preview.length, 120);
    assert.ok(preview.endsWith("…"));
  });

  it("counts attachments without loading them", () => {
    const store = openStore();
    store.save("N1CALL", draft(), [
      { name: "a.txt", contentType: "text/plain", bytes: Buffer.from("a") },
      { name: "b.txt", contentType: "text/plain", bytes: Buffer.from("b") },
    ]);

    assert.equal(store.list("N1CALL")[0]?.attachmentCount, 2);
  });

  it("is empty for an operator with no drafts", () => {
    assert.deepEqual(openStore().list("N1CALL"), []);
  });
});

describe("DraftStore deletion", () => {
  it("deletes and reports whether anything went", () => {
    const store = openStore();
    store.save("N1CALL", draft(), []);

    assert.equal(store.delete("N1CALL", "d1"), true);
    assert.equal(store.delete("N1CALL", "d1"), false);
    assert.equal(store.get("N1CALL", "d1"), null);
  });

  it("will not delete another operator's draft", () => {
    const store = openStore();
    store.save("N1CALL", draft(), []);

    assert.equal(store.delete("W1AW", "d1"), false);
    assert.ok(store.get("N1CALL", "d1"));
  });
});

describe("drafts are not cache", () => {
  it("survives everything that legitimately destroys the mailbox cache", () => {
    // This is the whole reason drafts live in their own database. mailbox.db is
    // derived state: "Rebuild index" clears it, and a schema-version change
    // drops it wholesale -- both safe because every row mirrors a file Pat owns.
    // A draft mirrors nothing. Losing one that way would be inexcusable.
    const dir = newDir();
    const mailboxPath = path.join(dir, "mailbox.db");
    const draftsPath = path.join(dir, "drafts.db");

    const drafts = new DraftStore(draftsPath);
    drafts.save("N1CALL", draft({ subject: "half-written" }), [
      { name: "photo.jpg", contentType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8]) },
    ]);

    const mailbox = new MailboxDb(mailboxPath);
    mailbox.upsertMessages("N1CALL", [
      {
        box: "in",
        mid: "AAA",
        date: "2026-08-24T00:00:00.000Z",
        from: "W1AW",
        to: [],
        cc: [],
        subject: "cached",
        unread: false,
        p2pOnly: false,
        attachments: [],
        body: null,
      },
    ]);

    // 1. What "Rebuild index" does.
    mailbox.clearCallsign("N1CALL");
    assert.equal(mailbox.listFolder("N1CALL", "in").length, 0, "the cache should have been cleared");

    // 2. What a schema-version change does: the whole table goes.
    mailbox.close();
    const raw = new DatabaseSync(mailboxPath);
    raw.exec("PRAGMA user_version = 999");
    raw.close();
    const rebuilt = new MailboxDb(mailboxPath);
    rebuilt.close();

    // The draft is untouched by both, attachment included.
    const stored = drafts.get("N1CALL", "d1");
    assert.equal(stored?.draft.subject, "half-written");
    assert.equal(stored?.attachments.length, 1);
    assert.ok(stored?.attachments[0]?.bytes.equals(Buffer.from([0xff, 0xd8])));
    drafts.close();
  });
});
