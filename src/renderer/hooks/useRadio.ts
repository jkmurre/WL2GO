import { useCallback, useEffect, useState } from "react";
import type { RadioReadinessView } from "../../shared/ipcContract.ts";

export interface UseRadioResult {
  readiness: RadioReadinessView | null;
  /** Re-checks whether the active profile's devices are present. */
  refresh: () => void;
  resetModem: () => Promise<string>;
}

/**
 * Whether the active radio profile could hold a session.
 *
 * Drives the Connect dropdown's radio entry, so it must be cheap: the main-side
 * handler resolves saved device names against the current listing and spawns
 * nothing. Re-checked whenever the config changes, because editing a profile or
 * switching the active one both change the answer.
 */
export function useRadio(): UseRadioResult {
  const [readiness, setReadiness] = useState<RadioReadinessView | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    window.wl2go.ardop
      .readiness()
      .then((next) => {
        if (live) setReadiness(next);
      })
      .catch(() => {
        if (live) setReadiness(null);
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // A profile edit changes which devices are wanted, and making the active
  // profile a different radio changes it entirely.
  useEffect(() => window.wl2go.on("config:changed", () => setNonce((n) => n + 1)), []);

  const resetModem = useCallback(async () => {
    try {
      const result = await window.wl2go.ardop.resetModem();
      setNonce((n) => n + 1);
      return result.message;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  return { readiness, refresh, resetModem };
}
