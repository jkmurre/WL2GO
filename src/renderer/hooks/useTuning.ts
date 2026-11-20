import { useCallback, useEffect, useState } from "react";
import type { TuningOpenRequest, TuningState } from "../../shared/ipcContract.ts";

/**
 * Drives the tuning modem, which lives entirely in main.
 *
 * State is pushed rather than polled: the receive level updates continuously
 * and the drive level is echoed back by the modem, so the renderer holds no
 * opinion of its own about either. Every call also returns the state, which
 * covers the gap before the first event arrives.
 */
export function useTuning(request: TuningOpenRequest) {
  const [state, setState] = useState<TuningState | null>(null);

  // Read once, on open. The modem is spawned with these values, so a later edit
  // to the draft cannot reach it anyway -- and re-running this effect on every
  // keystroke would restart the modem underneath the operator.
  const [initial] = useState(request);

  useEffect(() => {
    const off = window.wl2go.on("tuning:stateChanged", setState);
    void window.wl2go.tuning.open(initial).then(setState);

    return () => {
      off();
      // Unconditional, on every unmount -- a closed window must never leave a
      // modem holding the sound card, still less a keyed transmitter.
      void window.wl2go.tuning.close();
    };
  }, [initial]);

  const setDriveLevel = useCallback((level: number) => {
    // Applied locally first so the slider tracks the thumb; main corrects it
    // from the modem's own echo a moment later.
    setState((prev) => (prev ? { ...prev, driveLevel: level } : prev));
    void window.wl2go.tuning.setDriveLevel({ level }).then(setState);
  }, []);

  const transmit = useCallback((kind: "twoTone" | "id") => {
    void window.wl2go.tuning.transmit({ kind }).then(setState);
  }, []);

  return { state, setDriveLevel, transmit };
}
