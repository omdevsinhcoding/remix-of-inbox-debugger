import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.2.18";
import { simpleParser } from "npm:mailparser@3.9.6";
import { readRequest, maybeEncryptResponse, EncryptedRequestContext, PlaintextRejectedError, plaintextRejectedResponse, TransportError, transportErrorResponse } from "../_shared/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token, x-cron-secret, x-crypto-session",
};

const PASSWORD_RESET_SUBJECTS = [
  "reset your password", "forgot password", "password reset",
  "change your password", "password change", "password recovery",
  "account recovery", "reset password",
];

const SIGN_IN_CODE_SUBJECTS = [
  "enter this code", "sign-in code", "sign in to", "sign-in activity",
  "verification code", "login code", "sign in code",
];

// Only extract an OTP when the email is *actually* a sign-in / verification code email.
// Netflix marketing emails often contain random 4-8 digit numbers (dates, IDs) that must NOT
// be shown as an OTP.
const OTP_SUBJECT_HINT = /(sign[\s-]?in code|verification code|one[\s-]?time|login code|enter this code|access code|otp|confirm.*account|verify.*account|temporary.*code)/i;
const OTP_BODY_CONTEXT = /(sign[\s-]?in code|verification code|one[\s-]?time (?:code|password|pin)|otp|login code|enter (?:the |this )?code|use (?:the |this )?code|your code is|code below|access code|temporary (?:code|password|pin))/i;

function extractOtpCode(subject: string, body: string): string | null {
  const subj = (subject || "").toString();
  const txt = (body || "").toString();
  const looksLikeCodeEmail = OTP_SUBJECT_HINT.test(subj) || OTP_BODY_CONTEXT.test(txt);
  if (!looksLikeCodeEmail) return null;

  // Strategy 1: number that appears near a context keyword (within ~80 chars).
  const contextRe = /(sign[\s-]?in code|verification code|one[\s-]?time (?:code|password|pin)|otp|login code|access code|your code is|use (?:the |this )?code|enter (?:the |this )?code|temporary (?:code|password|pin))[\s\S]{0,80}?\b(\d{4,8})\b/i;
  const m1 = txt.match(contextRe) || subj.match(contextRe);
  if (m1 && m1[2]) return m1[2];

  // Strategy 2: standalone 4-8 digit block on its own line (Netflix formats codes this way).
  const lineRe = /^\s*(\d{4,8})\s*$/m;
  const m2 = txt.match(lineRe);
  if (m2 && m2[1]) return m2[1];

  return null;
}

const FULL_SYNC_MAX_UIDS = 10;
const USER_REFRESH_MAX_UIDS = 3;
const PER_ACCOUNT_TIMEOUT_MS = 6500;
const STALE_DAYS = 60;
const USER_SYNC_WINDOW_MS = 5_000;
const userSyncHits = new Map<string, number>();

type Session = { userId: string; username: string; role: "admin" | "user"; assignedAccounts?: string[] | null; exp?: number };
type Account = { label: string; host: string; port: number; user: string; password: string };

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function verifySessionToken(token: string, secret: string): Promise<Session | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function requireSession(req: Request, body: any, primary: string, legacy?: string): Promise<Session | null> {
  const token = req.headers.get("x-session-token") || body.sessionToken;
  if (!token) return null;
  const p = await verifySessionToken(token, primary);
  if (p) return p;
  if (legacy && legacy !== primary) return await verifySessionToken(token, legacy);
  return null;
}


async function deriveEncKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("imap-enc-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
  );
}

async function decryptValue(encrypted: string, secret: string): Promise<string> {
  if (!encrypted?.startsWith?.("enc:")) return encrypted;
  const [, ivHex, ctHex] = encrypted.split(":");
  const key = await deriveEncKey(secret);
  const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

async function getAssignedAccountFilter(supabase: any, session: Session | null): Promise<string[] | null> {
  if (!session || session.role === "admin") return null;
  const { data: userData } = await supabase.from("app_users").select("assigned_accounts").eq("id", session.userId).single();
  // For non-admin users: return the assigned list (possibly empty).
  // An empty array means "no accounts ticked" -> show nothing.
  return Array.isArray(userData?.assigned_accounts) ? userData.assigned_accounts : [];
}

function applyEmailFilters(emails: any[], filterSignInCodes: boolean, filterPasswordResets: boolean) {
  let output = emails;
  if (filterSignInCodes) {
    output = output.filter((e: any) => {
      const sub = (e.subject || "").toLowerCase();
      return !SIGN_IN_CODE_SUBJECTS.some(kw => sub.includes(kw));
    });
  }
  if (filterPasswordResets) {
    output = output.filter((e: any) => {
      const sub = (e.subject || "").toLowerCase();
      return !PASSWORD_RESET_SUBJECTS.some(kw => sub.includes(kw));
    });
  }
  return output;
}

async function getEmailVisibility(supabase: any): Promise<{ enabled: boolean; days: number } | null> {
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "email_visibility").maybeSingle();
    const v = data?.value;
    if (v && v.enabled === true && Number(v.days) > 0) return { enabled: true, days: Number(v.days) };
  } catch {}
  return null;
}

function clampLimit(value: any, fallback: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function readCache(supabase: any, accountFilter: string[] | null, filterSignInCodes: boolean, filterPasswordResets: boolean, session: Session | null, limit = 500) {
  const safeLimit = clampLimit(limit, 500, session?.role === "admin" ? 500 : 50);
  // Non-admin with zero assigned accounts -> nothing visible.
  if (accountFilter && accountFilter.length === 0 && session && session.role !== "admin") return [];
  let query = supabase.from("cached_emails").select("*").order("date", { ascending: false }).limit(safeLimit);
  if (accountFilter && accountFilter.length > 0) query = query.in("account_label", accountFilter);
  if (session && session.role !== "admin") {
    const vis = await getEmailVisibility(supabase);
    if (vis) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - vis.days);
      query = query.gte("date", cutoff.toISOString());
    }
  }
  const { data: cached, error } = await query;
  if (error) throw error;
  const emails = (cached || []).map((e: any) => ({
    id: e.id,
    subject: e.subject,
    from: e.from_address,
    to: e.to_address,
    date: e.date,
    otp: e.otp,
    preview: e.preview,
    html: e.html,
    account_label: e.account_label,
    cached_at: e.cached_at,
  }));
  return applyEmailFilters(emails, filterSignInCodes, filterPasswordResets);
}

async function fetchFromAccount(
  imapHost: string,
  imapPort: number,
  imapUser: string,
  imapPassword: string,
  accountLabel: string,
  maxMessages = FULL_SYNC_MAX_UIDS,
): Promise<{ emails: any[]; fetched: number; skipped: number }> {
  const emails: any[] = [];
  let timedOut = false;
  const startedAt = Date.now();
  const timer = setTimeout(() => { timedOut = true; }, PER_ACCOUNT_TIMEOUT_MS);
  const hasBudget = () => !timedOut && Date.now() - startedAt < PER_ACCOUNT_TIMEOUT_MS;

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: true,
    auth: { user: imapUser, pass: imapPassword },
    logger: false,
    socketTimeout: 7000,
    greetingTimeout: 3000,
  });

  try {
    await client.connect();
    console.log(`[${accountLabel}] IMAP connected to ${imapHost}`);
    const lock = await client.getMailboxLock("INBOX");

    try {
      let netflixUids: number[] = [];
      const totalMessages = (client.mailbox as any)?.exists || 0;

      // Fast path: newly delivered OTP emails are almost always in the newest inbox rows.
      // Fetching envelopes for the last few messages is much faster than a server-side IMAP search.
      if (totalMessages > 0 && hasBudget()) {
        const startSeq = Math.max(1, totalMessages - 11);
        for await (const message of client.fetch(`${startSeq}:${totalMessages}`, { envelope: true, uid: true })) {
          if (!hasBudget()) break;
          const fromAddr = message.envelope?.from?.[0]?.address?.toLowerCase() || "";
          const toAddr = message.envelope?.to?.[0]?.address?.toLowerCase() || "";
          const subject = (message.envelope?.subject || "").toLowerCase();
          if (fromAddr.includes("netflix") || toAddr.includes("netflix") || subject.includes("netflix")) {
            netflixUids.push(message.uid);
          }
        }
        if (netflixUids.length > 0) console.log(`[${accountLabel}] Latest inbox scan found ${netflixUids.length}`);
      }

      if (netflixUids.length === 0 && hasBudget()) {
        const since = new Date();
        since.setDate(since.getDate() - 7);
        for (const term of ["netflix.com", "netflix"]) {
          if (netflixUids.length > 0 || !hasBudget()) break;
          try {
            const searchResults = await client.search({ from: term, since }, { uid: true });
            if (searchResults?.length > 0) {
              netflixUids = searchResults as number[];
              console.log(`[${accountLabel}] Search "${term}" found ${netflixUids.length}`);
            }
          } catch (searchErr) {
            console.log(`[${accountLabel}] Search "${term}" failed:`, searchErr);
          }
        }
      }

      netflixUids = Array.from(new Set(netflixUids)).sort((a, b) => b - a);
      const uidsToFetch = netflixUids.slice(0, clampLimit(maxMessages, USER_REFRESH_MAX_UIDS, FULL_SYNC_MAX_UIDS));
      console.log(`[${accountLabel}] Fetching ${uidsToFetch.length} recent candidate UIDs`);

      for (const uid of uidsToFetch) {
        if (!hasBudget()) {
          console.log(`[${accountLabel}] Timed out, stopping fetch`);
          break;
        }

        try {
          const fullMsg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!fullMsg?.source) continue;

          const parsed = await simpleParser(fullMsg.source, { skipImageLinks: true, skipTextLinks: true });
          const bodyText = (parsed.text || "").trim();
          const subjectText = (parsed.subject || fullMsg.envelope?.subject || "").toString();
          const otpCode = extractOtpCode(subjectText, bodyText);
          const stableId = `${accountLabel}:${uid}`;

          emails.push({
            id: stableId,
            message_id: parsed.messageId || null,
            subject: parsed.subject || fullMsg.envelope?.subject || "",
            from: parsed.from?.text || "Netflix",
            to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text) : undefined,
            date: parsed.date || new Date(),
            otp: otpCode,
            preview: bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText,
            html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
            account_label: accountLabel,
          });
        } catch (parseErr) {
          const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          console.error(`[${accountLabel}] Fetch error UID ${uid}: ${errMsg}`);
          if (/eof|closed|reset|tls|socket/i.test(errMsg)) break;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    clearTimeout(timer);
    try { await client.logout(); } catch {}
  }

  return { emails, fetched: emails.length, skipped: 0 };
}

async function loadAccounts(supabase: any, secret: string, accountLabels: string[] | null): Promise<Account[]> {
  let accounts: Account[] = [];

  try {
    const { data: accountsData } = await supabase.from("app_settings").select("value").eq("key", "email_accounts").single();
    if (Array.isArray(accountsData?.value)) {
      const decrypted = await Promise.all(accountsData.value.map(async (acc: any) => {
        if (!acc.user || !acc.password) return null;
        return {
          label: acc.label || acc.user,
          host: acc.host || "imap.gmail.com",
          port: parseInt(acc.port) || 993,
          user: acc.user,
          password: await decryptValue(acc.password, secret),
        } as Account;
      }));
      accounts.push(...decrypted.filter(Boolean) as Account[]);
    }
  } catch (err) {
    console.error("[sync] Failed to load email_accounts:", err);
  }

  let primaryHost = "", primaryPort = 993, primaryUser = "", primaryPassword = "";
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "config").single();
    const config = data?.value as any;
    if (config) {
      primaryHost = config.IMAP_HOST || "";
      primaryPort = parseInt(config.IMAP_PORT) || 993;
      primaryUser = config.IMAP_USER || "";
      primaryPassword = config.IMAP_PASSWORD || "";
      if (primaryPassword?.startsWith?.("enc:")) primaryPassword = await decryptValue(primaryPassword, secret);
    }
  } catch {}

  if (!primaryHost) primaryHost = Deno.env.get("IMAP_HOST") || "imap.gmail.com";
  if (!primaryUser) primaryUser = Deno.env.get("IMAP_USER") || "";
  if (!primaryPassword) primaryPassword = Deno.env.get("IMAP_PASSWORD") || "";
  const envPort = Deno.env.get("IMAP_PORT");
  if (primaryPort === 993 && envPort) primaryPort = parseInt(envPort) || 993;

  if (primaryUser && primaryPassword && !accounts.some(a => a.user === primaryUser)) {
    accounts.unshift({ label: "Primary", host: primaryHost, port: primaryPort, user: primaryUser, password: primaryPassword });
  }

  if (accountLabels && accountLabels.length > 0) {
    accounts = accounts.filter(a => accountLabels.includes(a.label));
  }

  return accounts;
}

async function runSync(supabase: any, secret: string, source: string, accountLabels: string[] | null, maxMessages = FULL_SYNC_MAX_UIDS) {
  console.log(`[sync] Starting parallel IMAP sync (source: ${source})`);
  const accounts = await loadAccounts(supabase, secret, accountLabels);

  if (accounts.length === 0) {
    return { success: false, error: "Inbox not configured. Add IMAP email in Admin Panel.", stats: {}, totalFetched: 0, inserted: 0 };
  }

  try {
    await supabase.from("cached_emails").update({ account_label: "Primary" }).is("account_label", null);
  } catch (e) {
    console.error("[sync] Legacy label backfill skipped:", e);
  }

  const settled = await Promise.allSettled(accounts.map(async (acc) => {
    console.log(`[sync] Fetching ${acc.label} (${acc.user})`);
    const result = await fetchFromAccount(acc.host, acc.port, acc.user, acc.password, acc.label, maxMessages);
    return { acc, result };
  }));

  const allEmails: any[] = [];
  const accountErrors: Array<{ label: string; error: string }> = [];
  const syncStats: Record<string, { fetched: number; skipped: number; error?: string }> = {};

  settled.forEach((item, index) => {
    const label = accounts[index]?.label || `Account ${index + 1}`;
    if (item.status === "fulfilled") {
      syncStats[label] = { fetched: item.value.result.fetched, skipped: item.value.result.skipped };
      allEmails.push(...item.value.result.emails);
    } else {
      const errMsg = item.reason instanceof Error ? item.reason.message : String(item.reason);
      const isAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errMsg);
      const errorText = isAuthError ? `IMAP login failed for "${label}". Check email and app password.` : `Failed to connect to "${label}": ${errMsg}`;
      syncStats[label] = { fetched: 0, skipped: 0, error: errorText };
      accountErrors.push({ label, error: errorText });
    }
  });

  if (accountErrors.length > 0 && accountErrors.length === accounts.length) {
    const combinedMsg = accountErrors.map(e => e.error).join(" | ");
    console.error("[sync] All accounts failed:", combinedMsg);
    return { success: false, error: combinedMsg, stats: syncStats, totalFetched: 0, inserted: 0 };
  }

  allEmails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  let inserted = 0;
  if (allEmails.length > 0) {
    const rows = allEmails.map((e: any) => ({
      id: String(e.id),
      subject: e.subject,
      from_address: e.from,
      to_address: e.to || null,
      date: e.date,
      otp: e.otp || null,
      preview: e.preview || null,
      html: e.html || null,
      account_label: e.account_label || "Primary",
      cached_at: new Date().toISOString(),
      message_id: e.message_id || null,
    }));

    const { error: upsertErr } = await supabase.from("cached_emails").upsert(rows, { onConflict: "id" });
    if (upsertErr) console.error("[sync] Cache upsert error:", upsertErr);
    else inserted = rows.length;
  }

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - STALE_DAYS);
    await supabase.from("cached_emails").delete().lt("date", cutoff.toISOString());
  } catch (e) {
    console.error("[sync] Stale cleanup error:", e);
  }

  const response: any = {
    success: true,
    emails: allEmails,
    stats: syncStats,
    totalFetched: allEmails.length,
    inserted,
    duplicatesSkipped: 0,
  };
  if (accountErrors.length > 0) response.warnings = accountErrors.map(e => e.error);
  console.log(`[sync] Complete: ${allEmails.length} fetched/upserted across ${accounts.length} account(s)`);
  return response;
}

Deno.serve(async (originalReq) => {
  if (originalReq.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ---- transport encryption boundary ----
  // Cron/server-to-server callers authenticate with x-cron-secret and are
  // allowed to POST plaintext JSON. All other callers MUST use encrypted transport.
  const hasCronSecret = !!originalReq.headers.get("x-cron-secret");
  let ctx: EncryptedRequestContext | null = null;
  let parsedBody: any = null;
  try {
    const r = await readRequest(originalReq, { allowPlaintext: hasCronSecret });
    parsedBody = r.body ?? {};
    ctx = r.encrypted ? r.ctx : null;
  } catch (e) {
    if (e instanceof PlaintextRejectedError) return plaintextRejectedResponse();
    if (e instanceof TransportError) return transportErrorResponse(e);
    return new Response(JSON.stringify({ success: false, error: "bad request" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const req = new Request(originalReq.url, {
    method: originalReq.method,
    headers: originalReq.headers,
    body: JSON.stringify(parsedBody ?? {}),
  });
  const __run = async () => {
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // F5: dedicated signing key with legacy fallback (see manage-app).
    // ENCRYPTION_SECRET (=SERVICE_ROLE_KEY) stays for decrypting IMAP passwords in runSync.
    const ENCRYPTION_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SIGNING_SECRET = Deno.env.get("SESSION_SIGNING_SECRET") || ENCRYPTION_SECRET;
    const LEGACY_SIGNING = ENCRYPTION_SECRET;
    const CRON_SHARED_SECRET = Deno.env.get("CRON_SHARED_SECRET") || "";

    let body: any = {};
    try { body = await req.json(); } catch {}
    const mode = body.mode || "sync";
    const source = body.source || "manual";
    const session = await requireSession(req, body, SIGNING_SECRET, LEGACY_SIGNING);
    const isCron = !!CRON_SHARED_SECRET && req.headers.get("x-cron-secret") === CRON_SHARED_SECRET;


    let filterSignInCodes = false;
    let filterPasswordResets = true;
    try {
      const { data: filterData } = await supabase.from("app_settings").select("value").eq("key", "email_filters").single();
      if (filterData?.value) {
        if (filterData.value.showSignInCodes === false) filterSignInCodes = true;
        if (filterData.value.showPasswordResets === true) filterPasswordResets = false;
      }
    } catch {}

    if (mode === "cron_status") {
      if (!session || session.role !== "admin") return json({ success: false, error: "Admin session required" }, 401);
      try {
        const { data, error } = await supabase.rpc("get_cron_status");
        if (error) throw error;
        return json(data);
      } catch {
        const { data: fallback } = await supabase.from("app_settings").select("value").eq("key", "cron_config").single();
        return json({ active: fallback?.value?.active || false, interval: fallback?.value?.interval || 3, lastSync: null });
      }
    }

    if (mode === "cron_toggle") {
      if (!session || session.role !== "admin") return json({ success: false, error: "Admin session required" }, 401);
      const enabled = body.enabled === true;
      const interval = parseInt(body.interval) || 3;
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
      if (!ANON_KEY) return json({ success: false, error: "SUPABASE_ANON_KEY is not configured" }, 500);
      if (!CRON_SHARED_SECRET) return json({ success: false, error: "CRON_SHARED_SECRET is not configured" }, 500);

      try {
        try { await supabase.rpc("unschedule_email_sync"); } catch {}
        if (enabled) {
          const cronExpr = `*/${interval} * * * *`;
          const { error: schedErr } = await supabase.rpc("schedule_email_sync", {
            cron_expr: cronExpr,
            function_url: `${SUPABASE_URL}/functions/v1/fetch-emails`,
            auth_key: CRON_SHARED_SECRET,
          });
          if (schedErr) throw schedErr;
        }
        await supabase.from("app_settings").upsert({ key: "cron_config", value: { active: enabled, interval } }, { onConflict: "key" });
        return json({ success: true, active: enabled, interval });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[cron] Toggle error:", msg);
        return json({ success: false, error: msg }, 500);
      }
    }

    if (mode === "cache") {
      if (!session) return json({ success: false, error: "Authentication required" }, 401);
      const accountFilter = await getAssignedAccountFilter(supabase, session);
      const emails = await readCache(supabase, accountFilter, filterSignInCodes, filterPasswordResets, session, body.limit);
      return json(emails);
    }

    if (mode === "unfiltered_count") {
      if (!session) return json({ success: false, error: "Authentication required" }, 401);
      const accountFilter = await getAssignedAccountFilter(supabase, session);
      if (session.role !== "admin" && accountFilter && accountFilter.length === 0) {
        return json({ total: 0, error: null });
      }
      let query = supabase.from("cached_emails").select("id", { count: "exact", head: true });
      if (accountFilter && accountFilter.length > 0) query = query.in("account_label", accountFilter);
      if (session.role !== "admin") {
        const vis = await getEmailVisibility(supabase);
        if (vis) {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - vis.days);
          query = query.gte("date", cutoff.toISOString());
        }
      }
      const { count, error } = await query;
      return json({ total: count || 0, error: error?.message || null });
    }

    const adminOrCron = (session?.role === "admin") || isCron;
    const userRequestedSync = mode === "user_sync" || mode === "sync_async";
    if (mode === "sync" && !adminOrCron) return json({ success: false, error: "Admin session or cron secret required" }, 401);
    if (userRequestedSync && !session && !isCron) return json({ success: false, error: "Authentication required" }, 401);
    if (!["sync", "sync_async", "user_sync"].includes(mode)) return json({ success: false, error: `Unknown mode: ${mode}` }, 400);

    let accountLabels: string[] | null = null;
    if (Array.isArray(body.accountLabels) && body.accountLabels.length > 0) accountLabels = body.accountLabels;

    if (session && session.role !== "admin") {
      const assigned = await getAssignedAccountFilter(supabase, session);
      // Non-admin user: restrict sync scope to their assigned accounts.
      // Empty assignment -> nothing to sync/display.
      if (assigned && assigned.length === 0) {
        return json({ success: true, accepted: true, emails: [], message: "No accounts assigned" }, mode === "sync_async" ? 202 : 200);
      }
      if (assigned && assigned.length > 0) accountLabels = accountLabels ? accountLabels.filter(l => assigned.includes(l)) : assigned;
      if (mode === "sync_async" && source !== "user_refresh") {
        const last = userSyncHits.get(session.userId) || 0;
        if (Date.now() - last < USER_SYNC_WINDOW_MS) {
          const cache = await readCache(supabase, assigned, filterSignInCodes, filterPasswordResets, session, body.limit);
          return json({ success: true, rateLimited: true, message: "Please wait before refreshing again", emails: cache }, 202);
        }
        userSyncHits.set(session.userId, Date.now());
      }
    }

    if (mode === "sync_async" && source !== "user_refresh") {
      const accountFilterForCache = session ? await getAssignedAccountFilter(supabase, session) : null;
      const cache = session ? await readCache(supabase, accountFilterForCache, filterSignInCodes, filterPasswordResets, session, body.limit).catch(() => []) : [];
      const maxMessages = clampLimit(body.limit, USER_REFRESH_MAX_UIDS, FULL_SYNC_MAX_UIDS);
      const work = runSync(supabase, ENCRYPTION_SECRET, source || "async", accountLabels, maxMessages).catch(err => console.error("[sync_async] background failed:", err));
      ((globalThis as any).EdgeRuntime?.waitUntil?.(work) ?? work);
      return json({ success: true, accepted: true, emails: cache }, 202);
    }

    const result = await runSync(supabase, ENCRYPTION_SECRET, source, accountLabels, clampLimit(body.limit, FULL_SYNC_MAX_UIDS, FULL_SYNC_MAX_UIDS));
    return json(result, result.success === false ? 502 : 200);
  } catch (err) {
    console.error("[sync] Fatal error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isImapAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errorMessage);
    return json({
      success: false,
      error: isImapAuthError
        ? "IMAP login failed. Check the inbox email address and app password in Admin Panel."
        : `Failed to fetch emails: ${errorMessage}`,
    }, isImapAuthError ? 401 : 500);
  }
  };
  const res = await __run();
  return await maybeEncryptResponse(res, ctx);
});

