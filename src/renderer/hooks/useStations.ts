import { useCallback, useEffect, useState } from "react";
import { sortStations, toStationRows, type StationRow, type StationSort } from "../../shared/stationList.ts";

export interface UseStationsResult {
  rows: StationRow[];
  loading: boolean;
  /** A named reason the list could not be fetched, or null. */
  error: string | null;
  sort: StationSort;
  setSort: (sort: StationSort) => void;
  /** Re-fetches. Pass true to bypass Pat's cache, which needs the internet. */
  refresh: (forceDownload?: boolean) => void;
}

/**
 * The RMS gateway list.
 *
 * Fetched with mode=ardop, because this list exists to answer "who can I call
 * over the air" and a VARA-only gateway is not an answer WL2GO can act on.
 *
 * An error here is not fatal and not hidden: Pat serves the list from a local
 * cache when it cannot reach api.winlink.org, so being offline usually still
 * produces a list. When it does not, the operator needs to know the list is
 * stale or absent rather than that there are no stations.
 */
export function useStations(open: boolean): UseStationsResult {
  const [rows, setRows] = useState<StationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<StationSort>("quality");
  const [nonce, setNonce] = useState(0);
  const [force, setForce] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);

    window.wl2go.pat
      .rmsList({ mode: "ardop", ...(force ? { forceDownload: true } : {}) })
      .then((list) => {
        if (!live) return;
        setRows(toStationRows(list));
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
  }, [open, nonce, force]);

  const refresh = useCallback((forceDownload = false) => {
    setForce(forceDownload);
    setNonce((n) => n + 1);
  }, []);

  return { rows: sortStations(rows, sort), loading, error, sort, setSort, refresh };
}
