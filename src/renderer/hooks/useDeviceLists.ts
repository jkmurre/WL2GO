import { useCallback, useEffect, useState } from "react";
import type { AudioDevice, SerialPortInfo } from "../../shared/ipcContract.ts";

export interface DeviceLists {
  serial: SerialPortInfo[];
  audio: AudioDevice[];
  loading: boolean;
  error: string | null;
}

export interface UseDeviceLists extends DeviceLists {
  /** Re-runs both enumerations. Bound to the Rescan button. */
  rescan: () => Promise<void>;
  capture: AudioDevice[];
  playback: AudioDevice[];
}

/**
 * The serial and audio listings, refreshed on demand.
 *
 * Both come from the same enumeration the modem itself uses -- audio via
 * ardopcf's own --list-devices, never Chromium's mediaDevices, whose IDs are a
 * different namespace that cannot be handed back to ardopcf.
 *
 * There is deliberately no hot-plug subscription and no polling: Module 7
 * settled that re-running a subprocess on a timer buys nothing over an explicit
 * Rescan plus resolving again at connect time. This hook is what Rescan drives.
 */
export function useDeviceLists(): UseDeviceLists {
  const [state, setState] = useState<DeviceLists>({ serial: [], audio: [], loading: true, error: null });

  const rescan = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [serial, audio] = await Promise.all([
        window.wl2go.serial.listPorts(),
        window.wl2go.audio.listDevices(),
      ]);
      setState({ serial, audio, loading: false, error: null });
    } catch (err: unknown) {
      // Enumeration failing is worth showing rather than rendering as an empty
      // list: "no devices found" and "we could not look" are different problems
      // with different fixes.
      setState({
        serial: [],
        audio: [],
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  return {
    ...state,
    rescan,
    capture: state.audio.filter((d) => d.direction === "capture"),
    playback: state.audio.filter((d) => d.direction === "playback"),
  };
}
