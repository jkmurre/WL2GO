// The pop-out compose windows, and every unsent draft a window is holding.
//
// Electron-free -- the BrowserWindow is made by a factory index.ts passes in --
// so this is testable under `node --test`.
//
// Each renderer that is composing pushes its draft here as it changes (the
// "stash"). That is what lets closing a window, or quitting the app, keep the
// message without a round trip to a renderer that may already be going away:
// quit with subprocesses running ends in app.exit(), which never asks a window
// to close at all.

import type { ComposeDraft } from "../../shared/composeModel.ts";
import type { ComposeWindowInit } from "../../shared/ipcContract.ts";

/** The slice of a BrowserWindow this needs. */
export interface ComposeWindowHandle {
  /** The window's webContents id: what an IPC sender is matched against. */
  id: number;
  focus(): void;
  close(): void;
}

export interface ComposeWindowsOptions {
  /** Makes and loads a compose window. The caller reports its close via closed(). */
  createWindow: () => ComposeWindowHandle;
  save: (draft: ComposeDraft) => void;
  onLog?: (message: string) => void;
}

interface Entry {
  /** Null for the main window's inline compose, which this does not own. */
  window: ComposeWindowHandle | null;
  recipientsOnly: boolean;
  /** The latest text, or null once it has been sent, discarded or saved. */
  draft: ComposeDraft | null;
  /**
   * Whether closing keeps the draft. A pop-out always does, like the modal's
   * close button before it. An inline compose only once it has been edited: a
   * reply opened and walked away from is not a draft anyone wrote.
   */
  keep: boolean;
}

export class ComposeWindows {
  private readonly entries = new Map<number, Entry>();
  private readonly opts: ComposeWindowsOptions;

  constructor(opts: ComposeWindowsOptions) {
    this.opts = opts;
  }

  /** Opens a window on a draft, or focuses the one that already has it. */
  open(init: ComposeWindowInit): void {
    if (this.focus(init.draft.id)) return;
    const window = this.opts.createWindow();
    this.entries.set(window.id, {
      window,
      recipientsOnly: init.recipientsOnly,
      draft: init.draft,
      keep: true,
    });
  }

  /** What a compose window opens on. Its latest text, should it reload. */
  init(senderId: number): ComposeWindowInit | null {
    const entry = this.entries.get(senderId);
    if (!entry?.window || !entry.draft) return null;
    return { draft: entry.draft, recipientsOnly: entry.recipientsOnly };
  }

  /** Records a renderer's current draft. Null means there is nothing left to keep. */
  stash(senderId: number, draft: ComposeDraft | null, dirty: boolean): void {
    const entry = this.entries.get(senderId);
    if (entry?.window) {
      entry.draft = draft;
      return;
    }
    if (!draft) this.entries.delete(senderId);
    else this.entries.set(senderId, { window: null, recipientsOnly: false, draft, keep: dirty });
  }

  /** Brings forward the window holding a draft. False if no window has it. */
  focus(draftId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.window && entry.draft?.id === draftId) {
        entry.window.focus();
        return true;
      }
    }
    return false;
  }

  /**
   * Closes a window WITHOUT keeping its draft: after Send, Discard or Save,
   * each of which has already dealt with it. Forgotten first, or the close
   * would save a sent message straight back into Drafts.
   */
  closeQuietly(senderId: number): void {
    const entry = this.entries.get(senderId);
    if (!entry?.window) return;
    entry.draft = null;
    entry.window.close();
  }

  /** A window -- compose or main -- is closing. Keeps what it held. */
  closed(senderId: number): void {
    const entry = this.entries.get(senderId);
    if (!entry) return;
    this.keep(entry);
    this.entries.delete(senderId);
  }

  /** Keeps every held draft. On quit; safe to call twice. */
  flushAll(): void {
    for (const entry of this.entries.values()) this.keep(entry);
  }

  private keep(entry: Entry): void {
    const draft = entry.draft;
    entry.draft = null;
    if (!draft || !entry.keep) return;
    try {
      this.opts.save(draft);
    } catch (err: unknown) {
      this.opts.onLog?.(`Could not keep draft ${draft.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
