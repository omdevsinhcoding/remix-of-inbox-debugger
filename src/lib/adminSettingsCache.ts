// Refresh-safe admin settings cache.
//
// Flow on page refresh:
//   1. hydrate from localStorage instantly (no flash of empty CAPTCHA fields)
//   2. server round-trip validates + refreshes; if server payload has a newer
//      `settings_version`, the stale cache is discarded and replaced
//   3. every operation dispatches a `admin-sync-status` window event so the
//      floating <AdminSyncStatus /> pill can show current state
//
// Delete flows call the loader with `{ silent: true }`; that branch never
// rewrites the settings cache, so deleting a user cannot wipe CAPTCHA keys.

const KEY = "admin_settings_cache_v2"; // bump when payload shape changes
const LEGACY_KEYS = ["admin_settings_cache_v1"];
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — after this we still hydrate but tag as stale

export type AdminCachePayload = {
  version: number;         // server-reported settings_version (monotonic)
  settings: any;
  r2: any | null;
  cached_at: number;
};

export type SyncState =
  | { kind: "idle" }
  | { kind: "loading-local" }
  | { kind: "syncing-server" }
  | { kind: "saved" }
  | { kind: "stale-refetching" }
  | { kind: "error"; message: string };

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.info("[admin-settings]", ...args);
}

export function emitSyncStatus(state: SyncState) {
  try {
    log("status →", state.kind, state.kind === "error" ? state.message : "");
    window.dispatchEvent(new CustomEvent("admin-sync-status", { detail: state }));
  } catch {}
}

export function readAdminCache(): AdminCachePayload | null {
  try {
    // migrate legacy key once, then wipe it so we don't keep two copies
    for (const legacy of LEGACY_KEYS) {
      const old = localStorage.getItem(legacy);
      if (old && !localStorage.getItem(KEY)) {
        try {
          const parsed = JSON.parse(old);
          const migrated: AdminCachePayload = {
            version: 0,
            settings: parsed?.settings ?? null,
            r2: parsed?.r2 ?? null,
            cached_at: Number(parsed?.cached_at) || Date.now(),
          };
          localStorage.setItem(KEY, JSON.stringify(migrated));
          log("migrated legacy cache", legacy, "→", KEY);
        } catch (e) {
          log("legacy migration failed for", legacy, e);
        }
        try { localStorage.removeItem(legacy); } catch {}
      }
    }
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      log("read: empty");
      return null;
    }
    const parsed = JSON.parse(raw) as AdminCachePayload;
    if (!parsed || typeof parsed !== "object" || !parsed.settings) {
      log("read: corrupt payload, discarding");
      try { localStorage.removeItem(KEY); } catch {}
      return null;
    }
    const ageMs = Date.now() - (Number(parsed.cached_at) || 0);
    log(`read: ok v${parsed.version} age=${Math.round(ageMs / 1000)}s`);
    return parsed;
  } catch (e) {
    log("read: parse error", e);
    try { localStorage.removeItem(KEY); } catch {}
    return null;
  }
}

export function writeAdminCache(payload: Omit<AdminCachePayload, "cached_at">) {
  try {
    const full: AdminCachePayload = { ...payload, cached_at: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(full));
    log(`write: ok v${full.version} settings.keys=${Object.keys(full.settings || {}).length}`);
  } catch (e) {
    log("write: failed", e);
    emitSyncStatus({ kind: "error", message: "Local cache write failed" });
  }
}

export function isCacheFresh(payload: AdminCachePayload | null): boolean {
  if (!payload) return false;
  return Date.now() - (Number(payload.cached_at) || 0) < MAX_AGE_MS;
}

// Called after every server load; if server-side version > cache, we've
// already replaced the cache in-place, but log the transition so a stale
// cache showing up in the wild is easy to spot.
export function reconcileVersion(cacheVersion: number, serverVersion: number) {
  if (serverVersion > cacheVersion) {
    log(`version bump: local v${cacheVersion} → server v${serverVersion} (cache replaced)`);
  } else if (serverVersion < cacheVersion) {
    log(`version regression: local v${cacheVersion} > server v${serverVersion} (kept server)`);
  }
}
