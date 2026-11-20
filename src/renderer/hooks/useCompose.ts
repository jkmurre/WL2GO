import { useCallback, useEffect, useState } from "react";
import {
  buildForward,
  buildForwardUnchanged,
  buildReply,
  buildReplyAll,
  emptyDraft,
  type ComposeAttachment,
  type ComposeDraft,
} from "../../shared/composeModel.ts";
import type { MailBox, MailMessage } from "../../shared/ipcContract.ts";
import { ipcMessage } from "./useConfig.ts";

/** How an inline compose was opened, for the heading over it. */
export type InlineComposeKind = "reply" | "replyAll" | "forward" | "forwardUnchanged" | "draft";

export const INLINE_COMPOSE_TITLES: Record<InlineComposeKind, string> = {
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
  forwardUnchanged: "Forward without changes",
  draft: "Draft",
};

/** A compose open in the reading pane. */
export interface InlineCompose {
  kind: InlineComposeKind;
  draft: ComposeDraft;
  /** Forward Without Changes edits nothing but the recipients. */
  recipientsOnly: boolean;
  /** Edited since it opened. Moving away keeps it only then. */
  dirty: boolean;
  /** A forward's attachment bytes are still being fetched from Pat. */
  carrying: boolean;
}

export interface UseComposeResult {
  inline: InlineCompose | null;
  error: string | null;
  /** Opens a blank message in its own window. */
  newMessage: () => void;
  /** Opens a draft inline, or brings forward the window already holding it. */
  openDraft: (id: string) => Promise<void>;
  reply: (message: MailMessage, all: boolean) => void;
  forward: (message: MailMessage, unchanged: boolean) => void;
  /** Pulls a queued message back into a draft and opens it in a window. Resolves true if it did. */
  editQueued: (mid: string) => Promise<boolean>;
  /** Resolves true only if Pat actually queued the acknowledgement. */
  acknowledge: (box: MailBox, mid: string) => Promise<boolean>;
  update: (change: (current: ComposeDraft) => ComposeDraft) => void;
  /** Moves the inline compose into its own window. */
  popOut: () => Promise<void>;
  /**
   * Closes the inline compose because the operator moved elsewhere, keeping it
   * if edited. Resolves false if it could not be kept, and so stayed open.
   */
  leaveInline: () => Promise<boolean>;
  clearError: () => void;
  saveAndClose: (draft: ComposeDraft) => Promise<void>;
  discard: (draft: ComposeDraft) => Promise<void>;
  send: (draft: ComposeDraft) => Promise<string[]>;
  attach: (draft: ComposeDraft) => Promise<ComposeAttachment[]>;
}

/** A local draft id. Never a Winlink MID -- Pat mints that at send. */
function newId(): string {
  return crypto.randomUUID();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Queues a draft in Pat's outbox. Resolves with what stopped it, or nothing if
 * it went. Shared by the inline compose and the pop-out window.
 */
export async function sendDraft(draft: ComposeDraft): Promise<{ sent: boolean; problems: string[] }> {
  try {
    const result = await window.wl2go.compose.send({ draft });
    return result.sent ? { sent: true, problems: [] } : { sent: false, problems: result.problems };
  } catch (err: unknown) {
    return { sent: false, problems: [message(err)] };
  }
}

/** Picks files onto a draft. Rejects if the draft or the files could not be stored. */
export async function attachFiles(draft: ComposeDraft): Promise<ComposeAttachment[]> {
  // Saved first so the file picker has a draft to attach to.
  await window.wl2go.drafts.save({ draft });
  const picked = await window.wl2go.compose.pickAttachment({ id: draft.id });
  return picked.length ? [...draft.attachments, ...picked] : draft.attachments;
}

/**
 * Compose, from the main window.
 *
 * Reply, Reply All and Forward are all just prefilled drafts -- Pat has no
 * server-side notion of any of them -- so they are built here from the message
 * already in the cache, with no round trip. They open inline, in the reading
 * pane. A new message, or a queued one taken back for editing, opens in its own
 * window instead, so it can sit beside the mailbox while it is written.
 */
export function useCompose(mycall: string): UseComposeResult {
  const [inline, setInline] = useState<InlineCompose | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Main keeps a copy of whatever is being written, so closing the window or
  // quitting keeps it -- if it was edited. See ComposeWindows.
  useEffect(() => {
    void window.wl2go.compose
      .stash({ draft: inline?.draft ?? null, dirty: inline?.dirty ?? false })
      .catch(() => {
        /* a lost stash costs only the quit-time save; the form is unaffected */
      });
  }, [inline?.draft, inline?.dirty]);

  const openInline = useCallback(
    (kind: InlineComposeKind, draft: ComposeDraft, recipientsOnly = false, carrying = false) => {
      setError(null);
      setInline({ kind, draft, recipientsOnly, dirty: false, carrying });
    },
    [],
  );

  const openWindow = useCallback(async (draft: ComposeDraft, recipientsOnly = false): Promise<boolean> => {
    setError(null);
    try {
      await window.wl2go.compose.openWindow({ draft, recipientsOnly });
      return true;
    } catch (err: unknown) {
      setError(ipcMessage(err));
      return false;
    }
  }, []);

  const newMessage = useCallback(() => void openWindow(emptyDraft(newId())), [openWindow]);

  const openDraft = useCallback(
    async (id: string) => {
      try {
        // Already open in a window: two editors on one draft would each save
        // over the other.
        if (await window.wl2go.compose.focusWindow({ id })) return;
        const draft = await window.wl2go.drafts.get({ id });
        if (draft) openInline("draft", draft);
      } catch (err: unknown) {
        setError(message(err));
      }
    },
    [openInline],
  );

  const reply = useCallback(
    (original: MailMessage, all: boolean) => {
      const id = newId();
      openInline(
        all ? "replyAll" : "reply",
        all ? buildReplyAll(id, original, { mycall }) : buildReply(id, original, { mycall }),
      );
    },
    [mycall, openInline],
  );

  const forward = useCallback(
    (original: MailMessage, unchanged: boolean) => {
      const id = newId();
      const draft = unchanged ? buildForwardUnchanged(id, original) : buildForward(id, original);
      const carrying = original.attachments.length > 0;
      openInline(unchanged ? "forwardUnchanged" : "forward", draft, unchanged, carrying);

      // The attachment BYTES live in Pat's mailbox, not our cache, so they are
      // fetched and copied onto the draft. Saved first so the draft exists to
      // attach them to.
      if (carrying) {
        const carried = (files: ComposeAttachment[] | null) =>
          setInline((current) =>
            current && current.draft.id === id
              ? {
                  ...current,
                  draft: files ? { ...current.draft, attachments: files } : current.draft,
                  carrying: false,
                }
              : current,
          );
        void window.wl2go.drafts
          .save({ draft })
          .then(() =>
            window.wl2go.compose.carryAttachments({ box: original.box, mid: original.mid, id }),
          )
          .then((files) => carried(files))
          .catch((err: unknown) => {
            carried(null);
            setError(message(err));
          });
      }
    },
    [openInline],
  );

  // The draft comes back from main already stored, attachment bytes and all,
  // and the queued copy is already gone from the outbox.
  const editQueued = useCallback(
    async (mid: string): Promise<boolean> => {
      setError(null);
      let draft: ComposeDraft;
      try {
        draft = await window.wl2go.compose.editQueued({ mid });
      } catch (err: unknown) {
        setError(ipcMessage(err));
        return false;
      }
      // Out of the outbox either way: if the window cannot open, the draft is
      // still in Drafts, and the outbox row must not stay open.
      await openWindow(draft);
      return true;
    },
    [openWindow],
  );

  /**
   * Never opens a composer: the text is complete by construction, which is the
   * whole point of the feature.
   *
   * Reports whether it worked rather than swallowing the failure. The button
   * turns into "Acknowledged", and on a net a button claiming an ack was sent
   * when Pat was down is the single worst thing this feature could do.
   */
  const acknowledge = useCallback(async (box: MailBox, mid: string): Promise<boolean> => {
    setError(null);
    try {
      await window.wl2go.compose.acknowledge({ box, mid });
      return true;
    } catch (err: unknown) {
      setError(message(err));
      return false;
    }
  }, []);

  const update = useCallback((change: (current: ComposeDraft) => ComposeDraft) => {
    setInline((current) => (current ? { ...current, draft: change(current.draft), dirty: true } : current));
  }, []);

  const popOut = useCallback(async () => {
    if (!inline || inline.carrying) return;
    if (await openWindow(inline.draft, inline.recipientsOnly)) {
      // Only if it is still the same draft: the operator may have moved on
      // while the window was opening.
      setInline((current) => (current?.draft.id === inline.draft.id ? null : current));
    }
  }, [inline, openWindow]);

  /**
   * Moving to another message or folder. Kept as a draft only if it was
   * edited: a reply opened and walked away from is not something anyone wrote.
   * A draft opened from Drafts and left untouched is already stored.
   */
  const leaveInline = useCallback(async (): Promise<boolean> => {
    if (!inline) return true;
    if (inline.dirty) {
      try {
        await window.wl2go.drafts.save({ draft: inline.draft });
      } catch (err: unknown) {
        // Left open rather than lost.
        setError(message(err));
        return false;
      }
    }
    setInline((current) => (current?.draft.id === inline.draft.id ? null : current));
    return true;
  }, [inline]);

  const clearError = useCallback(() => setError(null), []);

  const saveAndClose = useCallback(async (draft: ComposeDraft) => {
    try {
      await window.wl2go.drafts.save({ draft });
      setInline(null);
    } catch (err: unknown) {
      setError(message(err));
    }
  }, []);

  const discard = useCallback(async (draft: ComposeDraft) => {
    try {
      await window.wl2go.drafts.delete({ id: draft.id });
    } catch {
      /* a draft that was never saved has nothing to delete */
    }
    setInline(null);
  }, []);

  const send = useCallback(async (draft: ComposeDraft): Promise<string[]> => {
    const result = await sendDraft(draft);
    if (result.sent) setInline(null);
    return result.problems;
  }, []);

  const attach = useCallback(async (draft: ComposeDraft): Promise<ComposeAttachment[]> => {
    try {
      return await attachFiles(draft);
    } catch (err: unknown) {
      setError(message(err));
      return draft.attachments;
    }
  }, []);

  return {
    inline,
    error,
    newMessage,
    openDraft,
    reply,
    forward,
    editQueued,
    acknowledge,
    update,
    popOut,
    leaveInline,
    clearError,
    saveAndClose,
    discard,
    send,
    attach,
  };
}
