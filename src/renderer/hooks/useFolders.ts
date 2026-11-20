import { useCallback, useEffect, useState } from "react";
import type { UserFolder } from "../../shared/ipcContract.ts";

export interface UseFoldersResult {
  /** Alphabetical. Null until the first load, so "no folders" is not flashed. */
  folders: UserFolder[] | null;
  /** Rejects with a message fit to show inline (empty name, duplicate…). */
  create: (name: string) => Promise<UserFolder>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/**
 * The operator's own folders.
 *
 * Pushed, not polled: main sends `folders:changed` on every create, rename,
 * delete and filing, and whenever Archive (where filed mail lives) changes.
 */
export function useFolders(): UseFoldersResult {
  const [folders, setFolders] = useState<UserFolder[] | null>(null);

  useEffect(() => {
    let mounted = true;
    window.wl2go.folders
      .list()
      .then((next) => {
        if (mounted) setFolders(next);
      })
      .catch(() => {
        if (mounted) setFolders([]);
      });
    const off = window.wl2go.on("folders:changed", (next) => {
      if (mounted) setFolders(next);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const create = useCallback((name: string) => window.wl2go.folders.create({ name }), []);
  const rename = useCallback((id: string, name: string) => window.wl2go.folders.rename({ id, name }), []);
  const remove = useCallback((id: string) => window.wl2go.folders.delete({ id }), []);

  return { folders, create, rename, remove };
}
