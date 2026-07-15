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

// Netflix-style cookie purge. Expires every readable cookie across the current
// path, root path, current hostname, and every parent domain (e.g. sub.example.com,
// .sub.example.com, .example.com). HttpOnly cookies set by the server cannot be
// touched from JS — those are cleared server-side via manage-app `logout`.
export function clearSiteCookies() {
  try {
    if (typeof document === "undefined") return;
    const raw = document.cookie ? document.cookie.split(";") : [];
    const names = new Set<string>();
    for (const chunk of raw) {
      const eq = chunk.indexOf("=");
      const n = (eq >= 0 ? chunk.slice(0, eq) : chunk).trim();
      if (n) names.add(n);
    }
    const host = typeof location !== "undefined" ? location.hostname : "";
    const parts = host.split(".").filter(Boolean);
    const domains: string[] = [""];
    if (host) { domains.push(host); domains.push("." + host); }
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(i).join(".");
      if (d) { domains.push(d); domains.push("." + d); }
    }
    const paths = ["/", (typeof location !== "undefined" && location.pathname) || "/"];
    const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
    for (const name of names) {
      for (const p of paths) {
        for (const d of domains) {
          try {
            document.cookie = `${name}=; expires=${expired}; path=${p}${d ? `; domain=${d}` : ""}; SameSite=Lax`;
            document.cookie = `${name}=; expires=${expired}; path=${p}${d ? `; domain=${d}` : ""}; SameSite=None; Secure`;
          } catch {}
        }
      }
    }
  } catch {}
}

// Convenience getters.
export const getSessionToken = () => sessionGet("session_token");
export const getUserRaw = () => sessionGet("user");
