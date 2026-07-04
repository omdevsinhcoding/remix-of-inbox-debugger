// C.2 client-side refresh scheduler.
//
// Server issues an access token (15 min TTL) + refresh token (12 h TTL) at
// every login site (login, admin 2FA finalize, impersonate). We store the
// refresh token in the same tab-scoped session store as session_token and
// schedule an auto-refresh ~60 s before access expiry. If the tab is closed,
// the next apiCall auto-refreshes on demand (see attemptAutoRefresh below).
//
// On refresh success, session_token + refresh_token + expiry keys rotate in
// place — the caller-facing UX is invisible. On refresh failure (reuse
// detected, expired refresh, binding mismatch), we clear all session keys
// and let the AuthProvider observe the missing token on next hydrate.

import { sessionGet, sessionSet, sessionRemove } from "./session";

// Local widening: we track refresh-token metadata alongside the existing
// session_token key. session.ts owns the canonical list; these keys are
// additive and namespaced.
const K_REFRESH = "refresh_token";
const K_REFRESH_EXP = "refresh_expires_at";
const K_ACCESS_EXP = "session_expires_at";

let armedTimer: number | null = null;
let inflight: Promise<boolean> | null = null;

export function storeSessionPair(data: {
  sessionToken?: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}) {
  if (!data) return;
  if (data.expiresAt) sessionSet(K_ACCESS_EXP as any, String(data.expiresAt));
  if (data.refreshToken) sessionSet(K_REFRESH as any, data.refreshToken);
  if (data.refreshExpiresAt) sessionSet(K_REFRESH_EXP as any, String(data.refreshExpiresAt));
  armAutoRefresh();
}

export function clearRefreshState() {
  if (armedTimer !== null) { clearTimeout(armedTimer); armedTimer = null; }
  try { sessionRemove(K_REFRESH as any); } catch {}
  try { sessionRemove(K_REFRESH_EXP as any); } catch {}
  try { sessionRemove(K_ACCESS_EXP as any); } catch {}
}

function getRefreshToken(): string | null { try { return sessionGet(K_REFRESH as any); } catch { return null; } }
function getAccessExp(): number { const v = (() => { try { return sessionGet(K_ACCESS_EXP as any); } catch { return null; } })(); return v ? Number(v) : 0; }
function getRefreshExp(): number { const v = (() => { try { return sessionGet(K_REFRESH_EXP as any); } catch { return null; } })(); return v ? Number(v) : 0; }

export function armAutoRefresh() {
  if (armedTimer !== null) { clearTimeout(armedTimer); armedTimer = null; }
  const refresh = getRefreshToken();
  const accessExp = getAccessExp();
  if (!refresh || !accessExp) return;
  const lead = 60_000; // fire 60 s before access expiry
  const delay = Math.max(5_000, accessExp - Date.now() - lead);
  armedTimer = window.setTimeout(() => { refreshNow().catch(() => {}); }, delay);
}

// Refresh once, coalescing concurrent callers. Returns true if session was
// rotated successfully; false if refresh is impossible (no token, expired,
// or server rejected).
export async function refreshNow(): Promise<boolean> {
  if (inflight) return inflight;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  const refreshExp = getRefreshExp();
  if (refreshExp && refreshExp < Date.now()) { clearRefreshState(); return false; }

  inflight = (async () => {
    try {
      const { invokeEdge } = await import("./secureTransport");
      const data: any = await invokeEdge("manage-app", { action: "refresh_session", refreshToken }, { headers: {} });
      if (!data?.success || !data?.sessionToken) throw new Error(data?.error || "refresh failed");
      sessionSet("session_token" as any, data.sessionToken);
      storeSessionPair(data);
      return true;
    } catch {
      // Refresh irrecoverable — clear session so AuthProvider signs the user out.
      try { sessionRemove("session_token" as any); } catch {}
      try { sessionRemove("user" as any); } catch {}
      clearRefreshState();
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Call before an authenticated request if the access token is within `lead`
// ms of expiry — lets short-lived tabs (mobile, background throttling) still
// present a live token.
export async function ensureFreshAccess(leadMs = 30_000): Promise<void> {
  const accessExp = getAccessExp();
  if (!accessExp) return; // legacy session without pair — leave alone
  if (accessExp - Date.now() > leadMs) return;
  await refreshNow();
}
