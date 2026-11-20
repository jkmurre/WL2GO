import { useCallback, useEffect, useState } from "react";
import type { RigModel } from "../../shared/ipcContract.ts";

export interface UseRigModelsResult {
  models: RigModel[];
  loading: boolean;
  /** Non-null when the list could not be read. The picker says so rather than showing nothing. */
  error: string | null;
  reload: () => void;
}

/**
 * The radio models this build of Hamlib can drive.
 *
 * Fetched once when the editor mounts. It costs a short subprocess and cannot
 * change while the app is running -- the binary is fixed at build time -- so
 * there is nothing to refresh for, but `reload` exists for the failure case.
 */
export function useRigModels(): UseRigModelsResult {
  const [models, setModels] = useState<RigModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    void window.wl2go.rigctl
      .listModels()
      .then((list) => {
        setModels(list);
        setError(null);
      })
      .catch((err: unknown) => {
        // Named rather than swallowed. An empty picker with no explanation
        // reads as "this radio is not supported", which is the wrong
        // conclusion and the wrong next action.
        setError(err instanceof Error ? err.message : String(err));
        setModels([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(reload, [reload]);

  return { models, loading, error, reload };
}
