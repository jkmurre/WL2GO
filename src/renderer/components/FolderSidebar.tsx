import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { MoveTarget, PopupMenuItem, UserFolder } from "../../shared/ipcContract.ts";
import {
  MAIL_FOLDERS,
  MESSAGE_DRAG_TYPE,
  moveTargetFor,
  readDraggedMessage,
  userFolderId,
  type DraggedMessage,
  type MailFolderId,
} from "../features/mailbox/folders.ts";
import { ipcMessage } from "../hooks/useConfig.ts";

export interface FolderSidebarProps {
  selected: MailFolderId;
  onSelect: (id: MailFolderId) => void;
  /** Per-folder message counts. Null until the mailbox cache exists (Module 4). */
  counts: Partial<Record<MailFolderId, number>> | null;
  /** The operator's own folders. Null until loaded. */
  folders: UserFolder[] | null;
  /** True while the New Folder field is open, which App can also request. */
  creating: boolean;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  /** Rejects with a message to show beside the field. */
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDropMessage: (message: DraggedMessage, target: MoveTarget) => void;
}

/** The glyph for an operator's folder; the built-ins each have their own. */
const USER_FOLDER_GLYPH = "▢";

export function FolderSidebar({
  selected,
  onSelect,
  counts,
  folders,
  creating,
  onStartCreate,
  onCancelCreate,
  onCreate,
  onRename,
  onDelete,
  onDropMessage,
}: FolderSidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<UserFolder | null>(null);
  const [dropTarget, setDropTarget] = useState<MailFolderId | null>(null);

  const editing = creating || renamingId !== null || confirmingDelete !== null;

  const showMenu = async (event: MouseEvent, items: PopupMenuItem[], handle: (id: string) => void) => {
    // Without this the system Cut/Copy/Paste menu would open as well.
    event.preventDefault();
    event.stopPropagation();
    const choice = await window.wl2go.menu.popup({ items });
    if (choice) handle(choice);
  };

  const newFolderMenu = (event: MouseEvent) =>
    void showMenu(event, [{ id: "new", label: "New Folder…" }], () => onStartCreate());

  const folderMenu = (event: MouseEvent, folder: UserFolder) =>
    void showMenu(
      event,
      [
        { id: "rename", label: "Rename…" },
        { id: "delete", label: "Delete Folder…" },
        { type: "separator" },
        { id: "new", label: "New Folder…" },
      ],
      (choice) => {
        if (choice === "rename") setRenamingId(folder.id);
        else if (choice === "delete") setConfirmingDelete(folder);
        else onStartCreate();
      },
    );

  /** Drag handlers for a row that accepts dropped messages, if this one does. */
  const dropProps = (id: MailFolderId) => {
    const target = moveTargetFor(id);
    if (!target) return {};
    return {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(MESSAGE_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(id);
      },
      onDragLeave: (event: DragEvent) => {
        // Leaving for one of the row's own children is not leaving the row.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropTarget((current) => (current === id ? null : current));
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        setDropTarget(null);
        const message = readDraggedMessage(event.dataTransfer);
        if (message) onDropMessage(message, target);
      },
    };
  };

  const rowClass = (id: MailFolderId) =>
    `folder${id === selected ? " folder--selected" : ""}${id === dropTarget ? " folder--drop" : ""}`;

  return (
    <nav
      className={`sidebar${editing ? " sidebar--editing" : ""}`}
      aria-label="Mailbox folders"
      onContextMenu={newFolderMenu}
    >
      <div className="sidebar__heading">Mailbox</div>
      {MAIL_FOLDERS.map((folder) => {
        const count = counts?.[folder.id];
        return (
          <button
            key={folder.id}
            type="button"
            className={rowClass(folder.id)}
            aria-current={folder.id === selected ? "true" : undefined}
            onClick={() => onSelect(folder.id)}
            // The name survives the narrow layout, where the sidebar collapses
            // to a glyph rail and the label is hidden.
            title={folder.label}
            {...dropProps(folder.id)}
          >
            <span className="folder__glyph" aria-hidden="true">
              {folder.glyph}
            </span>
            <span className="folder__label">{folder.label}</span>
            {typeof count === "number" ? <span className="folder__count">{count}</span> : null}
          </button>
        );
      })}

      <div className="sidebar__heading sidebar__heading--section">Folders</div>
      {(folders ?? []).map((folder) => {
        const id = userFolderId(folder.id);
        if (renamingId === folder.id) {
          return (
            <FolderNameField
              key={folder.id}
              initial={folder.name}
              label={`Rename ${folder.name}`}
              onSubmit={async (name) => {
                await onRename(folder.id, name);
                setRenamingId(null);
              }}
              onCancel={() => setRenamingId(null)}
            />
          );
        }
        return (
          <div key={folder.id}>
            <button
              type="button"
              className={rowClass(id)}
              aria-current={id === selected ? "true" : undefined}
              onClick={() => onSelect(id)}
              onContextMenu={(event) => folderMenu(event, folder)}
              onDoubleClick={() => setRenamingId(folder.id)}
              title={folder.name}
              {...dropProps(id)}
            >
              <span className="folder__glyph" aria-hidden="true">
                {USER_FOLDER_GLYPH}
              </span>
              <span className="folder__label">{folder.name}</span>
              {folder.unread ? <span className="folder__count">{folder.unread}</span> : null}
            </button>
            {confirmingDelete?.id === folder.id ? (
              <div className="folder-confirm" role="alertdialog" aria-label={`Delete ${folder.name}`}>
                <span>
                  Delete “{folder.name}”?{" "}
                  {folder.total === 0
                    ? "It is empty."
                    : `Its ${folder.total} message${folder.total === 1 ? "" : "s"} will return to Archive.`}
                </span>
                <div className="folder-confirm__actions">
                  <button
                    type="button"
                    className="btn btn--small btn--danger"
                    onClick={() => {
                      setConfirmingDelete(null);
                      void onDelete(folder.id);
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" className="btn btn--small" onClick={() => setConfirmingDelete(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {creating ? (
        <FolderNameField initial="" label="New folder name" onSubmit={onCreate} onCancel={onCancelCreate} />
      ) : (
        <button type="button" className="folder folder--new" onClick={onStartCreate} title="New Folder">
          <span className="folder__glyph" aria-hidden="true">
            +
          </span>
          <span className="folder__label">New Folder</span>
        </button>
      )}
    </nav>
  );
}

interface FolderNameFieldProps {
  initial: string;
  label: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * An inline name field, for New Folder and Rename.
 *
 * Inline because Electron has no window.prompt, and a modal for one word would
 * be heavier than the job. Enter commits, Escape cancels, and a rejected name
 * (empty, duplicate) keeps the field open with the reason beneath it.
 */
function FolderNameField({ initial, label, onSubmit, onCancel }: FolderNameFieldProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = async () => {
    if (busy) return;
    if (value.trim() === initial.trim() && initial) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(value);
    } catch (err: unknown) {
      setError(ipcMessage(err));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="folder-field">
      <input
        ref={input}
        className="folder-field__input"
        value={value}
        aria-label={label}
        placeholder="Folder name"
        maxLength={64}
        spellCheck={false}
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        // Leaving an untouched field abandons it, as in Finder; leaving one
        // that was typed in keeps it, so a stray click does not lose the name.
        onBlur={() => {
          if ((!value.trim() || value === initial) && !error) onCancel();
        }}
        // A right-click here is for Cut/Copy/Paste, not the sidebar's menu.
        onContextMenu={(event) => event.stopPropagation()}
      />
      {error ? <div className="folder-field__error">{error}</div> : null}
    </div>
  );
}
