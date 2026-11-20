import { useCallback, useState } from "react";

const RADIO_ONLY_KEY = "wl2go.radioOnly";
/** Where the direct-call dialog kept its own copy before this was shared. */
const LEGACY_DIRECT_CALL_KEY = "wl2go.directCall";

function initial(): boolean {
  try {
    const stored = localStorage.getItem(RADIO_ONLY_KEY);
    if (stored !== null) return stored === "true";
    const legacy = JSON.parse(localStorage.getItem(LEGACY_DIRECT_CALL_KEY) ?? "{}") as { radioOnly?: unknown };
    return legacy.radioOnly === true;
  } catch {
    return false;
  }
}

/**
 * Whether RF sessions go out Radio-Only, on Winlink's hybrid network.
 *
 * Remembered until the operator turns it off, because an outage outlasts a
 * session: having to re-tick it on every call is how one call goes out the
 * normal way and fails. The cost of remembering is the opposite mistake, which
 * is why App shows it in the status bar and the Connect menu for as long as it
 * is on.
 *
 * Held once in App and passed down, so the station browser, the direct-call
 * dialog and the status bar can never disagree.
 */
export function useRadioOnly(): [boolean, (value: boolean) => void] {
  const [radioOnly, setState] = useState(initial);

  const set = useCallback((value: boolean) => {
    setState(value);
    try {
      localStorage.setItem(RADIO_ONLY_KEY, String(value));
    } catch {
      // A convenience only: it still applies for this run.
    }
  }, []);

  return [radioOnly, set];
}
