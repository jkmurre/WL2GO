import { useCallback, useEffect, useState } from "react";
import type { HybridNetworkView, PickupStationsView } from "../../shared/ipcContract.ts";

export interface UseHybridNetworkResult {
  hybrid: HybridNetworkView | null;
  pickup: PickupStationsView | null;
  /** Fetches both from Winlink now, which needs the internet. */
  refresh: () => void;
}

/**
 * The hybrid station list and this operator's pickup stations, for the station
 * browser.
 *
 * Neither read ever fails for being offline -- main answers with the last copy
 * and the reason -- so a rejection here means main itself is not ready, and is
 * treated as "nothing known yet" rather than shown as an error.
 */
export function useHybridNetwork(open: boolean): UseHybridNetworkResult {
  const [hybrid, setHybrid] = useState<HybridNetworkView | null>(null);
  const [pickup, setPickup] = useState<PickupStationsView | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const refresh = nonce > 0;
    void window.wl2go.winlink.hybridStations({ refresh }).then(
      (view) => live && setHybrid(view),
      () => {},
    );
    void window.wl2go.winlink.pickupStations({ refresh }).then(
      (view) => live && setPickup(view),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { hybrid, pickup, refresh };
}
