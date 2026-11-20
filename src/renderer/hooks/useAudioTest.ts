import { useCallback, useState } from "react";
import type { AudioDeviceTestResult } from "../../shared/ipcContract.ts";
import type { AudioDeviceSelection } from "../../shared/configSchema.ts";

export interface UseAudioTest {
  running: boolean;
  result: AudioDeviceTestResult | null;
  run: (input: AudioDeviceSelection | null, output: AudioDeviceSelection | null) => Promise<void>;
  /** Clears a stale verdict, e.g. after the operator changes a device. */
  reset: () => void;
}

/**
 * Runs the real device test: main starts a throwaway modem on a scratch port
 * and actually opens the two devices.
 *
 * This is the only honest answer available. PortAudio's Pa_IsFormatSupported is
 * a prediction that CoreAudio contradicts routinely, and ardopcf itself never
 * consults it -- it opens the stream and exits if that fails. On macOS this is
 * also the moment TCC asks for microphone consent.
 *
 * A rejected promise is folded into a failed result rather than thrown: a
 * device test that cannot run is a thing to report in place, not an error that
 * should tear down the form around it.
 */
export function useAudioTest(): UseAudioTest {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AudioDeviceTestResult | null>(null);

  const run = useCallback(
    async (input: AudioDeviceSelection | null, output: AudioDeviceSelection | null) => {
      setRunning(true);
      setResult(null);
      try {
        setResult(await window.wl2go.audio.testDevices({ input, output }));
      } catch (err: unknown) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          warnings: [],
        });
      } finally {
        setRunning(false);
      }
    },
    [],
  );

  const reset = useCallback(() => setResult(null), []);

  return { running, result, run, reset };
}
