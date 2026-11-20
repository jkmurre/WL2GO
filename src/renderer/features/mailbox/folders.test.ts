import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asMailBox,
  moveSubmenu,
  moveTargetFor,
  parseMoveChoice,
  readDraggedMessage,
  userFolderId,
  userFolderOf,
} from "./folders.ts";

const nets = { id: "f1", name: "Nets", total: 2, unread: 1 };

function dataTransfer(raw: string): DataTransfer {
  return { getData: () => raw } as unknown as DataTransfer;
}

describe("user folder ids", () => {
  it("round-trips, and leaves built-in folders alone", () => {
    assert.equal(userFolderOf(userFolderId("f1")), "f1");
    assert.equal(userFolderOf("in"), null);
    assert.equal(asMailBox("in"), "in");
    assert.equal(asMailBox("drafts"), null);
    assert.equal(asMailBox(userFolderId("f1")), null);
  });
});

describe("moveTargetFor", () => {
  it("accepts Inbox, Sent, Archive and user folders, never Drafts or Outbox", () => {
    assert.deepEqual(moveTargetFor("in"), { box: "in" });
    assert.deepEqual(moveTargetFor(userFolderId("f1")), { folderId: "f1" });
    assert.equal(moveTargetFor("drafts"), null);
    assert.equal(moveTargetFor("out"), null);
  });
});

describe("moveSubmenu", () => {
  it("lists every destination and disables where the message already is", () => {
    const items = moveSubmenu(userFolderId("f1"), [nets]);
    assert.deepEqual(
      items.map((item) => item.id ?? item.type),
      ["move:in", "move:sent", "move:archive", "separator", "move:folder:f1", "separator", "move:new"],
    );
    assert.equal(items.find((item) => item.id === "move:folder:f1")?.enabled, false);
    assert.equal(items.find((item) => item.id === "move:in")?.enabled, true);
  });

  it("round-trips every choice through parseMoveChoice", () => {
    assert.deepEqual(parseMoveChoice("move:in"), { box: "in" });
    assert.deepEqual(parseMoveChoice("move:folder:f1"), { folderId: "f1" });
    assert.equal(parseMoveChoice("move:new"), "new");
    assert.equal(parseMoveChoice("move:out"), null);
    assert.equal(parseMoveChoice(null), null);
    assert.equal(parseMoveChoice("read"), null);
  });
});

describe("readDraggedMessage", () => {
  it("reads a dragged row and ignores anything else", () => {
    assert.deepEqual(readDraggedMessage(dataTransfer('{"box":"in","mid":"AAA"}')), { box: "in", mid: "AAA" });
    assert.equal(readDraggedMessage(dataTransfer('{"box":"drafts","mid":"AAA"}')), null);
    assert.equal(readDraggedMessage(dataTransfer("not json")), null);
    assert.equal(readDraggedMessage(dataTransfer("")), null);
  });
});
