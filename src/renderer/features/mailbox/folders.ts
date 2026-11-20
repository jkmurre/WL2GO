import type {
  MailBox,
  MailFolderId,
  MoveTarget,
  PopupMenuItem,
  UserFolder,
  UserFolderId,
} from "../../../shared/ipcContract.ts";
import { MAIL_BOXES } from "../../../shared/ipcContract.ts";

/**
 * Mailbox folders.
 *
 * Four of the five ids are Pat's own mailbox names as used by
 * /api/mailbox/{box}, so the cache layer and the UI share one vocabulary.
 * Drafts is the exception: it is ours alone, backed by a separate local
 * database, and never reaches Pat -- which is why `MailFolderId` is a wider
 * type than `MailBox` rather than an extension of it.
 */
export interface MailFolder {
  id: MailFolderId;
  label: string;
  glyph: string;
}

export const MAIL_FOLDERS: readonly MailFolder[] = [
  { id: "in", label: "Inbox", glyph: "▤" },
  { id: "drafts", label: "Drafts", glyph: "✎" },
  { id: "out", label: "Outbox", glyph: "▦" },
  { id: "sent", label: "Sent", glyph: "▷" },
  { id: "archive", label: "Archive", glyph: "▣" },
];

export type { MailFolderId };

/** The sidebar id for one of the operator's own folders. */
export function userFolderId(id: string): UserFolderId {
  return `folder:${id}`;
}

/** The store id behind a sidebar id, or null for a built-in folder. */
export function userFolderOf(id: MailFolderId): string | null {
  return id.startsWith("folder:") ? id.slice("folder:".length) : null;
}

/** Built-in folders a message can be dropped on or moved to. Not Drafts or Outbox. */
export const MOVE_TARGET_BOXES = ["in", "sent", "archive"] as const;
export type MoveTargetBox = (typeof MOVE_TARGET_BOXES)[number];

export function isMoveTargetBox(id: MailFolderId): id is MoveTargetBox {
  return (MOVE_TARGET_BOXES as readonly string[]).includes(id);
}

/** The Move-to target a sidebar folder stands for, or null if nothing can be moved there. */
export function moveTargetFor(id: MailFolderId): MoveTarget | null {
  const folderId = userFolderOf(id);
  if (folderId) return { folderId };
  return isMoveTargetBox(id) ? { box: id } : null;
}

/** The drag type a message row carries, so drops from elsewhere are ignored. */
export const MESSAGE_DRAG_TYPE = "application/x-wl2go-message";

export interface DraggedMessage {
  box: MailBox;
  mid: string;
}

export function readDraggedMessage(data: DataTransfer): DraggedMessage | null {
  try {
    const parsed: unknown = JSON.parse(data.getData(MESSAGE_DRAG_TYPE));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { box, mid } = parsed as Record<string, unknown>;
    if (typeof mid !== "string" || !mid) return null;
    if (box !== "in" && box !== "out" && box !== "sent" && box !== "archive") return null;
    return { box, mid };
  } catch {
    return null;
  }
}

/**
 * The "Move to" submenu for a message currently in `location`.
 *
 * Ids are "move:in" etc., "move:folder:<id>" and "move:new"; parseMoveChoice
 * reads them back. The message's current place is shown but disabled.
 */
export function moveSubmenu(location: MailFolderId, folders: readonly UserFolder[]): PopupMenuItem[] {
  const items: PopupMenuItem[] = MOVE_TARGET_BOXES.map((box) => ({
    id: `move:${box}`,
    label: MAIL_FOLDERS.find((f) => f.id === box)?.label ?? box,
    enabled: box !== location,
  }));
  if (folders.length) {
    items.push({ type: "separator" });
    for (const folder of folders) {
      items.push({
        id: `move:folder:${folder.id}`,
        label: folder.name,
        enabled: userFolderId(folder.id) !== location,
      });
    }
  }
  items.push({ type: "separator" }, { id: "move:new", label: "New Folder…" });
  return items;
}

export function parseMoveChoice(choice: string | null): MoveTarget | "new" | null {
  if (!choice?.startsWith("move:")) return null;
  const rest = choice.slice("move:".length);
  if (rest === "new") return "new";
  if (rest.startsWith("folder:")) return { folderId: rest.slice("folder:".length) };
  return rest === "in" || rest === "sent" || rest === "archive" ? { box: rest } : null;
}

/** Narrows a sidebar id to one of Pat's folders, or null for Drafts and user folders. */
export function asMailBox(id: MailFolderId): MailBox | null {
  return (MAIL_BOXES as readonly string[]).includes(id) ? (id as MailBox) : null;
}
