import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComposeWindows, type ComposeWindowHandle } from "./composeWindows.ts";
import { emptyDraft, type ComposeDraft } from "../../shared/composeModel.ts";

class FakeWindow implements ComposeWindowHandle {
  focused = 0;
  closedCount = 0;
  readonly id: number;
  private readonly onClose: (id: number) => void;
  constructor(id: number, onClose: (id: number) => void) {
    this.id = id;
    this.onClose = onClose;
  }
  focus() {
    this.focused += 1;
  }
  close() {
    this.closedCount += 1;
    this.onClose(this.id);
  }
}

function setup() {
  const saved: ComposeDraft[] = [];
  const windows: FakeWindow[] = [];
  let nextId = 100;
  const registry: ComposeWindows = new ComposeWindows({
    createWindow: () => {
      const window = new FakeWindow(nextId++, (id) => registry.closed(id));
      windows.push(window);
      return window;
    },
    save: (draft) => saved.push(draft),
  });
  return { registry, saved, windows };
}

function draft(id: string, body = ""): ComposeDraft {
  return { ...emptyDraft(id), body };
}

describe("ComposeWindows", () => {
  it("opens a window on a draft and hands it the draft", () => {
    const { registry, windows } = setup();
    registry.open({ draft: draft("a"), recipientsOnly: true });

    assert.equal(windows.length, 1);
    assert.deepEqual(registry.init(windows[0]!.id), { draft: draft("a"), recipientsOnly: true });
  });

  it("focuses the window already holding a draft instead of opening another", () => {
    const { registry, windows } = setup();
    registry.open({ draft: draft("a"), recipientsOnly: false });
    registry.open({ draft: draft("a"), recipientsOnly: false });

    assert.equal(windows.length, 1);
    assert.equal(windows[0]!.focused, 1);
    assert.equal(registry.focus("a"), true);
    assert.equal(registry.focus("b"), false);
  });

  it("gives a reloaded window its latest text", () => {
    const { registry, windows } = setup();
    registry.open({ draft: draft("a"), recipientsOnly: false });
    registry.stash(windows[0]!.id, draft("a", "edited"), true);

    assert.equal(registry.init(windows[0]!.id)?.draft.body, "edited");
  });

  it("keeps a pop-out's draft when the window is closed, even unedited", () => {
    const { registry, saved, windows } = setup();
    registry.open({ draft: draft("a"), recipientsOnly: false });
    windows[0]!.close();

    assert.deepEqual(saved.map((d) => d.id), ["a"]);
    assert.equal(registry.init(windows[0]!.id), null);
  });

  it("keeps the latest stashed text, not the text it opened with", () => {
    const { registry, saved, windows } = setup();
    registry.open({ draft: draft("a"), recipientsOnly: false });
    registry.stash(windows[0]!.id, draft("a", "second"), true);
    windows[0]!.close();

    assert.equal(saved[0]?.body, "second");
  });

  it("does not keep a draft after a quiet close (Send, Discard, Save)", () => {
    const { registry, saved, windows } = setup();
    registry.open({ draft: draft("a"), recipientsOnly: false });
    registry.closeQuietly(windows[0]!.id);

    assert.equal(windows[0]!.closedCount, 1);
    assert.equal(saved.length, 0);
    assert.equal(registry.focus("a"), false);
  });

  it("keeps an inline draft on close only once it has been edited", () => {
    const { registry, saved } = setup();
    registry.stash(1, draft("untouched"), false);
    registry.closed(1);
    assert.equal(saved.length, 0);

    registry.stash(1, draft("edited", "hello"), true);
    registry.closed(1);
    assert.deepEqual(saved.map((d) => d.id), ["edited"]);
  });

  it("forgets an inline draft that was cleared", () => {
    const { registry, saved } = setup();
    registry.stash(1, draft("a", "x"), true);
    registry.stash(1, null, false);
    registry.closed(1);

    assert.equal(saved.length, 0);
  });

  it("does not treat an inline draft as an open window", () => {
    const { registry } = setup();
    registry.stash(1, draft("a"), true);

    assert.equal(registry.focus("a"), false);
    assert.equal(registry.init(1), null);
  });

  it("keeps every held draft on quit, once", () => {
    const { registry, saved, windows } = setup();
    registry.open({ draft: draft("pop"), recipientsOnly: false });
    registry.stash(1, draft("inline", "x"), true);
    registry.stash(2, draft("clean"), false);

    registry.flushAll();
    registry.flushAll();
    windows[0]!.close();

    assert.deepEqual(saved.map((d) => d.id).sort(), ["inline", "pop"]);
  });

  it("logs rather than throws when a draft cannot be kept", () => {
    const logs: string[] = [];
    const registry = new ComposeWindows({
      createWindow: () => new FakeWindow(5, () => {}),
      save: () => {
        throw new Error("no callsign");
      },
      onLog: (message) => logs.push(message),
    });
    registry.open({ draft: draft("a"), recipientsOnly: false });

    assert.doesNotThrow(() => registry.closed(5));
    assert.match(logs[0] ?? "", /no callsign/);
  });
});
