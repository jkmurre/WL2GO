import { useCallback, useState } from "react";
import type { DetectRadioResult, PttTestResult } from "../../shared/ipcContract.ts";
import type { PttConfig } from "../../shared/configSchema.ts";

export interface UseRadioDetect {
  detecting: boolean;
  detection: DetectRadioResult | null;
  detect: () => Promise<DetectRadioResult | null>;
  keying: boolean;
  keyResult: PttTestResult | null;
  testKeying: (ptt: PttConfig) => Promise<void>;
  reset: () => void;
}

/**
 * The two hardware questions the keying form cannot answer on its own: which
 * port the radio is on, and whether the commands actually key it.
 *
 * Same shape as useAudioTest, and for the same reason: a rejected promise is
 * folded into a failed result rather than thrown, because a test that cannot
 * run is something to report in place, not an error that tears down the form
 * the operator is halfway through filling in.
 */
export function useRadioDetect(): UseRadioDetect {
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<DetectRadioResult | null>(null);
  const [keying, setKeying] = useState(false);
  const [keyResult, setKeyResult] = useState<PttTestResult | null>(null);

  const detect = useCallback(async (): Promise<DetectRadioResult | null> => {
    setDetecting(true);
    setDetection(null);
    setKeyResult(null);
    try {
      const result = await window.wl2go.serial.detectRadio();
      setDetection(result);
      return result;
    } catch (err: unknown) {
      setDetection({
        found: null,
        attempts: [],
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      setDetecting(false);
    }
  }, []);

  const testKeying = useCallback(async (ptt: PttConfig) => {
    setKeying(true);
    setKeyResult(null);
    try {
      setKeyResult(await window.wl2go.serial.testPtt({ ptt }));
    } catch (err: unknown) {
      setKeyResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setKeying(false);
    }
  }, []);

  const reset = useCallback(() => {
    setDetection(null);
    setKeyResult(null);
  }, []);

  return { detecting, detection, detect, keying, keyResult, testKeying, reset };
}
