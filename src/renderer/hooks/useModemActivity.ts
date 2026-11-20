import { useEffect, useState } from "react";
import type { ModemActivity } from "../../shared/ipcContract.ts";

const AT_REST: ModemActivity = { transmitting: false, rx: "idle" };

/**
 * The session modem's live TX/RX activity, for the status-bar lights.
 *
 * Push-only, no seed fetch: at mount the modem is almost always stopped (it
 * only runs during a session), and while one IS running the next event is at
 * most a frame cycle away. Main resets the tracker whenever the modem stops,
 * so the resting state here and the resting state there agree.
 */
export function useModemActivity(): ModemActivity {
  const [activity, setActivity] = useState<ModemActivity>(AT_REST);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.wl2go.on("ardop:activity", (next) => {
      if (mounted) setActivity(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return activity;
}
