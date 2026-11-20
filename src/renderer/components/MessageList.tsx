import type { MouseEvent } from "react";
import { List, type RowComponentProps } from "react-window";
import { EmptyState } from "./EmptyState.tsx";
import { MAIL_FOLDERS, MESSAGE_DRAG_TYPE, type MailFolderId } from "../features/mailbox/folders.ts";
import type { MailListRow } from "../hooks/useMailbox.ts";

/**
 * Row heights in pixels.
 *
 * Virtualisation has to know how tall a row is WITHOUT rendering it, so these
 * are set here and the row fills whatever slot it is given (`.msg` is
 * height:100%) rather than the two being declared separately and drifting.
 *
 * Search rows are taller because they carry a third line: the snippet showing
 * why the message matched.
 */
const ROW_HEIGHT = 58;
const SEARCH_ROW_HEIGHT = 78;

export interface MessageListProps {
  folder: MailFolderId;
  messages: MailListRow[];
  selectedMid: string | null;
  onSelect: (mid: string, box: MailFolderId) => void;
  onRebuild: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** True when `messages` holds search hits rather than a folder's contents. */
  searching: boolean;
  /** A search has been typed but its results have not arrived yet. */
  searchPending: boolean;
  /** The pane title. Defaults to the built-in folder's label. */
  title?: string;
  /** True for one of the operator's own folders, which explains itself when empty. */
  userFolder?: boolean;
  /** Right-click on a row. Not offered on drafts. */
  onRowContextMenu?: (row: MailListRow, event: MouseEvent) => void;
}

function folderLabel(id: string): string {
  return MAIL_FOLDERS.find((f) => f.id === id)?.label ?? id;
}

/**
 * How this message's time should read in a list.
 *
 * Same-day messages show a time and older ones a date, which is the convention
 * every mail client uses: in a list sorted newest first, the day is what
 * distinguishes old messages and the hour is what distinguishes today's.
 */
function listDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface RowProps {
  messages: MailListRow[];
  selectedMid: string | null;
  onSelect: (mid: string, box: MailFolderId) => void;
  /** Search spans every folder, so a hit has to say where it lives. */
  showFolder: boolean;
  onRowContextMenu?: (row: MailListRow, event: MouseEvent) => void;
}

/** One row. Rendered only while on screen, so it must be cheap. */
function MessageRow({
  index,
  style,
  messages,
  selectedMid,
  onSelect,
  showFolder,
  onRowContextMenu,
}: RowComponentProps<RowProps>) {
  const message = messages[index];
  if (!message) return null;

  const selected = message.mid === selectedMid;
  // Drafts are ours, not Pat's: they cannot be filed, so they do not drag.
  const movable = message.box !== "drafts";

  return (
    <div style={style}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className={`msg${selected ? " msg--selected" : ""}${message.unread ? " msg--unread" : ""}`}
        onClick={() => onSelect(message.mid, message.box)}
        draggable={movable}
        onDragStart={(event) => {
          event.dataTransfer.setData(MESSAGE_DRAG_TYPE, JSON.stringify({ box: message.box, mid: message.mid }));
          event.dataTransfer.effectAllowed = "move";
        }}
        onContextMenu={movable && onRowContextMenu ? (event) => onRowContextMenu(message, event) : undefined}
      >
        <span className="msg__dot" aria-hidden="true" />
        <span className="msg__main">
          <span className="msg__top">
            <span className="msg__from">{message.from || "Unknown sender"}</span>
            <span className="msg__date">{listDate(message.date)}</span>
          </span>
          <span className="msg__subject">{message.subject || "(no subject)"}</span>
          {/* The snippet is why this message matched, which the subject alone
              often does not explain. */}
          {message.snippet ? <span className="msg__snippet">{message.snippet}</span> : null}
        </span>
        {showFolder ? <span className="msg__folder">{message.folderName ?? folderLabel(message.box)}</span> : null}
        {message.attachments.length ? (
          <span
            className="msg__clip"
            aria-label={`${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`}
          >
            📎
          </span>
        ) : null}
        {message.unread ? <span className="sr-only">Unread</span> : null}
      </button>
    </div>
  );
}

/**
 * The message list pane, read from the local cache.
 *
 * Virtualised: only the rows on screen exist in the DOM, so a mailbox of any
 * size scrolls at the same speed.
 */
export function MessageList({
  folder,
  messages,
  selectedMid,
  onSelect,
  onRebuild,
  query,
  onQueryChange,
  searching,
  searchPending,
  title,
  userFolder = false,
  onRowContextMenu,
}: MessageListProps) {
  const label = title ?? folderLabel(folder);
  const unread = messages.filter((m) => m.unread).length;

  const subtitle = searching
    ? searchPending
      ? " — searching…"
      : messages.length === 0
        ? " — no matches"
        : ` — ${messages.length} match${messages.length === 1 ? "" : "es"} in all folders`
    : messages.length === 0
      ? " — no messages"
      : unread > 0
        ? ` — ${messages.length} message${messages.length === 1 ? "" : "s"}, ${unread} unread`
        : ` — ${messages.length} message${messages.length === 1 ? "" : "s"}`;

  return (
    <section className="pane pane--bordered" aria-label={`${label} messages`}>
      <header className="pane__header">
        <div>
          <span className="pane__title">{searching ? "Search" : label}</span>
          <span className="pane__subtitle">{subtitle}</span>
        </div>
        {/* The recovery path for a cache that has drifted from Pat. Safe by
            construction: everything in it is a mirror of files Pat owns. */}
        <button
          type="button"
          className="btn btn--small"
          onClick={onRebuild}
          title="Re-read every folder from the protocol engine"
        >
          Rebuild index
        </button>
      </header>

      <div className="msgsearch">
        <input
          type="search"
          className="msgsearch__input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search all folders"
          aria-label="Search all folders"
          spellCheck={false}
        />
      </div>

      <div className="msglist">
        {messages.length === 0 ? (
          searching ? (
            // "Nothing matched" must not flash between keystrokes: results are
            // debounced, so an empty list means nothing until they land.
            <EmptyState
              glyph="🔍"
              title={searchPending ? "Searching…" : "Nothing matched"}
              detail={
                searchPending
                  ? undefined
                  : "Search looks at the sender, subject and body of every message in every folder."
              }
            />
          ) : userFolder ? (
            <EmptyState
              glyph="▢"
              title="This folder is empty"
              detail="Drag a message here, or right-click one and choose Move to."
            />
          ) : (
            <EmptyState
              glyph="✉"
              title="No messages yet"
              detail="Connect to a Winlink station to send and receive mail. Received messages will be listed here."
            />
          )
        ) : (
          <List
            role="listbox"
            aria-label={searching ? "Search results" : `${label} messages`}
            rowComponent={MessageRow}
            rowCount={messages.length}
            rowHeight={searching ? SEARCH_ROW_HEIGHT : ROW_HEIGHT}
            // The List measures its own element, and as a bare flex child it
            // would size to its content -- which is sized from that measurement.
            // Without this it can settle at zero height and render nothing.
            style={{ flex: 1, minHeight: 0 }}
            rowProps={{ messages, selectedMid, onSelect, showFolder: searching, onRowContextMenu }}
            // Keyed by folder and id together: the same MID can legitimately
            // exist in two folders, and search shows both at once.
            rowKey={(index) => `${messages[index]?.box}/${messages[index]?.mid}`}
          />
        )}
      </div>
    </section>
  );
}
