import { useEffect, useSyncExternalStore, useCallback } from "react";
import { ensureSlice, readSlice, subscribe, invalidate, setSlice, SliceState } from "../lib/adminData";

export type UseAdminSliceResult<T> = SliceState<T> & {
  refresh: (force?: boolean) => Promise<T>;
  invalidate: () => void;
  setData: (data: T) => void;
};

/**
 * Admin-panel SWR hook. Paints instantly from cache and refreshes in the
 * background so tab switches never block.
 *
 * Rules:
 *   - The fetcher is captured on first mount; re-mounting is cheap because the
 *     store dedups in-flight requests.
 *   - Set `enabled: false` to skip auto-loading (rare; almost never needed).
 */
export function useAdminSlice<T = any>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { enabled?: boolean } = {},
): UseAdminSliceResult<T> {
  const enabled = opts.enabled !== false;

  const state = useSyncExternalStore(
    (cb) => subscribe(key, cb),
    () => readSlice<T>(key),
    () => readSlice<T>(key),
  );

  useEffect(() => {
    if (!enabled) return;
    ensureSlice(key, fetcher).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  const refresh = useCallback(
    (force = true) => ensureSlice(key, fetcher, { force }),
    [key, fetcher],
  );

  const inv = useCallback(() => invalidate(key), [key]);
  const setData = useCallback((data: T) => setSlice(key, data), [key]);

  return { ...state, refresh, invalidate: inv, setData };
}
