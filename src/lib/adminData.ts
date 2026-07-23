// Admin panel SWR (stale-while-revalidate) data layer.
//
// Every admin tab used to fetch on mount → 5-30s blank screens on every click.
// This store lets tabs paint instantly from cache and refresh in the background.
//
// Design rules honored:
//   - No localStorage for user data. sessionStorage is admin-scoped and dies
//     with the tab, which matches the existing admin session model.
//   - Request dedup: two mounts within the same tick share ONE network call.
//   - Fresh window (15s): reads return cached data with NO network call.
//   - Stale window (5min): reads return cached data AND fire a background
//     revalidate.
//   - Beyond stale: reads return cached data BUT show "refreshing" and await
//     the revalidate before resolving.
//
// Public API is intentionally tiny:
//   getSlice(key, fetcher)  → { data, stale, refreshing, error }
//   subscribe(key, fn)      → unsubscribe
//   invalidate(key)         → mark stale; next read refetches
//   prefetch(entries)       → parallel warm-up
//
// The React hook lives in src/hooks/useAdminSlice.ts.

const SS_PREFIX = "admin_slice_v1:";
const FRESH_MS = 15_000;        // read = cache-only
const STALE_MS = 5 * 60_000;    // read = cache + background refetch

type Entry<T = any> = {
  data: T | null;
  cachedAt: number;
  error: string | null;
  refreshing: boolean;
  inflight: Promise<T> | null;
};

const store = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.debug("[admin-data]", ...args);
}

function readSession<T>(key: string): { data: T; cachedAt: number } | null {
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return { data: parsed.data as T, cachedAt: Number(parsed.cachedAt) || 0 };
  } catch { return null; }
}

function writeSession(key: string, data: unknown, cachedAt: number) {
  try {
    sessionStorage.setItem(SS_PREFIX + key, JSON.stringify({ data, cachedAt }));
  } catch { /* quota — silently ignore */ }
}

function ensure(key: string): Entry {
  let e = store.get(key);
  if (!e) {
    const persisted = readSession<any>(key);
    e = {
      data: persisted?.data ?? null,
      cachedAt: persisted?.cachedAt ?? 0,
      error: null,
      refreshing: false,
      inflight: null,
    };
    store.set(key, e);
  }
  return e;
}

function emit(key: string) {
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) { try { fn(); } catch {} }
}

export type SliceState<T> = {
  data: T | null;
  cachedAt: number;
  error: string | null;
  refreshing: boolean;
  hasData: boolean;
};

export function readSlice<T = any>(key: string): SliceState<T> {
  const e = ensure(key);
  return {
    data: e.data as T | null,
    cachedAt: e.cachedAt,
    error: e.error,
    refreshing: e.refreshing,
    hasData: e.data !== null,
  };
}

export function subscribe(key: string, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(fn);
  return () => { set!.delete(fn); };
}

async function runFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const e = ensure(key);
  if (e.inflight) return e.inflight as Promise<T>;
  e.refreshing = true;
  emit(key);
  const p = (async () => {
    try {
      const data = await fetcher();
      e.data = data;
      e.cachedAt = Date.now();
      e.error = null;
      writeSession(key, data, e.cachedAt);
      log("refresh ok", key);
      return data;
    } catch (err: any) {
      e.error = err?.message || String(err);
      log("refresh error", key, e.error);
      throw err;
    } finally {
      e.refreshing = false;
      e.inflight = null;
      emit(key);
    }
  })();
  e.inflight = p as Promise<any>;
  return p;
}

// Ensure the slice is populated. Never blocks unless the cache is empty.
export async function ensureSlice<T = any>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { force?: boolean } = {},
): Promise<T> {
  const e = ensure(key);
  const age = Date.now() - e.cachedAt;
  const fresh = e.data !== null && age < FRESH_MS && !opts.force;
  if (fresh) return e.data as T;

  const stale = e.data !== null && age < STALE_MS && !opts.force;
  if (stale) {
    // Fire background refresh, return cache immediately.
    runFetch(key, fetcher).catch(() => {});
    return e.data as T;
  }

  // No cache or beyond stale window: await network but keep old data visible.
  if (e.data !== null) {
    // Return cached data immediately; caller (hook) already re-rendered.
    // Still kick refresh so next render has fresh data.
    runFetch(key, fetcher).catch(() => {});
    return e.data as T;
  }
  return runFetch(key, fetcher);
}

// Fire-and-forget parallel warm-up. Never throws.
export function prefetch(entries: Array<{ key: string; fetcher: () => Promise<any> }>) {
  for (const { key, fetcher } of entries) {
    const e = ensure(key);
    const age = Date.now() - e.cachedAt;
    if (e.data !== null && age < FRESH_MS) continue; // already fresh
    if (e.inflight) continue; // dedup
    runFetch(key, fetcher).catch(() => {});
  }
}

// Mark a slice stale (does NOT clear cached data — SWR).
export function invalidate(key: string) {
  const e = store.get(key);
  if (!e) return;
  e.cachedAt = 0;
  log("invalidate", key);
  emit(key);
}

// Overwrite the cached value (use after a mutation to avoid a refetch).
export function setSlice<T>(key: string, data: T) {
  const e = ensure(key);
  e.data = data;
  e.cachedAt = Date.now();
  e.error = null;
  writeSession(key, data, e.cachedAt);
  emit(key);
}

// Wipe everything (call on admin logout).
export function clearAllSlices() {
  for (const key of Array.from(store.keys())) {
    try { sessionStorage.removeItem(SS_PREFIX + key); } catch {}
  }
  store.clear();
  for (const [, set] of listeners) for (const fn of set) { try { fn(); } catch {} }
}

// Slice keys used by the admin panel. Keep centralized so refactors are safe.
export const AdminSliceKeys = {
  loginEvents: "loginEvents",
  cookies: "cookies",
  notifications: "notifications",
  emailAccounts: "emailAccounts",
  tvJobs: "tvJobs",
  directLinks: "directLinks",
  vps: "vps",
} as const;

