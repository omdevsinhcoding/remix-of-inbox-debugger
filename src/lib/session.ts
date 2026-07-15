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
    const paths = new Set<string>(["/"]);
    try {
      const p = (typeof location !== "undefined" && location.pathname) || "/";
      paths.add(p);
      const segs = p.split("/").filter(Boolean);
      let acc = "";
      for (const s of segs) { acc += "/" + s; paths.add(acc); }
    } catch {}
    const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
    for (const name of names) {
      for (const p of paths) {
        for (const d of domains) {
          const base = `${name}=; expires=${expired}; Max-Age=0; path=${p}${d ? `; domain=${d}` : ""}`;
          try { document.cookie = base; } catch {}
          try { document.cookie = `${base}; SameSite=Lax`; } catch {}
          try { document.cookie = `${base}; SameSite=Strict`; } catch {}
          try { document.cookie = `${base}; SameSite=None; Secure`; } catch {}
        }
      }
    }
  } catch {}
}

// Netflix-style full identity wipe. Purges every client-visible storage
// surface for this origin: JS-readable cookies, localStorage, sessionStorage,
// IndexedDB databases, Cache Storage, and any registered service workers.
// HttpOnly cookies must be cleared server-side (manage-app logout) — this
// helper is the browser half of that flow.
export async function nukeBrowserIdentity(): Promise<void> {
  try { clearSiteCookies(); } catch {}
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  mem.clear();
  try {
    const idb: any = (typeof indexedDB !== "undefined" ? indexedDB : null);
    if (idb) {
      const dbs: Array<{ name?: string }> = typeof idb.databases === "function"
        ? await idb.databases().catch(() => [])
        : [];
      await Promise.all(dbs.map((db) => new Promise<void>((resolve) => {
        if (!db?.name) return resolve();
        try {
          const req = idb.deleteDatabase(db.name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        } catch { resolve(); }
      })));
    }
  } catch {}
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys().catch(() => [] as string[]);
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch {}
  try {
    if (typeof navigator !== "undefined" && navigator.serviceWorker?.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
  } catch {}
  try { clearSiteCookies(); } catch {}
}

// Convenience getters.
export const getSessionToken = () => sessionGet("session_token");
export const getUserRaw = () => sessionGet("user");
