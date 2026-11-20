import { useCallback, useEffect, useState } from "react";
import type { ComposeAttachment, ComposeDraft } from "../../../shared/composeModel.ts";
import { EmptyState } from "../../components/EmptyState.tsx";
import { attachFiles, sendDraft } from "../../hooks/useCompose.ts";
import { ComposeForm } from "./ComposeForm.tsx";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A pop-out compose window: the whole renderer, when main opened it as one.
 *
 * Its own window so it can be dragged beside the mailbox and the operator can
 * read while writing. Closing it keeps the draft -- main does that, from the
 * copy stashed on every change, so it holds even when the app quits under it.
 * Send, Discard and Save close it through closeWindow, which does not.
 */
export function ComposeWindowApp() {
  // undefined while asking main; null if this window has nothing to show.
  const [draft, setDraft] = useState<ComposeDraft | null | undefined>(undefined);
  const [recipientsOnly, setRecipientsOnly] = useState(false);
  // Fixed at open: a new message stays "New message" once it has a subject.
  const [title, setTitle] = useState("New message");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.wl2go.compose.windowInit().then(
      (init) => {
        setDraft(init?.draft ?? null);
        setRecipientsOnly(init?.recipientsOnly ?? false);
        if (init?.recipientsOnly) setTitle("Forward without changes");
        // A draft reopened, a reply popped out, a queued message taken back.
        else if (init && (init.draft.to || init.draft.subject || init.draft.body)) setTitle("Message");
      },
      (err: unknown) => {
        setDraft(null);
        setError(message(err));
      },
    );
  }, []);

  useEffect(() => {
    if (!draft) return;
    document.title = draft.subject.trim() || title;
    void window.wl2go.compose.stash({ draft, dirty: true }).catch(() => {
      /* main still holds the text the window opened on */
    });
  }, [draft, title]);

  const update = useCallback((change: (current: ComposeDraft) => ComposeDraft) => {
    setDraft((current) => (current ? change(current) : current));
  }, []);

  const close = () => void window.wl2go.compose.closeWindow();

  const save = async (current: ComposeDraft) => {
    try {
      await window.wl2go.drafts.save({ draft: current });
      close();
    } catch (err: unknown) {
      setError(message(err));
    }
  };

  const discard = async (current: ComposeDraft) => {
    try {
      await window.wl2go.drafts.delete({ id: current.id });
    } catch {
      /* a draft that was never saved has nothing to delete */
    }
    close();
  };

  const send = async (current: ComposeDraft): Promise<string[]> => {
    const result = await sendDraft(current);
    if (result.sent) close();
    return result.problems;
  };

  const attach = async (current: ComposeDraft): Promise<ComposeAttachment[]> => {
    try {
      return await attachFiles(current);
    } catch (err: unknown) {
      setError(message(err));
      return current.attachments;
    }
  };

  if (!draft) {
    return (
      <div className="compose-window">
        <EmptyState
          glyph="🖅"
          title={draft === undefined ? "Opening…" : "This message is no longer open"}
          detail={draft === undefined ? undefined : (error ?? "Close this window and open it again from Drafts.")}
        />
      </div>
    );
  }

  return (
    <div className="compose-window">
      <ComposeForm
        draft={draft}
        onChange={update}
        variant="window"
        title={title}
        recipientsOnly={recipientsOnly}
        error={error}
        onSave={(current) => void save(current)}
        onSend={send}
        onAttach={attach}
        onDiscard={(current) => void discard(current)}
      />
    </div>
  );
}
