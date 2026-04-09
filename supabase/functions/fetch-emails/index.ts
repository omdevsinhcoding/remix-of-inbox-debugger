import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.2.18";
import { simpleParser } from "npm:mailparser@3.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
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

const FULL_SYNC_MAX_UIDS = 50;
const PER_ACCOUNT_TIMEOUT_MS = 25000;
const STALE_DAYS = 60;

async function verifySessionToken(token: string, secret: string): Promise<Record<string, any> | null> {
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

async function deriveEncKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("imap-enc-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
  );
}

async function decryptValue(encrypted: string, secret: string): Promise<string> {
  if (!encrypted.startsWith("enc:")) return encrypted;
  const [, ivHex, ctHex] = encrypted.split(":");
  const key = await deriveEncKey(secret);
  const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

async function fetchFromAccount(
  imapHost: string, imapPort: number, imapUser: string, imapPassword: string,
  accountLabel: string, cachedIds: Set<string>,
): Promise<{ emails: any[]; fetched: number; skipped: number }> {
  const emails: any[] = [];
  let timedOut = false;
  let skipped = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const client = new ImapFlow({
    host: imapHost, port: imapPort, secure: true,
    auth: { user: imapUser, pass: imapPassword }, logger: false,
    socketTimeout: 10000,
    greetingTimeout: 5000,
  });

  try {
    await client.connect();
    console.log(`[${accountLabel}] IMAP connected to ${imapHost}`);
    const lock = await client.getMailboxLock("INBOX");

    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);

      let netflixUids: number[] = [];
      const searchTerms = ["netflix.com", "netflix"];
      for (const term of searchTerms) {
        if (netflixUids.length > 0) break;
        try {
          const searchResults = await client.search({ from: term, since }, { uid: true });
          if (searchResults && searchResults.length > 0) {
            netflixUids = searchResults as number[];
            console.log(`[${accountLabel}] IMAP search "${term}" found ${netflixUids.length} UIDs`);
          }
        } catch (searchErr) {
          console.log(`[${accountLabel}] IMAP search "${term}" failed:`, searchErr);
        }
      }

      // Fallback: scan recent emails
      if (netflixUids.length === 0) {
        console.log(`[${accountLabel}] Search returned 0, falling back to envelope scan`);
        const totalMessages = (client.mailbox as any)?.exists || 0;
        if (totalMessages > 0) {
          const startSeq = Math.max(1, totalMessages - 299);
          for await (const message of client.fetch(`${startSeq}:${totalMessages}`, { envelope: true, uid: true })) {
            if (timedOut) break;
            const fromAddr = message.envelope?.from?.[0]?.address?.toLowerCase() || "";
            const toAddr = message.envelope?.to?.[0]?.address?.toLowerCase() || "";
            const subject = (message.envelope?.subject || "").toLowerCase();
            if (fromAddr.includes("netflix") || toAddr.includes("netflix") || subject.includes("netflix")) {
              netflixUids.push(message.uid);
            }
          }
          console.log(`[${accountLabel}] Envelope scan found ${netflixUids.length} Netflix UIDs`);
        }
      }

      netflixUids.sort((a, b) => b - a);
      const uidsToFetch = netflixUids.slice(0, FULL_SYNC_MAX_UIDS);

      // Start timeout AFTER search completes (search alone can take 5-10s)
      timeout = setTimeout(() => { timedOut = true; }, PER_ACCOUNT_TIMEOUT_MS);

      // Determine uncached UIDs using plain UID format
      const uncachedUids: number[] = [];
      for (const uid of uidsToFetch) {
        const plainId = String(uid);
        const prefixedId = `${accountLabel}:${uid}`;
        if (cachedIds.has(plainId) || cachedIds.has(prefixedId)) {
          skipped++;
        } else {
          uncachedUids.push(uid);
        }
      }

      console.log(`[${accountLabel}] ${uncachedUids.length} uncached UIDs to fetch, ${skipped} already cached`);

      for (const uid of uncachedUids) {
        if (timedOut) {
          console.log(`[${accountLabel}] Timed out, stopping fetch`);
          break;
        }

        try {
          const fullMsg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!fullMsg?.source) continue;

          const parsed = await simpleParser(fullMsg.source, { skipImageLinks: true, skipTextLinks: true });
          const bodyText = (parsed.text || "").trim();
          const otpMatch = bodyText.match(/\b\d{4,8}\b/);

          // Use plain UID as ID to match existing DB format
          const stableId = String(uid);
          const messageId = parsed.messageId || null;

          emails.push({
            id: stableId,
            message_id: messageId,
            subject: parsed.subject || fullMsg.envelope?.subject || "",
            from: parsed.from?.text || "Netflix",
            to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text) : undefined,
            date: parsed.date, otp: otpMatch ? otpMatch[0] : null,
            preview: bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText,
            html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
            account_label: accountLabel,
          });
          console.log(`[${accountLabel}] Fetched UID ${uid}: ${parsed.subject?.substring(0, 50)}`);
        } catch (parseErr) {
          const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          console.error(`[${accountLabel}] Fetch error UID ${uid}: ${errMsg}`);
          // If TLS/connection error, stop trying more UIDs
          if (/eof|closed|reset|tls|socket/i.test(errMsg)) {
            console.log(`[${accountLabel}] Connection error, stopping further fetches`);
            break;
          }
        }
      }
    } finally {
      lock.release();
    }
    try { await client.logout(); } catch {}
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return { emails, fetched: emails.length, skipped };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const SESSION_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    let body: any = {};
    try { body = await req.json(); } catch {}
    const mode = body.mode || "sync";
    const source = body.source || "manual";

    // MODE: CRON_STATUS
    if (mode === "cron_status") {
      try {
        const { data, error } = await supabase.rpc("get_cron_status");
        if (error) {
          const { data: fallback } = await supabase.from("app_settings").select("value").eq("key", "cron_config").single();
          return new Response(JSON.stringify({
            active: fallback?.value?.active || false,
            interval: fallback?.value?.interval || 3,
            lastSync: null,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch {
        return new Response(JSON.stringify({ active: false, interval: 3, lastSync: null }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // MODE: CRON_TOGGLE
    if (mode === "cron_toggle") {
      const enabled = body.enabled === true;
      const interval = parseInt(body.interval) || 3;
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA";

      try {
        try {
          await supabase.rpc("unschedule_email_sync");
        } catch {}

        if (enabled) {
          const cronExpr = `*/${interval} * * * *`;
          const { error: schedErr } = await supabase.rpc("schedule_email_sync", {
            cron_expr: cronExpr,
            function_url: `${SUPABASE_URL}/functions/v1/fetch-emails`,
            auth_key: ANON_KEY,
          });
          if (schedErr) throw schedErr;
          console.log(`[cron] Scheduled email sync every ${interval} minutes`);
        } else {
          console.log("[cron] Disabled email sync cron");
        }

        await supabase.from("app_settings").upsert({
          key: "cron_config",
          value: { active: enabled, interval },
        }, { onConflict: "key" });

        return new Response(JSON.stringify({ success: true, active: enabled, interval }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[cron] Toggle error:", msg);
        return new Response(JSON.stringify({ success: false, error: msg }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    let filterSignInCodes = false;
    let filterPasswordResets = true;
    try {
      const { data: filterData } = await supabase
        .from("app_settings").select("value").eq("key", "email_filters").single();
      if (filterData?.value) {
        if (filterData.value.showSignInCodes === false) filterSignInCodes = true;
        if (filterData.value.showPasswordResets === true) filterPasswordResets = false;
      }
    } catch {}

    // MODE: CACHE
    if (mode === "cache") {
      let accountFilter: string[] | null = null;
      let isAdmin = false;
      const sessionToken = req.headers.get("x-session-token") || body.sessionToken;
      if (sessionToken) {
        const session = await verifySessionToken(sessionToken, SESSION_SECRET);
        if (session?.role === "admin") {
          isAdmin = true;
        }
        if (session?.assignedAccounts && Array.isArray(session.assignedAccounts)) {
          accountFilter = session.assignedAccounts;
        }
      }

      // If body has accountLabels override (from worker), use those
      if (body.accountLabels && Array.isArray(body.accountLabels) && body.accountLabels.length > 0) {
        accountFilter = body.accountLabels;
      }

      let query = supabase.from("cached_emails").select("*").order("date", { ascending: false }).limit(500);

      if (accountFilter && accountFilter.length > 0) {
        // Filter to assigned accounts
        query = query.in("account_label", accountFilter);
      } else if (!isAdmin) {
        // Non-admin with no assigned accounts — return empty
        return new Response(JSON.stringify([]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: cached, error: cacheErr } = await query;

      if (cacheErr) {
        return new Response(JSON.stringify({ error: "Database query failed: " + cacheErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let emails = (cached || []).map((e: any) => ({
        id: e.id, subject: e.subject, from: e.from_address, to: e.to_address,
        date: e.date, otp: e.otp, preview: e.preview, html: e.html, account_label: e.account_label,
      }));

      if (filterSignInCodes) {
        emails = emails.filter((e: any) => {
          const sub = (e.subject || "").toLowerCase();
          return !SIGN_IN_CODE_SUBJECTS.some(kw => sub.includes(kw));
        });
      }
      if (filterPasswordResets) {
        emails = emails.filter((e: any) => {
          const sub = (e.subject || "").toLowerCase();
          return !PASSWORD_RESET_SUBJECTS.some(kw => sub.includes(kw));
        });
      }

      return new Response(JSON.stringify(emails), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // MODE: UNFILTERED_COUNT
    if (mode === "unfiltered_count") {
      let accountFilter: string[] | null = null;
      const sessionToken = req.headers.get("x-session-token") || body.sessionToken;
      if (sessionToken) {
        const session = await verifySessionToken(sessionToken, SESSION_SECRET);
        if (session?.assignedAccounts && Array.isArray(session.assignedAccounts)) {
          accountFilter = session.assignedAccounts;
        }
      }
      let query = supabase.from("cached_emails").select("id", { count: "exact", head: true });
      if (accountFilter && accountFilter.length > 0) {
        query = query.in("account_label", accountFilter);
      }
      const { count, error: countErr } = await query;
      return new Response(JSON.stringify({ total: count || 0, error: countErr?.message || null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // MODE: SYNC
    console.log(`[sync] Starting IMAP sync (source: ${source})`);

    const { data: cachedRows } = await supabase.from("cached_emails").select("id, account_label, date");
    const cachedIds = new Set((cachedRows || []).map((r: any) => String(r.id)));
    const hasLegacyNullLabels = (cachedRows || []).some((row: any) => row.account_label == null);

    const accounts: Array<{ label: string; host: string; port: number; user: string; password: string }> = [];

    try {
      const { data: accountsData } = await supabase
        .from("app_settings").select("value").eq("key", "email_accounts").single();
      if (accountsData?.value && Array.isArray(accountsData.value) && accountsData.value.length > 0) {
        for (const acc of accountsData.value) {
          if (acc.user && acc.password) {
            const decryptedPass = await decryptValue(acc.password, SESSION_SECRET);
            accounts.push({
              label: acc.label || acc.user,
              host: acc.host || "imap.gmail.com",
              port: parseInt(acc.port) || 993,
              user: acc.user,
              password: decryptedPass,
            });
          }
        }
      }
    } catch {}

    let primaryHost = "", primaryPort = 993, primaryUser = "", primaryPassword = "";
    try {
      const { data } = await supabase.from("app_settings").select("value").eq("key", "config").single();
      if (data?.value) {
        const config = data.value as any;
        if (config.IMAP_HOST) primaryHost = config.IMAP_HOST;
        if (config.IMAP_PORT) primaryPort = parseInt(config.IMAP_PORT) || 993;
        if (config.IMAP_USER) primaryUser = config.IMAP_USER;
        if (config.IMAP_PASSWORD) primaryPassword = config.IMAP_PASSWORD;
      }
    } catch {}

    if (!primaryHost) primaryHost = Deno.env.get("IMAP_HOST") || "imap.gmail.com";
    if (!primaryUser) primaryUser = Deno.env.get("IMAP_USER") || "";
    if (!primaryPassword) primaryPassword = Deno.env.get("IMAP_PASSWORD") || "";
    const envPort = Deno.env.get("IMAP_PORT");
    if (primaryPort === 993 && envPort) primaryPort = parseInt(envPort) || 993;

    if (primaryUser && primaryPassword) {
      const alreadyAdded = accounts.some(a => a.user === primaryUser);
      if (!alreadyAdded) {
        accounts.unshift({ label: "Primary", host: primaryHost, port: primaryPort, user: primaryUser, password: primaryPassword });
      }
    }

    // Filter to specific accounts if requested (per-account worker routing)
    if (body.accountLabels && Array.isArray(body.accountLabels) && body.accountLabels.length > 0) {
      const requestedLabels: string[] = body.accountLabels;
      accounts = accounts.filter(a => requestedLabels.includes(a.label));
      console.log(`[sync] Filtered to ${accounts.length} accounts: ${requestedLabels.join(", ")}`);
    }

    if (accounts.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Inbox not configured. Add IMAP email in Admin Panel." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Backfill legacy null labels
    if (hasLegacyNullLabels) {
      try {
        await supabase.from("cached_emails").update({ account_label: "Primary" }).is("account_label", null);
        console.log("[sync] Backfilled null account_labels to Primary");
      } catch (e) {
        console.error("[sync] Backfill error:", e);
      }
    }

    const allEmails: any[] = [];
    const accountErrors: Array<{ label: string; error: string }> = [];
    const syncStats: Record<string, { fetched: number; skipped: number; error?: string }> = {};

    // Fetch accounts sequentially to reduce connection pressure
    for (const acc of accounts) {
      try {
        console.log(`[sync] Fetching ${acc.label} (${acc.user})`);
        const result = await fetchFromAccount(acc.host, acc.port, acc.user, acc.password, acc.label, cachedIds);
        syncStats[acc.label] = { fetched: result.fetched, skipped: result.skipped };
        allEmails.push(...result.emails);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[sync] Error ${acc.label}:`, errMsg);
        const isAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errMsg);
        const errorText = isAuthError
          ? `IMAP login failed for "${acc.label}". Check email and app password.`
          : `Failed to connect to "${acc.label}": ${errMsg}`;
        syncStats[acc.label] = { fetched: 0, skipped: 0, error: errorText };
        accountErrors.push({ label: acc.label, error: errorText });
      }
    }

    if (accountErrors.length > 0 && accountErrors.length === accounts.length) {
      const combinedMsg = accountErrors.map(e => e.error).join(" | ");
      console.error("[sync] All accounts failed:", combinedMsg);
      return new Response(
        JSON.stringify({ success: false, error: combinedMsg, stats: syncStats }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    allEmails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    let inserted = 0;
    if (allEmails.length > 0) {
      const rows = allEmails.map((e: any) => ({
        id: String(e.id), subject: e.subject, from_address: e.from, to_address: e.to || null,
        date: e.date, otp: e.otp || null, preview: e.preview || null, html: e.html || null,
        account_label: e.account_label || "Primary", cached_at: new Date().toISOString(),
        message_id: e.message_id || null,
      }));

      const { error: upsertErr } = await supabase.from("cached_emails").upsert(rows, { onConflict: "id" });
      if (upsertErr) {
        console.error("[sync] Cache upsert error:", upsertErr);
      } else {
        inserted = rows.length;
        console.log(`[sync] Upserted ${inserted} emails`);
      }
    }

    // Cleanup stale emails
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - STALE_DAYS);
      const { error: deleteErr, count } = await supabase
        .from("cached_emails")
        .delete({ count: "exact" })
        .lt("date", cutoff.toISOString());
      if (!deleteErr && count && count > 0) {
        console.log(`[sync] Cleaned up ${count} stale emails older than ${STALE_DAYS} days`);
      }
    } catch (e) {
      console.error("[sync] Stale cleanup error:", e);
    }

    const response: any = {
      success: true,
      emails: allEmails,
      stats: syncStats,
      totalFetched: allEmails.length,
      inserted,
      duplicatesSkipped: Object.values(syncStats).reduce((s, v) => s + v.skipped, 0),
    };
    if (accountErrors.length > 0) {
      response.warnings = accountErrors.map(e => e.error);
    }

    console.log(`[sync] Complete: ${allEmails.length} new, ${response.duplicatesSkipped} skipped`);

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[sync] Fatal error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isImapAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errorMessage);

    return new Response(
      JSON.stringify({
        success: false,
        error: isImapAuthError
          ? "IMAP login failed. Check the inbox email address and app password in Admin Panel."
          : `Failed to fetch emails: ${errorMessage}`,
      }),
      {
        status: isImapAuthError ? 401 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
