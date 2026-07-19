// Session state store — in-memory primary, sessionStorage mirror for
// per-tab reload survival. NEVER touches localStorage; nothing here
// persists across tab close, and no other tab can read it.
//
// Session keys owned by this module:
//   session_token, refresh_token, session_expires_at, refresh_expires_at,
//   session_family_id, user, admin_auth, admin_backup, pending_admin_token,
//   pending_admin_token_at, session_started_at, cloudflare_worker_urls
//
// Everything else (worker URL cache, stats cache, email cache) still uses
// localStorage — those are non-secret UX caches.

const KEYS = [
  "session_token",
  "refresh_token",
  "session_expires_at",
  "refresh_expires_at",
  "session_family_id",
  "user",
  "admin_auth",
  "admin_backup",
  "pending_admin_token",
  "pending_admin_token_at",
  "session_started_at",
  "cloudflare_worker_urls",
] as const;

type SessionKey = typeof KEYS[number];

// In-memory primary store (never touches disk).
const mem = new Map<string, string>();

function ssGet(k: string): string | null {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function ssSet(k: string, v: string) {
  try { sessionStorage.setItem(k, v); } catch {}
}
function ssRemove(k: string) {
  try { sessionStorage.removeItem(k); } catch {}
}

// One-time migration: if legacy localStorage still holds session keys
// from a previous build, move them into sessionStorage and wipe.
(function migrateFromLocalStorage() {
  try {
    for (const k of KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) {
        ssSet(k, v);
        try { localStorage.removeItem(k); } catch {}
      }
    }
  } catch {}
})();

export function sessionGet(k: SessionKey): string | null {
  if (mem.has(k)) return mem.get(k) ?? null;
  const v = ssGet(k);
  if (v !== null) mem.set(k, v);
  return v;
}

export function sessionSet(k: SessionKey, v: string) {
  mem.set(k, v);
  ssSet(k, v);
}

export function sessionRemove(k: SessionKey) {
  mem.delete(k);
  ssRemove(k);
}

export function sessionClearAll() {
  for (const k of KEYS) sessionRemove(k);
}

// Convenience getters.
export const getSessionToken = () => sessionGet("session_token");
export const getUserRaw = () => sessionGet("user");
