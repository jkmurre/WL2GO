// The right-click menu: Cut/Copy/Paste, spelling suggestions, Copy Link.
//
// Electron shows no context menu at all unless the app builds one. Only a
// type-only Electron import here, so it runs under `node --test`; index.ts
// wires it to the window.

import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import type { PopupMenuItem } from "../shared/ipcContract.ts";

/** What the menu items do beyond the built-in roles, injected so tests need no Electron. */
export interface ContextMenuActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
  copyText(text: string): void;
}

type MenuParams = Pick<
  ContextMenuParams,
  "isEditable" | "selectionText" | "linkURL" | "misspelledWord" | "dictionarySuggestions" | "editFlags"
>;

export function buildContextMenuTemplate(
  params: MenuParams,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const separate = () => {
    if (items.length > 0 && items[items.length - 1]?.type !== "separator") items.push({ type: "separator" });
  };

  if (params.isEditable) {
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
      }
      if (params.dictionarySuggestions.length === 0) items.push({ label: "No Guesses Found", enabled: false });
      const word = params.misspelledWord;
      items.push({ label: "Add to Dictionary", click: () => actions.addToDictionary(word) });
      separate();
    }
    const flags = params.editFlags;
    items.push(
      { role: "undo", enabled: flags.canUndo },
      { role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { role: "pasteAndMatchStyle", enabled: flags.canPaste },
      { role: "selectAll", enabled: flags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy" }, { role: "selectAll" });
  }

  if (params.linkURL) {
    separate();
    const url = params.linkURL;
    items.push({ label: "Copy Link", click: () => actions.copyText(url) });
  }

  return items;
}

/** Deep enough for "Move to ▸ folder", shallow enough that a bad request cannot recurse forever. */
const MAX_POPUP_DEPTH = 3;

/**
 * Turns a renderer-described popup menu into an Electron template.
 *
 * The description crosses the IPC boundary, so it is rebuilt field by field
 * rather than passed through: only labels, ids, separators, enablement and
 * submenus survive -- never a role, an accelerator or anything else Electron
 * would act on.
 */
export function buildPopupTemplate(
  items: readonly PopupMenuItem[],
  choose: (id: string) => void,
  depth = 0,
): MenuItemConstructorOptions[] {
  if (!Array.isArray(items) || depth >= MAX_POPUP_DEPTH) return [];
  return items.flatMap((item): MenuItemConstructorOptions[] => {
    if (typeof item !== "object" || item === null) return [];
    if (item.type === "separator") return [{ type: "separator" }];
    const label = typeof item.label === "string" ? item.label : "";
    if (!label) return [];
    const enabled = item.enabled !== false;
    if (Array.isArray(item.submenu)) {
      return [{ label, enabled, submenu: buildPopupTemplate(item.submenu, choose, depth + 1) }];
    }
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return [{ label, enabled: false }];
    return [{ label, enabled, click: () => choose(id) }];
  });
}
