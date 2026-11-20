import { useCallback, useEffect, useState } from "react";
import type { AppConfigView } from "../../shared/ipcContract.ts";

/**
 * Electron wraps a rejected ipcMain.handle as
 * "Error invoking remote method 'x': Error: <real message>". The operator only
 * needs the real message.
 */
export function ipcMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?(.*)$/s.exec(raw);
  return match?.[1]?.trim() || raw;
}

export interface UseConfigResult {
  config: AppConfigView | null;
  /** Set by any mutation that main rejected, e.g. a name collision or a missing keyring. */
  error: string | null;
  clearError: () => void;
  /** Wraps a mutation so every caller gets the same error handling. */
  mutate: (action: () => Promise<AppConfigView>) => Promise<boolean>;
}

/**
 * The application config, kept live.
 *
 * Same shape as usePatState: one fetch on mount, then main's push events. The
 * push matters because more than one view renders config -- editing the callsign
 * in Settings has to update the status bar without a round trip through the UI.
 */
export function useConfig(): UseConfigResult {
  const [config, setConfig] = useState<AppConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    window.wl2go.config
      .get()
      .then((initial) => {
        if (mounted) setConfig(initial);
      })
      .catch((err: unknown) => {
        if (mounted) setError(ipcMessage(err));
      });

    const unsubscribe = window.wl2go.on("config:changed", (next) => {
      if (mounted) setConfig(next);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const mutate = useCallback(async (action: () => Promise<AppConfigView>): Promise<boolean> => {
    try {
      setConfig(await action());
      setError(null);
      return true;
    } catch (err: unknown) {
      // Main throws for anything it refuses to store; surfacing the message is
      // more useful than a generic failure, since it names the actual reason.
      setError(ipcMessage(err));
      return false;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { config, error, clearError, mutate };
}
