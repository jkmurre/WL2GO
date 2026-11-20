import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MailBox,
  MailFolderCounts,
  MailFolderId,
  MailMessage,
  MailMessageSummary,
  MoveTarget,
} from "../../shared/ipcContract.ts";
import { asMailBox, userFolderOf } from "../features/mailbox/folders.ts";
import { ipcMessage } from "./useConfig.ts";

/**
 * A row in the message list.
 *
 * Folder listings and search hits render identically except that a hit carries
 * a snippet, so one type serves both rather than the list branching on which
 * kind of thing it was handed.
 */
export type MailListRow = Omit<MailMessageSummary, "box"> & {
  /**
   * Wider than MailBox because Drafts is a folder in the UI but not in Pat.
   * A row carrying "drafts" can never be handed to a Pat call: the compiler
   * rejects it, which is the point of keeping the two types apart.
   */
  box: MailFolderId;
  snippet?: string;
  /** On a search hit filed in one of the operator's folders: which one. */
  folderName?: string;
  /** Set only on drafts. Opens compose rather than the reading pane. */
  draftId?: string;
};

/** Which message is open. The box travels with it because search crosses folders. */
export interface MailSelection {
  box: MailBox;
  mid: string;
}

export interface UseMailboxResult {
  rows: MailListRow[];
  counts: MailFolderCounts | null;
  selected: MailMessage | null;
  selection: MailSelection | null;
  loadingMessage: boolean;
  error: string | null;
  query: string;
  /** True while `rows` holds search hits rather than the selected folder. */
  searching: boolean;
  /** A query has been typed but its results have not arrived yet. */
  searchPending: boolean;
  setQuery: (query: string) => void;
  select: (mid: string, box: MailFolderId) => void;
  clearSelection: () => void;
  rebuild: () => Promise<void>;
  archive: () => Promise<void>;
  deletePermanently: () => Promise<void>;
  markUnread: () => Promise<void>;
  saveAttachment: (name: string) => Promise<string | null>;
  /** Moves any message, open or not. Closes it if it was the open one. */
  move: (target: MailSelection, to: MoveTarget) => Promise<void>;
  /** Marks any message read or unread without opening it. */
  setRead: (target: MailSelection, read: boolean) => Promise<void>;
}

/** Long enough not to search on every keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * The mailbox, read from the local cache in the main process.
 *
 * Nothing here polls. The cache pushes `mailbox:changed` whenever it actually
 * changes, which is the only thing that should cause a re-read -- listing a
 * folder in Pat is expensive enough that the main process goes out of its way
 * to avoid it, and polling from here would undo that.
 */
export function useMailbox(folder: MailFolderId): UseMailboxResult {
  // Drafts are ours, not Pat's, and are loaded by useDrafts instead. Narrowed
  // once here so nothing below has to think about it again.
  // An operator's own folder is a label over Archive, listed by its own call.
  const userFolder = userFolderOf(folder);
  const box: MailBox | null = asMailBox(folder);

  const [folderRows, setFolderRows] = useState<MailListRow[]>([]);
  const [searchRows, setSearchRows] = useState<MailListRow[]>([]);
  const [counts, setCounts] = useState<MailFolderCounts | null>(null);
  const [selection, setSelection] = useState<MailSelection | null>(null);
  const [selected, setSelected] = useState<MailMessage | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchPending, setSearchPending] = useState(false);
  /** Bumped to force a re-read after a change we were told about. */
  const [revision, setRevision] = useState(0);

  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;

  // Ignores results from a search the operator has already typed past.
  const searchToken = useRef(0);

  // Selecting in one folder and switching to another must not leave the old
  // message on screen next to the new folder's list.
  useEffect(() => {
    setSelection(null);
    setSelected(null);
  }, [folder]);

  useEffect(() => {
    if (!box && !userFolder) {
      setFolderRows([]);
      return;
    }

    let mounted = true;

    const listing = userFolder
      ? window.wl2go.folders.listMessages({ id: userFolder })
      : window.wl2go.mailbox.listFolder({ box: box as MailBox });
    listing
      .then((next) => {
        if (mounted) setFolderRows(next);
      })
      .catch((err: unknown) => {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      mounted = false;
    };
  }, [box, userFolder, revision]);

  // Debounced so a fast typist does not queue a query per keystroke.
  useEffect(() => {
    if (!searching) {
      setSearchRows([]);
      setSearchPending(false);
      return;
    }

    // Set immediately, cleared when results land: without it the list would
    // show "Nothing matched" during the debounce, on every keystroke.
    setSearchPending(true);

    const token = ++searchToken.current;
    const timer = setTimeout(() => {
      window.wl2go.mailbox
        .search({ query: trimmedQuery })
        .then((hits) => {
          // Dropped if the operator has typed since: an older, slower query
          // must not overwrite a newer one's results.
          if (token !== searchToken.current) return;
          setSearchRows(hits);
          setSearchPending(false);
        })
        .catch((err: unknown) => {
          if (token !== searchToken.current) return;
          setError(err instanceof Error ? err.message : String(err));
          setSearchPending(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmedQuery, searching, revision]);

  useEffect(() => {
    let mounted = true;

    window.wl2go.mailbox
      .getCounts()
      .then((next) => {
        if (mounted) setCounts(next);
      })
      .catch(() => {
        /* the next mailbox:changed carries them anyway */
      });

    const off = window.wl2go.on("mailbox:changed", (event) => {
      if (!mounted) return;
      setCounts(event.counts);
      // Re-read when the folder on screen moved -- or always while searching,
      // since hits can come from any folder.
      // A user folder's messages live in Archive, so Archive changing is its cue.
      const shown: MailBox | null = userFolder ? "archive" : box;
      if ((shown && event.boxes.includes(shown)) || searching) setRevision((n) => n + 1);
    });

    return () => {
      mounted = false;
      off();
    };
  }, [box, userFolder, searching]);

  // Reading a message fetches its body, and marking it read is part of opening
  // it -- both are one user action, so they belong in one effect.
  useEffect(() => {
    if (!selection) {
      setSelected(null);
      return;
    }

    let mounted = true;
    setLoadingMessage(true);

    window.wl2go.mailbox
      .getMessage({ box: selection.box, mid: selection.mid })
      .then((message) => {
        if (!mounted) return;
        setSelected(message);
        // Not awaited: the message is already on screen, and the unread dot
        // clearing a moment later is not worth blocking the read on.
        if (message?.unread) {
          void window.wl2go.mailbox
            .markRead({ box: selection.box, mid: selection.mid, read: true })
            .catch(() => {
              /* the folder re-syncs on failure; the cache stays truthful */
            });
        }
      })
      .catch((err: unknown) => {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (mounted) setLoadingMessage(false);
      });

    return () => {
      mounted = false;
    };
  }, [selection]);

  const select = useCallback((mid: string, from: MailFolderId) => {
    // Drafts open in compose, not the reading pane; App routes those before
    // they reach here. Guarded anyway so "drafts" -- or a user folder id --
    // can never become a Pat call.
    const box = asMailBox(from);
    if (!box) return;
    setError(null);
    setSelection({ box, mid });
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setSelected(null);
  }, []);

  /** Runs an action against the open message and clears it afterwards. */
  const act = useCallback(
    async (run: (target: MailSelection) => Promise<void>) => {
      if (!selection) return;
      setError(null);
      try {
        await run(selection);
        clearSelection();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [selection, clearSelection],
  );

  const archive = useCallback(() => act((t) => window.wl2go.mailbox.archive(t)), [act]);
  const deletePermanently = useCallback(() => act((t) => window.wl2go.mailbox.delete(t)), [act]);

  // Closes the message, like the other actions. Marking it unread means "I
  // will come back to this", so leaving it open -- where opening it would
  // immediately mark it read again -- would undo the operator's intent.
  const markUnread = useCallback(async () => {
    if (!selection) return;
    setError(null);
    try {
      await window.wl2go.mailbox.markRead({ ...selection, read: false });
      clearSelection();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selection, clearSelection]);

  const saveAttachment = useCallback(
    async (name: string): Promise<string | null> => {
      if (!selection) return null;
      setError(null);
      try {
        const result = await window.wl2go.mailbox.saveAttachment({ ...selection, name });
        return result.saved ? result.path : null;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [selection],
  );

  const move = useCallback(
    async (target: MailSelection, to: MoveTarget) => {
      setError(null);
      try {
        await window.wl2go.mailbox.move({ ...target, target: to });
        if (selection && selection.box === target.box && selection.mid === target.mid) clearSelection();
      } catch (err: unknown) {
        setError(ipcMessage(err));
      }
    },
    [selection, clearSelection],
  );

  const setRead = useCallback(async (target: MailSelection, read: boolean) => {
    setError(null);
    try {
      await window.wl2go.mailbox.markRead({ ...target, read });
    } catch (err: unknown) {
      setError(ipcMessage(err));
    }
  }, []);

  const rebuild = useCallback(async () => {
    setError(null);
    try {
      await window.wl2go.mailbox.rebuild();
      setRevision((n) => n + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const rows = useMemo(() => (searching ? searchRows : folderRows), [searching, searchRows, folderRows]);

  return {
    rows,
    counts,
    selected,
    selection,
    loadingMessage,
    error,
    query,
    searching,
    searchPending,
    setQuery,
    select,
    clearSelection,
    rebuild,
    archive,
    deletePermanently,
    markUnread,
    saveAttachment,
    move,
    setRead,
  };
}
