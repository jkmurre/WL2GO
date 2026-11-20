import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { FolderStore, normalizeFolderName } from "./folderStore.ts";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wl2go-folders-"));
  dirs.push(dir);
  return path.join(dir, "folders.db");
}

describe("normalizeFolderName", () => {
  it("trims and collapses whitespace", () => {
    assert.equal(normalizeFolderName("  Sunday   net "), "Sunday net");
  });

  it("refuses an empty or overlong name", () => {
    assert.throws(() => normalizeFolderName("   "), /needs a name/);
    assert.throws(() => normalizeFolderName("x".repeat(65)), /at most 64/);
  });
});

describe("FolderStore", () => {
  it("creates folders and lists them alphabetically, per callsign", () => {
    const store = new FolderStore(dbPath());
    store.create("N1CALL", "Nets");
    store.create("N1CALL", "ARES");
    store.create("W1AW", "Other operator");

    assert.deepEqual(
      store.listFolders("N1CALL").map((f) => f.name),
      ["ARES", "Nets"],
    );
    store.close();
  });

  it("rejects a duplicate name regardless of case", () => {
    const store = new FolderStore(dbPath());
    store.create("N1CALL", "Nets");
    assert.throws(() => store.create("N1CALL", "nets"), /already exists/);
    // Another operator may use the same name.
    store.create("W1AW", "Nets");
    store.close();
  });

  it("renames, including a change of case to itself", () => {
    const store = new FolderStore(dbPath());
    const nets = store.create("N1CALL", "nets");
    store.create("N1CALL", "ARES");

    store.rename("N1CALL", nets.id, "Nets");
    assert.equal(store.getFolder("N1CALL", nets.id)?.name, "Nets");
    assert.throws(() => store.rename("N1CALL", nets.id, "ares"), /already exists/);
    assert.throws(() => store.rename("N1CALL", "missing", "X"), /no longer exists/);
    store.close();
  });

  it("files, re-files and un-files messages", () => {
    const store = new FolderStore(dbPath());
    const a = store.create("N1CALL", "A");
    const b = store.create("N1CALL", "B");

    store.fileMessage("N1CALL", "MID1", a.id);
    store.fileMessage("N1CALL", "MID1", b.id);
    assert.deepEqual([...store.filedMap("N1CALL")], [["MID1", b.id]]);

    assert.equal(store.unfile("N1CALL", "MID1"), true);
    assert.equal(store.filedMap("N1CALL").size, 0);
    assert.throws(() => store.fileMessage("N1CALL", "MID1", "missing"), /no longer exists/);
    store.close();
  });

  it("deleting a folder un-files its messages rather than losing track of them", () => {
    const store = new FolderStore(dbPath());
    const a = store.create("N1CALL", "A");
    store.fileMessage("N1CALL", "MID1", a.id);

    assert.equal(store.remove("N1CALL", a.id), true);
    assert.equal(store.filedMap("N1CALL").size, 0);
    store.close();
  });

  it("prunes filings for messages no longer in Archive", () => {
    const store = new FolderStore(dbPath());
    const a = store.create("N1CALL", "A");
    store.fileMessage("N1CALL", "KEEP", a.id);
    store.fileMessage("N1CALL", "GONE", a.id);

    assert.equal(store.prune("N1CALL", new Set(["KEEP"])), 1);
    assert.deepEqual([...store.filedMap("N1CALL").keys()], ["KEEP"]);
    store.close();
  });

  it("keeps everything across a reopen", () => {
    const file = dbPath();
    const first = new FolderStore(file);
    const a = first.create("N1CALL", "A");
    first.fileMessage("N1CALL", "MID1", a.id);
    first.close();

    const second = new FolderStore(file);
    assert.deepEqual(second.listFolders("N1CALL"), [a]);
    assert.equal(second.filedMap("N1CALL").get("MID1"), a.id);
    second.close();
  });
});
