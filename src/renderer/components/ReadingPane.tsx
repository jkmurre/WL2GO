import { useEffect, useState } from "react";
import { EmptyState } from "./EmptyState.tsx";
import { MessageActions, type MessageAction } from "./MessageActions.tsx";
import { parseMessageBody, type BodyInline } from "../../shared/messageBody.ts";
import type { MailMessage } from "../../shared/ipcContract.ts";

export interface ReadingPaneProps {
  message: MailMessage | null;
  loading: boolean;
  error: string | null;
  onArchive: () => void;
  onDeletePermanently: () => void;
  onMarkUnread: () => void;
  /** Opens the Move-to menu for this message, at the pointer. */
  onMove: () => void;
  /** Pulls a queued (Outbox) message back into a draft for editing. */
  onEdit: () => void;
  /** Why Edit is unavailable right now, e.g. a session is running. Null when it is. */
  editBlocked: string | null;
  onSaveAttachment: (name: string) => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onForwardUnchanged: () => void;
  /** Resolves true only if the acknowledgement actually reached Pat. */
  onAcknowledge: () => Promise<boolean>;
}

function fullDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line of body text, as spans and links. */
function Line({ runs }: { runs: BodyInline[] }) {
  return (
    <div className="reader__line">
      {runs.map((run, index) =>
        run.kind === "link" ? (
          <a
            key={index}
            href={run.href}
            className="reader__link"
            onClick={(event) => {
              // Never navigate the app itself: a message body must not be able
              // to replace the window it is being read in. Main re-checks the
              // scheme before handing it to the OS.
              event.preventDefault();
              void window.wl2go.app.openExternal({ url: run.href }).catch(() => {
                /* refused schemes are logged in main; nothing useful to show */
              });
            }}
          >
            {run.text}
          </a>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </div>
  );
}

/**
 * The message body.
 *
 * Built from React elements, never from markup. Winlink bodies are plain text
 * -- Pat's BodyHTML is HTML it generates from this same text -- so there is no
 * document to sanitise, and no `dangerouslySetInnerHTML` anywhere in the app.
 */
function Body({ text }: { text: string }) {
  const paragraphs = parseMessageBody(text);

  return (
    <div className="reader__body">
      {paragraphs.map((paragraph, index) => (
        <div
          key={index}
          className={paragraph.quoteDepth > 0 ? "reader__para reader__para--quoted" : "reader__para"}
          // Quote nesting is shown by indentation rather than by repeating the
          // ">" characters the operator did not type.
          style={paragraph.quoteDepth > 0 ? { marginLeft: `${Math.min(paragraph.quoteDepth, 4) * 14}px` } : undefined}
        >
          {paragraph.lines.map((runs, line) => (
            <Line key={line} runs={runs} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The reading pane.
 *
 * Delete means Archive everywhere except Archive itself, where it is final and
 * confirmed -- Pat has no trash folder, so nothing here may destroy a message
 * on a single click.
 */
export function ReadingPane({
  message,
  loading,
  error,
  onArchive,
  onDeletePermanently,
  onMarkUnread,
  onMove,
  onEdit,
  editBlocked,
  onSaveAttachment,
  onReply,
  onReplyAll,
  onForward,
  onForwardUnchanged,
  onAcknowledge,
}: ReadingPaneProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);

  // A new message clears the "acknowledged" note from the last one.
  useEffect(() => {
    setAcknowledged(false);
    setAcknowledging(false);
  }, [message?.box, message?.mid]);

  if (error) {
    return (
      <section className="pane" aria-label="Message">
        <div className="pane__scroll">
          <EmptyState glyph="⚠" title="That message could not be opened" detail={error} />
        </div>
      </section>
    );
  }

  if (!message) {
    return (
      <section className="pane" aria-label="Message">
        <div className="pane__scroll">
          <EmptyState
            glyph="🖅"
            title={loading ? "Opening…" : "No message selected"}
            detail={loading ? undefined : "Select a message to read it here."}
          />
        </div>
      </section>
    );
  }

  const inArchive = message.box === "archive";
  // The operator's own message, waiting for the next session. Replying to it,
  // acknowledging it or marking it unread would all be meaningless.
  const queued = message.box === "out";

  // One array, two presentations. The row in the header and the menu it folds
  // into below a narrow window are rendered from this same list, so they
  // cannot drift apart as actions are added.
  const queuedActions: MessageAction[] = [
    {
      key: "edit",
      label: "Edit",
      title: editBlocked ?? "Take this message out of the Outbox and edit it",
      disabled: editBlocked !== null,
      onClick: onEdit,
    },
    { key: "print", label: "Print", title: "Print this message", onClick: () => window.print() },
    {
      key: "delete",
      label: "Delete",
      title: "Take this message out of the Outbox and move it to Archive",
      onClick: onArchive,
    },
  ];

  const actions: MessageAction[] = queued ? queuedActions : [
    { key: "reply", label: "Reply", onClick: onReply },
    { key: "reply-all", label: "Reply all", title: "Reply to everyone copied", onClick: onReplyAll },
    { key: "forward", label: "Forward", onClick: onForward },
    // Distinct from Forward on purpose: this one sends the message as it
    // arrived, and asks only for recipients.
    {
      key: "forward-unchanged",
      label: "Fwd unchanged",
      title: "Send this message on exactly as it was received",
      onClick: onForwardUnchanged,
    },
    // The label follows what actually happened, not what was clicked. A button
    // reading "Acknowledged" when Pat was down would be the worst thing this
    // feature could do on a net.
    {
      key: "acknowledge",
      label: acknowledged ? "Acknowledged" : acknowledging ? "Acknowledging\u2026" : "Acknowledge",
      title: "Queue an acknowledgement to the sender",
      disabled: acknowledged || acknowledging,
      onClick: () => {
        setAcknowledging(true);
        void onAcknowledge()
          .then((ok) => setAcknowledged(ok))
          .finally(() => setAcknowledging(false));
      },
    },
    { key: "mark-unread", label: "Mark unread", onClick: onMarkUnread },
    { key: "move", label: "Move to…", title: "File this message in another folder", onClick: onMove },
    // Paper, from the renderer. A Winlink message read on a net often has to
    // leave the screen, and window.print() with the @media print block at the
    // end of global.css needs no main-process round trip to do it.
    {
      key: "print",
      label: "Print",
      title: "Print this message",
      onClick: () => window.print(),
    },
    // Delete means Archive everywhere except Archive itself, where it is final
    // and confirmed.
    inArchive
      ? {
          key: "delete",
          label: "Delete permanently",
          title: "Remove this message permanently",
          danger: true,
          onClick: () => setConfirmingDelete(true),
        }
      : {
          key: "delete",
          label: "Delete",
          title: "Move this message to Archive",
          onClick: onArchive,
        },
  ];

  return (
    <section className="pane" aria-label="Message">
      <MessageActions title="Message" actions={actions} />

      {/* Confirmed because it cannot be undone: Pat removes the file outright
          and there is no trash folder anywhere in the stack. */}
      {confirmingDelete ? (
        <div className="reader__confirm" role="alertdialog" aria-label="Confirm permanent deletion">
          <div>
            Delete <strong>{message.subject || "(no subject)"}</strong> permanently? This cannot be undone.
          </div>
          <div className="reader__confirm-actions">
            <button
              type="button"
              className="btn btn--danger btn--small"
              onClick={() => {
                setConfirmingDelete(false);
                onDeletePermanently();
              }}
            >
              Delete permanently
            </button>
            <button type="button" className="btn btn--small" onClick={() => setConfirmingDelete(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      <div className="pane__scroll reader">
        <h1 className="reader__subject">{message.subject || "(no subject)"}</h1>

        <dl className="reader__meta">
          <dt>From</dt>
          <dd>{message.from || "Unknown sender"}</dd>
          <dt>To</dt>
          <dd>{message.to.length ? message.to.join(", ") : "—"}</dd>
          {message.cc.length ? (
            <>
              <dt>Cc</dt>
              <dd>{message.cc.join(", ")}</dd>
            </>
          ) : null}
          <dt>Date</dt>
          <dd>{fullDate(message.date)}</dd>
        </dl>

        {queued ? (
          <div className="reader__flag">Queued — this goes out on the next session. Edit to change it.</div>
        ) : null}

        {message.p2pOnly ? (
          <div className="reader__flag">Peer-to-peer only — this message is not relayed through the CMS.</div>
        ) : null}

        {message.attachments.length ? (
          <div className="reader__files">
            <div className="reader__files-title">
              {message.attachments.length} attachment{message.attachments.length === 1 ? "" : "s"}
            </div>
            <ul>
              {message.attachments.map((file) => (
                <li key={file.name}>
                  <span className="reader__file-name">{file.name}</span>
                  <span className="reader__file-size">{fileSize(file.sizeBytes)}</span>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => onSaveAttachment(file.name)}
                    title={`Save ${file.name}`}
                  >
                    Save
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {message.body === null ? (
          <div className="reader__empty-body">{loading ? "Loading the message…" : "This message has no text."}</div>
        ) : (
          <Body text={message.body} />
        )}
      </div>
    </section>
  );
}
