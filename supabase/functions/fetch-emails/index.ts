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

const FAST_SYNC_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const FAST_SYNC_MAX_UIDS = 25;
const FULL_SYNC_MAX_UIDS = 120;

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
  supabase: any, imapHost: string, imapPort: number, imapUser: string, imapPassword: string,
  accountLabel: string, cachedIds: Set<string>, filterSignInCodes: boolean, filterPasswordResets: boolean,
  latestCachedAt?: string | null,
): Promise<any[]> {
  const emails: any[] = [];
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; }, 15000);

  const client = new ImapFlow({
    host: imapHost, port: imapPort, secure: true,
    auth: { user: imapUser, pass: imapPassword }, logger: false,
  });

  try {
    await client.connect();
    console.log(`[${accountLabel}] IMAP connected to ${imapHost}`);
    const lock = await client.getMailboxLock("INBOX");

    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);

      const parsedLatestCachedAt = latestCachedAt ? new Date(latestCachedAt) : null;
      const hasRecentCache = !!parsedLatestCachedAt && !Number.isNaN(parsedLatestCachedAt.getTime());
      if (hasRecentCache && parsedLatestCachedAt) {
        const recentSince = new Date(parsedLatestCachedAt.getTime() - FAST_SYNC_LOOKBACK_MS);
        if (recentSince > since) {
          since.setTime(recentSince.getTime());
        }
      }

      let netflixUids: number[] = [];
      try {
        const searchResults = await client.search({ from: "info@account.netflix.com", since }, { uid: true });
        if (searchResults && searchResults.length > 0) {
          netflixUids = searchResults as number[];
        }
      } catch {
        const totalMessages = (client.mailbox as any)?.exists || 0;
        if (totalMessages > 0) {
          const fallbackWindow = hasRecentCache ? 150 : 500;
          const startSeq = Math.max(1, totalMessages - (fallbackWindow - 1));
          for await (const message of client.fetch(`${startSeq}:${totalMessages}`, { envelope: true, uid: true })) {
            if (timedOut) break;
            const fromAddr = message.envelope?.from?.[0]?.address?.toLowerCase() || "";
            if (fromAddr === "info@account.netflix.com") netflixUids.push(message.uid);
          }
        }
      }

      netflixUids.sort((a, b) => b - a);
      // Use account-scoped cache ID to avoid collisions across accounts
      const fetchLimit = hasRecentCache ? FAST_SYNC_MAX_UIDS : FULL_SYNC_MAX_UIDS;
      const uncachedUids = netflixUids
        .filter(uid => !cachedIds.has(`${accountLabel}:${uid}`) && !cachedIds.has(String(uid)))
        .slice(0, fetchLimit);

      for (const uid of uncachedUids) {
        if (timedOut) break;
        try {
          const fullMsg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!fullMsg?.source) continue;

          const envSubject = (fullMsg.envelope?.subject || "").toLowerCase();

          if (filterPasswordResets && PASSWORD_RESET_SUBJECTS.some(kw => envSubject.includes(kw))) continue;
          if (filterSignInCodes && SIGN_IN_CODE_SUBJECTS.some(kw => envSubject.includes(kw))) continue;

          const parsed = await simpleParser(fullMsg.source, { skipImageLinks: true, skipTextLinks: true });
          const bodyText = (parsed.text || "").trim();
          const otpMatch = bodyText.match(/\b\d{4,8}\b/);

          emails.push({
            id: `${accountLabel}:${uid}`, subject: parsed.subject || fullMsg.envelope?.subject || "",
            from: parsed.from?.text || "Netflix <info@account.netflix.com>",
            to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text) : undefined,
            date: parsed.date, otp: otpMatch ? otpMatch[0] : null,
            preview: bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText,
            html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
            account_label: accountLabel,
          });
        } catch (parseErr) {
          console.error(`[${accountLabel}] Parse error UID ${uid}:`, parseErr);
        }
      }
    } finally {
      lock.release();
    }
    try { await client.logout(); } catch {}
  } finally {
    clearTimeout(timeout);
  }
  return emails;
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
      const sessionToken = req.headers.get("x-session-token") || body.sessionToken;
      if (sessionToken) {
        const session = await verifySessionToken(sessionToken, SESSION_SECRET);
        if (session?.assignedAccounts && Array.isArray(session.assignedAccounts)) {
          accountFilter = session.assignedAccounts;
        }
      }

      let query = supabase.from("cached_emails").select("*").order("date", { ascending: false });

      if (accountFilter && accountFilter.length > 0) {
        // Include both exact label matches AND legacy null labels mapped as Primary
        query = query.in("account_label", accountFilter);
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

    // MODE: SYNC
    console.log("Sync mode: fetching from IMAP server(s)");

    const { data: cachedRows } = await supabase.from("cached_emails").select("id, account_label, date");
    const cachedIds = new Set((cachedRows || []).map((r: any) => String(r.id)));
    const latestCachedByAccount = new Map<string, string>();
    const hasLegacyNullLabels = (cachedRows || []).some((row: any) => row.account_label == null);

    for (const row of cachedRows || []) {
      const label = row.account_label || "Primary";
      if (!row.date) continue;
      const existing = latestCachedByAccount.get(label);
      if (!existing || new Date(row.date).getTime() > new Date(existing).getTime()) {
        latestCachedByAccount.set(label, row.date);
      }
    }

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

    if (accounts.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Inbox is not configured yet. Add IMAP email and app password in Admin Panel." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Backfill: normalize any legacy null account_labels to "Primary"
    if (hasLegacyNullLabels) {
      try {
        await supabase.from("cached_emails").update({ account_label: "Primary" }).is("account_label", null);
      } catch (e) {
        console.error("Backfill null labels error:", e);
      }
    }

    const allEmails: any[] = [];
    const accountErrors: Array<{ label: string; error: string }> = [];

    const accountResults = await Promise.all(accounts.map(async (acc) => {
      try {
        console.log(`Fetching from account: ${acc.label} (${acc.user})`);
        const emails = await fetchFromAccount(
          supabase,
          acc.host,
          acc.port,
          acc.user,
          acc.password,
          acc.label,
          cachedIds,
          filterSignInCodes,
          filterPasswordResets,
          latestCachedByAccount.get(acc.label) || null,
        );
        return { label: acc.label, emails, error: null as string | null };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Error fetching from ${acc.label}:`, errMsg);
        const isAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errMsg);
        return {
          label: acc.label,
          emails: [],
          error: isAuthError
            ? `IMAP login failed for "${acc.label}". Check email and app password.`
            : `Failed to connect to "${acc.label}": ${errMsg}`,
        };
      }
    }));

    for (const result of accountResults) {
      allEmails.push(...result.emails);
      if (result.error) {
        accountErrors.push({ label: result.label, error: result.error });
      }
    }

    if (accountErrors.length > 0 && accountErrors.length === accounts.length) {
      const combinedMsg = accountErrors.map(e => e.error).join(" | ");
      return new Response(
        JSON.stringify({ success: false, error: combinedMsg }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    allEmails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    if (allEmails.length > 0) {
      const rows = allEmails.map((e: any) => ({
        id: String(e.id), subject: e.subject, from_address: e.from, to_address: e.to || null,
        date: e.date, otp: e.otp || null, preview: e.preview || null, html: e.html || null,
        account_label: e.account_label || "Primary", cached_at: new Date().toISOString(),
      }));

      const { error: upsertErr } = await supabase.from("cached_emails").upsert(rows, { onConflict: "id" });
      if (upsertErr) console.error("Cache upsert error:", upsertErr);
    }

    if (accountErrors.length > 0) {
      return new Response(JSON.stringify({
        emails: allEmails,
        warnings: accountErrors.map(e => e.error),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(allEmails), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Email fetch error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isImapAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errorMessage);

    return new Response(
      JSON.stringify({
        success: false,
        error: isImapAuthError
          ? "IMAP login failed. Check the inbox email address and app password in Admin Panel."
          : "Failed to fetch emails.",
      }),
      {
        status: isImapAuthError ? 401 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
