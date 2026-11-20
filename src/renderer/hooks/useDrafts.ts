import { useCallback, useEffect, useMemo, useState } from "react";
import type { DraftSummaryView } from "../../shared/ipcContract.ts";
import type { MailListRow } from "./useMailbox.ts";

export interface UseDraftsResult {
  /** Drafts shaped as list rows, so the message list needs no special case. */
  rows: MailListRow[];
  count: number;
  refresh: () => void;
}

/**
 * Unsent messages.
 *
 * Separate from useMailbox because drafts are a different kind of thing: they
 * live in their own database, never reach Pat, and survive the cache rebuild
 * that clears everything the mailbox hook reads.
 */
export function useDrafts(): UseDraftsResult {
  const [drafts, setDrafts] = useState<DraftSummaryView[]>([]);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let mounted = true;

    window.wl2go.drafts
      .list()
      .then((next) => {
        if (mounted) setDrafts(next);
      })
      .catch(() => {
        /* main pushes drafts:changed on every mutation anyway */
      });

    const off = window.wl2go.on("drafts:changed", (next) => {
      if (mounted) setDrafts(next);
    });

    return () => {
      mounted = false;
      off();
    };
  }, [revision]);

  const rows = useMemo<MailListRow[]>(
    () =>
      drafts.map((draft) => ({
        box: "drafts" as const,
        // The list keys on the id; a draft has no Winlink MID until it is sent.
        mid: draft.id,
        draftId: draft.id,
        date: draft.updatedAt,
        // The list shows a sender column; for an unsent message the useful
        // thing there is who it is going to.
        from: draft.to || "No recipient",
        to: [],
        cc: [],
        subject: draft.subject || "(no subject)",
        // Never bold: a draft you wrote is not something you have missed.
        unread: false,
        p2pOnly: false,
        attachments: Array.from({ length: draft.attachmentCount }, (_, i) => ({
          name: `attachment-${i + 1}`,
          sizeBytes: 0,
        })),
        snippet: draft.preview,
      })),
    [drafts],
  );

  const refresh = useCallback(() => setRevision((n) => n + 1), []);

  return { rows, count: drafts.length, refresh };
}
