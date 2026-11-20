import { useEffect, useState } from "react";
import type { PatProcessState } from "../../shared/ipcContract.ts";

/**
 * Current state of the Pat subprocess. Seeded with a one-off fetch (the process
 * may already have settled before this mounted) and then kept live by main's
 * push events.
 */
export function usePatState(): PatProcessState | null {
  const [state, setState] = useState<PatProcessState | null>(null);

  useEffect(() => {
    let mounted = true;

    window.wl2go.pat
      .getProcessState()
      .then((initial) => {
        if (mounted) setState(initial);
      })
      .catch(() => {
        /* main will push an update once it knows more */
      });

    const unsubscribe = window.wl2go.on("pat:stateChanged", (next) => {
      if (mounted) setState(next);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return state;
}
