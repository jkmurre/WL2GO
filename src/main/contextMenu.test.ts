import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContextMenuTemplate, buildPopupTemplate, type ContextMenuActions } from "./contextMenu.ts";

const noFlags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
};

function params(overrides: Partial<Parameters<typeof buildContextMenuTemplate>[0]> = {}) {
  return {
    isEditable: false,
    selectionText: "",
    linkURL: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags: noFlags,
    ...overrides,
  };
}

function recorder() {
  const calls: string[] = [];
  const actions: ContextMenuActions = {
    replaceMisspelling: (word) => calls.push(`replace:${word}`),
    addToDictionary: (word) => calls.push(`add:${word}`),
    copyText: (text) => calls.push(`copy:${text}`),
  };
  return { calls, actions };
}

const byRole = (items: ReturnType<typeof buildContextMenuTemplate>, role: string) =>
  items.find((item) => item.role === role);

describe("buildContextMenuTemplate", () => {
  it("shows nothing over plain chrome", () => {
    assert.deepEqual(buildContextMenuTemplate(params(), recorder().actions), []);
  });

  it("enables edit roles in a text field from the edit flags", () => {
    const items = buildContextMenuTemplate(
      params({ isEditable: true, editFlags: { ...noFlags, canPaste: true, canSelectAll: true } }),
      recorder().actions,
    );
    assert.equal(byRole(items, "paste")?.enabled, true);
    assert.equal(byRole(items, "cut")?.enabled, false);
    assert.equal(byRole(items, "copy")?.enabled, false);
    assert.equal(byRole(items, "selectAll")?.enabled, true);
  });

  it("offers Copy and Select All for selected read-only text", () => {
    const items = buildContextMenuTemplate(params({ selectionText: "QSL" }), recorder().actions);
    assert.deepEqual(
      items.map((item) => item.role),
      ["copy", "selectAll"],
    );
  });

  it("ignores a whitespace-only selection", () => {
    assert.deepEqual(buildContextMenuTemplate(params({ selectionText: "  \n" }), recorder().actions), []);
  });

  it("puts spelling suggestions first and wires them up", () => {
    const { calls, actions } = recorder();
    const items = buildContextMenuTemplate(
      params({ isEditable: true, misspelledWord: "recieve", dictionarySuggestions: ["receive", "relieve"] }),
      actions,
    );
    assert.deepEqual(
      items.slice(0, 4).map((item) => item.label ?? item.type),
      ["receive", "relieve", "Add to Dictionary", "separator"],
    );
    items[0]?.click?.(undefined as never, undefined, undefined as never);
    items[2]?.click?.(undefined as never, undefined, undefined as never);
    assert.deepEqual(calls, ["replace:receive", "add:recieve"]);
  });

  it("adds Copy Link on a link", () => {
    const { calls, actions } = recorder();
    const items = buildContextMenuTemplate(params({ linkURL: "https://winlink.org/" }), actions);
    const copyLink = items.find((item) => item.label === "Copy Link");
    assert.ok(copyLink);
    copyLink.click?.(undefined as never, undefined, undefined as never);
    assert.deepEqual(calls, ["copy:https://winlink.org/"]);
  });
});

describe("buildPopupTemplate", () => {
  it("rebuilds items, separators and submenus, and reports the chosen id", () => {
    const chosen: string[] = [];
    const items = buildPopupTemplate(
      [
        { id: "read", label: "Mark as Read" },
        { type: "separator" },
        { label: "Move to", submenu: [{ id: "in", label: "Inbox", enabled: false }, { id: "f1", label: "Nets" }] },
      ],
      (id) => chosen.push(id),
    );
    assert.equal(items.length, 3);
    assert.equal(items[1]?.type, "separator");
    const submenu = items[2]?.submenu as ReturnType<typeof buildPopupTemplate>;
    assert.equal(submenu[0]?.enabled, false);
    submenu[1]?.click?.(undefined as never, undefined, undefined as never);
    assert.deepEqual(chosen, ["f1"]);
  });

  it("passes nothing through but labels, ids and enablement", () => {
    const items = buildPopupTemplate(
      [{ id: "x", label: "Quit", role: "quit", accelerator: "Cmd+Q" } as never, { label: "" }, null as never],
      () => {},
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.role, undefined);
    assert.equal(items[0]?.accelerator, undefined);
  });

  it("stops at a bounded depth", () => {
    const deep = { label: "a", submenu: [{ label: "b", submenu: [{ label: "c", submenu: [{ id: "d", label: "d" }] }] }] };
    const items = buildPopupTemplate([deep], () => {});
    const level2 = (items[0]?.submenu as ReturnType<typeof buildPopupTemplate>)[0];
    const level3 = (level2?.submenu as ReturnType<typeof buildPopupTemplate>)[0];
    assert.deepEqual(level3?.submenu, []);
  });
});
