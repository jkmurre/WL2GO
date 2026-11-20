import { useEffect, useRef, useState } from "react";
import {
  MAX_SUBJECT_LENGTH,
  addressWarnings,
  internetRecipients,
  validateDraft,
  type ComposeAttachment,
  type ComposeDraft,
} from "../../../shared/composeModel.ts";
import type { RecentContact } from "../../../shared/ipcContract.ts";
import { AddressInput } from "../../components/AddressInput.tsx";

export interface ComposeFormProps {
  draft: ComposeDraft;
  /**
   * An updater, never a value: a file picker resolves long after it opened, and
   * writing back the draft it captured would undo everything typed meanwhile.
   */
  onChange: (update: (current: ComposeDraft) => ComposeDraft) => void;
  /** In the reading pane, or filling a pop-out window. */
  variant: "inline" | "window";
  /** What is being written: "Reply", "New message"... */
  title: string;
  /** Recipients are the only editable field for Forward Without Changes. */
  recipientsOnly?: boolean;
  /** A failure from outside the form -- a save or a file pick. */
  error?: string | null;
  onSave: (draft: ComposeDraft) => void;
  onSend: (draft: ComposeDraft) => Promise<string[]>;
  onAttach: (draft: ComposeDraft) => Promise<ComposeAttachment[]>;
  onDiscard: (draft: ComposeDraft) => void;
  /** Moves the draft into its own window. Absent where it already is one. */
  onPopOut?: () => void;
  /** Why Pop out is unavailable right now. Null when it is. */
  popOutBlocked?: string | null;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const IMAGE_PATTERN = /\.(jpe?g|png|gif|bmp|webp)$/i;

/**
 * The compose form, wherever it is shown: inline in the reading pane for a
 * reply or forward, or filling a pop-out window for a new message.
 *
 * Controlled: the draft belongs to whoever hosts the form, so popping out,
 * moving to another message or quitting always has the latest text to keep.
 */
export function ComposeForm({
  draft,
  onChange,
  variant,
  title,
  recipientsOnly = false,
  error = null,
  onSave,
  onSend,
  onAttach,
  onDiscard,
  onPopOut,
  popOutBlocked = null,
}: ComposeFormProps) {
  const [problems, setProblems] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [contacts, setContacts] = useState<RecentContact[]>([]);

  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // A different draft opened into the same pane -- reply after reply. Problems
  // reported against the last one say nothing about this one.
  useEffect(() => setProblems([]), [draft.id]);

  // Once per draft, not autoFocus: an inline compose reused for the next reply
  // would not remount, so autoFocus would never fire again. A message with
  // recipients already -- a reply -- starts in the body, above the quote, where
  // every mail client puts the cursor; buildReply leaves the blank lines for it.
  useEffect(() => {
    const body = bodyRef.current;
    if (draft.to && body && !body.disabled) {
      body.focus();
      body.setSelectionRange(0, 0);
      body.scrollTop = 0;
    } else {
      document.getElementById("compose-to")?.focus();
    }
  }, [draft.id]);

  // Read once per open. Suggestions are a convenience: if the mailbox is not
  // ready, the fields work exactly as before, just without them.
  useEffect(() => {
    void window.wl2go.mailbox.recentContacts().then(setContacts, () => {});
  }, []);

  const set = <K extends keyof ComposeDraft>(key: K, value: ComposeDraft[K]) =>
    onChange((current) => ({ ...current, [key]: value }));

  // In recipientsOnly mode the subject and body cannot be edited, so a problem
  // reported against either would leave Send disabled with no way to fix it.
  // Only the recipient field is actionable there.
  const localProblems = validateDraft(draft).filter((problem) => !recipientsOnly || problem.field === "to");
  const subjectOver = draft.subject.length > MAX_SUBJECT_LENGTH;

  // Pat re-encodes images as it receives them: anything wider than 600px is
  // scaled and re-encoded as quality-40 JPEG. Sensible for RF, and invisible --
  // so it is said here rather than discovered in the Sent folder.
  const hasImage = draft.attachments.some((file) => IMAGE_PATTERN.test(file.name));

  // Notes, not problems: these never disable Send. See addressWarnings.
  const warnings = addressWarnings(draft);
  const internet = internetRecipients(draft);

  async function send() {
    setSending(true);
    try {
      const failures = await onSend(draft);
      setProblems(failures);
    } finally {
      setSending(false);
    }
  }

  const shown = error ? [error, ...problems] : problems;

  return (
    // Inline it takes the reading pane's place, so it is laid out as one.
    <section className={`compose compose--${variant}${variant === "inline" ? " pane" : ""}`} aria-label={title}>
      <div className="compose__bar">
        <div className="compose__heading">
          <span className="compose__title">{title}</span>
          {draft.subject.trim() ? <span className="compose__subject">{draft.subject}</span> : null}
        </div>
        <div className="compose__actions">
          {onPopOut ? (
            <button
              type="button"
              className="btn btn--small"
              onClick={onPopOut}
              disabled={popOutBlocked !== null || sending}
              title={popOutBlocked ?? "Open this message in its own window"}
            >
              Pop out
            </button>
          ) : null}
          <button type="button" className="btn btn--danger btn--small" onClick={() => onDiscard(draft)}>
            Discard
          </button>
          {/* Saves rather than asks: a draft cannot be sent by accident, so
              keeping it is always the safer default. */}
          <button type="button" className="btn btn--small" onClick={() => onSave(draft)} disabled={sending}>
            Save as draft
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => void send()}
            disabled={sending || localProblems.length > 0}
            title={localProblems[0]?.message}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>

      <div className="compose__scroll">
        {recipientsOnly ? (
          <p className="compose__detail">
            The message will be sent exactly as it was received. Only the recipients are yours to choose.
          </p>
        ) : null}

        {shown.length ? (
          <div className="settings__error">
            {shown.map((problem) => (
              <div key={problem}>{problem}</div>
            ))}
          </div>
        ) : null}

        <div className="compose__row">
          <label className="compose__label" htmlFor="compose-to">
            To
          </label>
          <div className="compose__control">
            <AddressInput
              id="compose-to"
              value={draft.to}
              onChange={(value) => set("to", value)}
              contacts={contacts}
              placeholder="W1AW, K1ABC, ops@example.org"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="field__help">
              Callsigns, tactical addresses or ordinary email addresses. Separate them with a space, comma or
              semicolon.
            </div>
          </div>
        </div>

        {recipientsOnly ? null : (
          <div className="compose__row">
            <label className="compose__label" htmlFor="compose-cc">
              Cc
            </label>
            <div className="compose__control">
              <AddressInput
                id="compose-cc"
                value={draft.cc}
                onChange={(value) => set("cc", value)}
                contacts={contacts}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {warnings.length ? (
          <div className="compose__notice compose__notice--warn">
            {warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        ) : null}

        {/* Winlink rejects internet mail from anyone not on the recipient's
            accept list, and the CMS adds the people you write to for you. That
            is invisible from here, and it is the difference between a reply
            arriving and a bounce the operator never sees. */}
        {internet.length && !draft.p2pOnly ? (
          <div className="compose__notice">
            Winlink adds {internet.join(", ")} to your accept list when this is sent, so a reply can reach you.
            Entries expire after six months without use.
          </div>
        ) : null}

        <div className="compose__row">
          <label className="compose__label" htmlFor="compose-subject">
            Subject
          </label>
          <div className="compose__control">
            <input
              id="compose-subject"
              className={`field__input${subjectOver ? " field__input--invalid" : ""}`}
              value={draft.subject}
              onChange={(e) => set("subject", e.target.value)}
              disabled={recipientsOnly}
              aria-invalid={subjectOver ? true : undefined}
            />
            <div className="field__help">
              {subjectOver
                ? `Winlink allows ${MAX_SUBJECT_LENGTH} characters; this is ${draft.subject.length}.`
                : "Required — Winlink rejects a message with no subject."}
            </div>
          </div>
        </div>

        <textarea
          ref={bodyRef}
          id="compose-body"
          className="field__input compose__body"
          aria-label="Message"
          value={draft.body}
          onChange={(e) => set("body", e.target.value)}
          disabled={recipientsOnly}
          spellCheck
        />

        <div className="compose__files">
          <div className="compose__files-row">
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void onAttach(draft).then((files) => set("attachments", files))}
              disabled={recipientsOnly}
            >
              Attach files
            </button>
            <label className="compose__p2p">
              <input
                type="checkbox"
                checked={draft.p2pOnly}
                onChange={(e) => set("p2pOnly", e.target.checked)}
                disabled={recipientsOnly}
              />
              Peer-to-peer only
            </label>
          </div>

          {draft.attachments.length ? (
            <ul className="compose__file-list">
              {draft.attachments.map((file) => (
                <li key={file.name}>
                  <span className="reader__file-name">{file.name}</span>
                  <span className="reader__file-size">{fileSize(file.sizeBytes)}</span>
                  {recipientsOnly ? null : (
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() =>
                        onChange((current) => ({
                          ...current,
                          attachments: current.attachments.filter((f) => f.name !== file.name),
                        }))
                      }
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {hasImage ? (
            <div className="compose__notice">
              Images are reduced before sending — scaled to 600 pixels wide and re-encoded as JPEG. That is what keeps
              a photo small enough to move over radio.
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
