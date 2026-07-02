import { supabase } from "../integrations/supabase/client";
import { getVisitorGeo } from "./geo";

// Prime the visitor geo lookup as early as possible so the login call has
// the accurate IP/coords ready in sessionStorage.
if (typeof window !== "undefined") {
  void getVisitorGeo();
}

const WORKER_URLS_KEY = "cloudflare_worker_urls";
const BOOTSTRAP_CACHE_KEY = "bootstrap_cache_v1";
const BOOTSTRAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 8000;

export type EmailFilters = { showSignInCodes?: boolean; showPasswordResets?: boolean; showAccountUpdates?: boolean };
export type BootstrapResult = { users: any[]; recaptcha: any; workerUrls: string[]; emailFilters?: EmailFilters };

// Module-level filter cache — read synchronously by filterVisibleEmails.
let currentEmailFilters: EmailFilters = { showSignInCodes: true, showPasswordResets: false, showAccountUpdates: false };
try {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem("email_filters_cache_v1") : null;
  if (raw) currentEmailFilters = { ...currentEmailFilters, ...JSON.parse(raw) };
} catch {}
export function getEmailFilters(): EmailFilters { return currentEmailFilters; }
export function setEmailFilters(next: EmailFilters) {
  currentEmailFilters = { ...currentEmailFilters, ...next };
  try { localStorage.setItem("email_filters_cache_v1", JSON.stringify(currentEmailFilters)); } catch {}
}

function storeWorkerUrls(urls: string[]) {
  try {
    localStorage.setItem(WORKER_URLS_KEY, JSON.stringify(urls));
  } catch {}
}

export function markSessionStart() {
  try { localStorage.setItem("session_started_at", String(Date.now())); } catch {}
}

export function clearSessionData() {
  // Best-effort: revoke session server-side so the DB row is deleted.
  try {
    const token = localStorage.getItem("session_token");
    if (token) {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-app`;
      const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const body = JSON.stringify({ action: "logout" });
      // Use keepalive fetch so the request survives navigation/unload.
      fetch(url, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
          "apikey": key,
          "X-Session-Token": token,
        },
        body,
      }).catch(() => {});
    }
  } catch {}
  try {
    localStorage.removeItem("user");
    localStorage.removeItem("session_token");
    localStorage.removeItem("session_started_at");
    localStorage.removeItem("admin_auth");
    localStorage.removeItem("admin_backup");
    localStorage.removeItem("pending_admin_token");
    localStorage.removeItem("pending_admin_user");
  } catch {}
}

export function readBootstrapCache(): BootstrapResult | null {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > BOOTSTRAP_CACHE_TTL_MS) return null;
    return { users: parsed.users || [], recaptcha: parsed.recaptcha, workerUrls: parsed.workerUrls || [] };
  } catch { return null; }
}

function writeBootstrapCache(result: BootstrapResult) {
  try {
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify({ ...result, savedAt: Date.now() }));
  } catch {}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bootstrap timed out")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

export async function bootstrapFromSupabase(): Promise<BootstrapResult> {
  const { data, error } = await withTimeout(
    supabase.functions.invoke("manage-app", { body: { action: "bootstrap_public" } }),
    BOOTSTRAP_TIMEOUT_MS,
  );
  if (error) throw error;
  if (!data?.success) throw new Error(data?.error || "Bootstrap failed");

  if (Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
    storeWorkerUrls(data.workerUrls);
  }

  const result: BootstrapResult = { users: data.users || [], recaptcha: data.recaptcha, workerUrls: data.workerUrls || [] };
  writeBootstrapCache(result);
  return result;
}

export const bootstrapPromise: Promise<BootstrapResult> = bootstrapFromSupabase().catch((err) => {
  console.warn("[bootstrap] prefetch failed:", err);
  const cached = readBootstrapCache();
  if (cached) return cached;
  return { users: [], recaptcha: null, workerUrls: [] };
});

// Force-refresh: always hits the network, updates cache, returns fresh result.
export async function refreshBootstrap(): Promise<BootstrapResult> {
  try {
    return await bootstrapFromSupabase();
  } catch (err) {
    console.warn("[bootstrap] refresh failed:", err);
    const cached = readBootstrapCache();
    if (cached) return cached;
    return { users: [], recaptcha: null, workerUrls: [] };
  }
}

// Patch a single user's fields in the cached bootstrap so the next mount
// renders the new avatar/prefs instantly (no wait for network).
export function patchBootstrapCacheUser(userId: string, patch: Record<string, any>) {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.users)) return;
    parsed.users = parsed.users.map((u: any) => (u && u.id === userId ? { ...u, ...patch } : u));
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify(parsed));
  } catch {}
}

