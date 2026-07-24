// Shared in-memory TTL cache for `app_settings` rows.
//
// WHY: `app_settings` was the #1 Disk IO offender — the same handful of keys
// (`email_filters`, `email_accounts`, `email_visibility`, `netflix_promo`,
// `location_policy`, `tv_feature`, `config`, `recaptcha`, …) were being read
// on every request and on every cron tick. A warm Deno isolate lives ~15 min,
// so a 30-second TTL cuts >95% of reads without making admin edits stale for
// more than half a minute.
//
// Callers MUST invoke `invalidateSetting(key)` (or `invalidateAllSettings()`)
// immediately after any `upsert`/`update` on `app_settings` so admin changes
// take effect without waiting for the TTL.

const TTL_MS = 30_000;
type Entry = { at: number; value: any };
const cache = new Map<string, Entry>();

export async function getSetting<T = any>(supabase: any, key: string, ttlMs: number = TTL_MS): Promise<T | null> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", key).maybeSingle();
    const value = (data?.value ?? null) as T;
    cache.set(key, { at: now, value });
    return value;
  } catch {
    // Serve slightly stale value rather than fail if the DB read errors.
    return (hit?.value as T) ?? null;
  }
}

export function invalidateSetting(key: string): void {
  cache.delete(key);
}

export function invalidateAllSettings(): void {
  cache.clear();
}

export function primeSetting(key: string, value: any): void {
  cache.set(key, { at: Date.now(), value });
}
