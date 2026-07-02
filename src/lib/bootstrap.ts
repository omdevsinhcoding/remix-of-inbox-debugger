import { supabase } from "../integrations/supabase/client";
import { setAvatarBaseUrl } from "./avatars";

const WORKER_URLS_KEY = "cloudflare_worker_urls";
const BOOTSTRAP_CACHE_KEY = "bootstrap_cache_v1";
const BOOTSTRAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 8000;

export type EmailFilters = { showSignInCodes?: boolean; showPasswordResets?: boolean; showAccountUpdates?: boolean };
export type MaintenanceInfo = { enabled: boolean; title?: string; message?: string; eta?: string; startsAt?: string | null; endsAt?: string | null; versionFrom?: string; versionTo?: string; updated_at?: string | null };
export type BootstrapResult = { users: any[]; recaptcha: any; workerUrls: string[]; emailFilters?: EmailFilters; maintenance?: MaintenanceInfo; avatarBaseUrl?: string };


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
    // Capture the user id BEFORE clearing so we can purge that profile's OTP cache too.
    let uid: string | null = null;
    try {
      const raw = localStorage.getItem("user");
      if (raw) uid = JSON.parse(raw)?.id || null;
    } catch {}
    localStorage.removeItem("user");
    localStorage.removeItem("session_token");
    localStorage.removeItem("session_started_at");
    localStorage.removeItem("admin_auth");
    localStorage.removeItem("pending_admin_token");
    localStorage.removeItem("pending_admin_user");
    // F4: impersonation backup is now in sessionStorage; sweep both stores for safety.
    localStorage.removeItem("admin_backup");
    try { sessionStorage.removeItem("admin_backup"); } catch {}
    // F8: purge cached Netflix OTP emails so the next profile on this device
    // can't read the previous profile's inbox after a timeout/forced logout.
    if (uid) localStorage.removeItem(`cached_emails_v1:${uid}`);
    try {
      // Belt-and-suspenders: sweep any lingering per-profile caches.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith("cached_emails_v1:")) localStorage.removeItem(k);
      }
    } catch {}
  } catch {}
}


export function readBootstrapCache(): BootstrapResult | null {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > BOOTSTRAP_CACHE_TTL_MS) return null;
    const result = { users: parsed.users || [], recaptcha: parsed.recaptcha, workerUrls: parsed.workerUrls || [], emailFilters: parsed.emailFilters, maintenance: parsed.maintenance, avatarBaseUrl: parsed.avatarBaseUrl || "" };
    setAvatarBaseUrl(result.avatarBaseUrl);
    return result;
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

  const result: BootstrapResult = { users: data.users || [], recaptcha: data.recaptcha, workerUrls: data.workerUrls || [], emailFilters: data.emailFilters || {}, maintenance: data.maintenance || { enabled: false }, avatarBaseUrl: data.avatarBaseUrl || "" };
  setAvatarBaseUrl(result.avatarBaseUrl);
  if (data.emailFilters && typeof data.emailFilters === "object") setEmailFilters(data.emailFilters);
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

// ---------- Notifications helpers ----------
export type NotificationCategory = "announcement" | "update" | "security" | "maintenance" | "promo" | "billing";
export type NotificationPriority = "low" | "normal" | "high" | "critical";

export type AppNotification = {
  id: string;
  title: string;
  body: string;
  description?: string | null;
  body_markdown?: string | null;
  image_url?: string | null;
  category?: NotificationCategory | string;
  priority?: NotificationPriority | string;
  icon?: string | null;
  platform_icon?: string | null;
  kind?: "flash" | "article" | string;
  sub_kind?: string | null;
  locked?: boolean;
  show_frequency?: "once" | "always" | "session" | "daily" | string | null;
  mode?: "popup" | "silent" | "banner" | string | null;
  action_url?: string | null;
  action_label?: string | null;
  action2_url?: string | null;
  action2_label?: string | null;
  pinned?: boolean;
  audience: "all" | "user";
  created_at: string;
  expires_at: string | null;
  publish_at?: string | null;
  read: boolean;
  seen?: boolean;
  archived?: boolean;
  snoozed_until?: string | null;
};

async function callManage<T = any>(action: string, payload: Record<string, any> = {}): Promise<T> {
  const token = localStorage.getItem("session_token");
  const headers: Record<string, string> = {};
  if (token) headers["X-Session-Token"] = token;
  const { data, error } = await supabase.functions.invoke("manage-app", {
    body: { action, ...payload },
    headers,
  });
  if (error) throw error;
  if (!data?.success) throw new Error(data?.error || `${action} failed`);
  return data as T;
}

export async function listNotifications(): Promise<AppNotification[]> {
  try {
    const data = await callManage<{ notifications: AppNotification[] }>("list_notifications");
    return data.notifications || [];
  } catch (err) {
    console.warn("[notifications] list failed:", err);
    return [];
  }
}

export async function markNotificationRead(id: string): Promise<void> {
  try { await callManage("mark_notification_read", { notification_id: id }); } catch {}
}
export async function markAllNotificationsRead(): Promise<void> {
  try { await callManage("mark_all_notifications_read"); } catch {}
}
export async function markNotificationSeen(ids: string[]): Promise<void> {
  if (!ids?.length) return;
  try { await callManage("mark_notifications_seen", { ids }); } catch {}
}
export async function archiveNotification(id: string): Promise<void> {
  try { await callManage("archive_notification", { notification_id: id }); } catch {}
}
export async function deleteNotificationForMe(id: string): Promise<void> {
  try { await callManage("user_delete_notification", { notification_id: id }); } catch {}
}
export async function snoozeNotification(id: string, until: string): Promise<void> {
  try { await callManage("snooze_notification", { notification_id: id, until }); } catch {}
}
export async function logNotificationEvent(id: string, event: string, meta?: any): Promise<void> {
  try { await callManage("log_notification_event", { notification_id: id, event, meta }); } catch {}
}

export async function clearMyInbox(visibleIds: string[]): Promise<any> {
  return await callManage("clear_user_inbox", { visibleIds });
}

// Auto-popup dedupe: track which notification IDs the user has already been popped for.
const POPUP_SEEN_KEY = "notif_popup_seen_v1";
export function getPoppedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(POPUP_SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
export function markPopped(id: string) {
  try {
    const s = getPoppedIds();
    s.add(id);
    const arr = Array.from(s).slice(-200);
    localStorage.setItem(POPUP_SEEN_KEY, JSON.stringify(arr));
  } catch {}
}



