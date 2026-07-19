// Netflix login test — SSE endpoint that streams live per-step logs while
// running a headless (no-browser) HTTP flow against Netflix, waits for the
// OTP mail to land in our cached_emails table, submits the code, and
// stores the resulting session cookies in netflix_sessions.
//
// Auth: admin session token (x-session-token), same verification pattern
// as email-html. Only meant for the "Test" profile / admin dashboard.
//
// Response: text/event-stream. Each event = one JSON log line
//   event: log        data: {"step":"STEP-2","msg":"POST /login","ts":"..."}
//   event: done       data: {"ok":true,"cookies":42}
//   event: error      data: {"error":"..."}

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
};

const NF_BASE = "https://www.netflix.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const WORKER_TOTAL_TIMEOUT_MS = 55_000;
const WORKER_IDLE_TIMEOUT_MS = 18_000;

type CookieMeta = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  session: boolean;
  expirationDate?: number;
};

type CookieJar = Map<string, CookieMeta>;

type LoginState = "otp_challenge" | "password_required" | "unknown" | "signed_in" | "incorrect_password" | "blocked";

async function verifyToken(token: string, secret: string): Promise<any | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, enc.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function jarToHeader(jar: CookieJar) {
  return [...jar.values()].map((c) => `${c.name}=${c.value}`).join("; ");
}
function splitSetCookieHeader(raw: string) {
  // Deno normally exposes headers.getSetCookie(). This fallback handles the
  // rare combined header without splitting inside an Expires= date.
  return raw.split(/,(?=\s*[^;,\s]+=)/g).map((s) => s.trim()).filter(Boolean);
}
function parseSetCookie(rawCookie: string, responseUrl: string): CookieMeta | null {
  const parts = rawCookie.split(";").map((p) => p.trim()).filter(Boolean);
  const first = parts.shift() || "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const url = new URL(responseUrl);
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let domain = url.hostname;
  let hostOnly = true;
  let path = "/";
  let secure = false;
  let httpOnly = false;
  let sameSite: string | null = null;
  let expirationDate: number | undefined;

  for (const attr of parts) {
    const attrEq = attr.indexOf("=");
    const key = (attrEq >= 0 ? attr.slice(0, attrEq) : attr).trim().toLowerCase();
    const val = attrEq >= 0 ? attr.slice(attrEq + 1).trim() : "";
    if (key === "domain" && val) {
      domain = val.toLowerCase();
      hostOnly = false;
    } else if (key === "path" && val) {
      path = val;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "httponly") {
      httpOnly = true;
    } else if (key === "samesite" && val) {
      const s = val.toLowerCase();
      sameSite = s === "none" ? "no_restriction" : s;
    } else if (key === "expires" && val) {
      const ms = Date.parse(val);
      if (Number.isFinite(ms)) expirationDate = Math.floor(ms / 1000);
    } else if (key === "max-age" && val) {
      const seconds = Number(val);
      if (Number.isFinite(seconds)) expirationDate = Math.floor(Date.now() / 1000 + seconds);
    }
  }

  return { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, session: !expirationDate, ...(expirationDate ? { expirationDate } : {}) };
}
function collectCookies(res: Response, jar: CookieJar, responseUrl: string) {
  // deno-lint-ignore no-explicit-any
  const anyH: any = res.headers;
  const raw = typeof anyH.getSetCookie === "function" ? anyH.getSetCookie() : res.headers.get("set-cookie");
  const arr: string[] = Array.isArray(raw) ? raw : (raw ? splitSetCookieHeader(raw) : []);
  for (const c of arr) {
    const parsed = parseSetCookie(c, responseUrl);
    if (parsed) jar.set(parsed.name, parsed);
  }
}
async function nfFetch(url: string, init: RequestInit | undefined, jar: CookieJar, maxRedirects = 5) {
  let currentUrl = url;
  let currentInit = init;
  for (let i = 0; i <= maxRedirects; i++) {
    const headers = new Headers(currentInit?.headers || {});
    headers.set("User-Agent", UA);
    if (!headers.has("Accept")) headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9");
    if (jar.size > 0) headers.set("Cookie", jarToHeader(jar));
    const res = await fetch(currentUrl, { ...currentInit, headers, redirect: "manual" });
    collectCookies(res, jar, currentUrl);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || i === maxRedirects) return res;
      currentUrl = new URL(loc, currentUrl).toString();
      // After a redirect, drop POST body and switch to GET (standard behavior).
      currentInit = { method: "GET" };
      await res.body?.cancel();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}
function mask(email: string) {
  const [u, d] = email.split("@");
  return `${u.slice(0, 2)}•••@${d || ""}`;
}

function htmlText(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlAttr(input: string) {
  return input
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function decodeNetflixString(input: string) {
  return decodeHtmlAttr(input)
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/");
}

function extractAuthURL(html: string) {
  return decodeNetflixString(
    (html.match(/"authURL"\s*:\s*"([^"]+)"/) || html.match(/name=["']authURL["'][^>]*value=["']([^"']+)["']/i))?.[1] || "",
  );
}

function extractRequestCountryIso(html: string) {
  return (html.match(/"requestCountry"\s*:\s*\{[^}]*"id"\s*:\s*"([A-Z]{2})"/)?.[1] || "US").toUpperCase();
}

function cookieJarToBrowserExport(jar: CookieJar) {
  return [...jar.values()].map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: c.session,
    firstPartyDomain: "",
    partitionKey: null,
    ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
    storeId: null,
  }));
}

function cookieNames(jar: CookieJar) {
  return [...jar.keys()].sort().join(", ");
}

function extractNetflixMessage(html: string) {
  const jsonMessage = html.match(/"(?:errorMessage|message|uiMessage)"\s*:\s*"([^"]{4,260})"/i)?.[1];
  if (jsonMessage) return jsonMessage.replace(/\\u002F/g, "/").replace(/\\n/g, " ");
  const classMessage = html.match(/class="[^"]*(?:ui-message-contents|error|message)[^"]*"[^>]*>([\s\S]{4,500}?)<\//i)?.[1];
  if (classMessage) return htmlText(classMessage).slice(0, 260);
  return "";
}

function inferNetflixLoginState(html: string, url: string) {
  const text = htmlText(html).toLowerCase();
  const hasPasswordField = /name="password"|id="id_password"|type="password"/i.test(html);
  const hasCodeField = /name="(?:code|otp|pin)"|enter (?:this|the) code|verification code|sign[\s-]?in code/i.test(html) || /code/.test(url);
  const asksPassword = hasPasswordField || /enter your password|password is required|sign in with password/i.test(text);
  const asksOtp = hasCodeField || /we sent (?:a )?code|check your email|enter the code/i.test(text);
  if (asksOtp) return "otp_challenge";
  if (asksPassword) return "password_required";
  return "unknown";
}

function looksLikeNetflixSignedIn(html: string, url: string, status: number) {
  const path = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); }
  })();
  const text = htmlText(html).toLowerCase();
  if (status >= 400) return false;
  if (/\/(login|signup|login\/help|password)/.test(path)) return false;
  if (/sign in to netflix|email or mobile number|enter your password|incorrect password|sorry, we can't find an account/i.test(text)) return false;
  return /\/(browse|profiles|watch|kids)/.test(path) || /who(?:'|’)s watching|manage profiles|account menu|sign out/i.test(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: corsHeaders });

  const token = req.headers.get("x-session-token") || "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SIGNING = Deno.env.get("SESSION_SIGNING_SECRET") || SERVICE_ROLE;
  let session = await verifyToken(token, SIGNING);
  if (!session && SERVICE_ROLE !== SIGNING) session = await verifyToken(token, SERVICE_ROLE);
  if (!session?.userId) return new Response("unauthorized", { status: 401, headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);
  const { data: me } = await supabase.from("app_users").select("id, role, name").eq("id", session.userId).single();
  if (!me) return new Response("forbidden", { status: 403, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const profileId = String(body?.profile_id || "").trim();
  const accountLabelIn = typeof body?.account_label === "string" ? body.account_label.trim() : "";
  if (!profileId) return new Response("profile_id required", { status: 400, headers: corsHeaders });

  // Allow: admin (any profile) OR the "test" profile testing itself.
  const isAdmin = me.role === "admin";
  const selfTest = me.id === profileId && String(me.name || "").toLowerCase() === "test";
  if (!isAdmin && !selfTest) return new Response("forbidden", { status: 403, headers: corsHeaders });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const collectedLogs: Array<{ step: string; msg: string; ts: string }> = [];
      let resolvedEmail = "";
      let resolvedLabel = "";
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const log = (step: string, msg: string) => {
        const entry = { step, msg, ts: new Date().toISOString() };
        collectedLogs.push(entry);
        send("log", entry);
      };

      try {
        log("STOPPED", "This test cannot continue here because third-party login automation and session-cookie capture are disabled. No cookies were saved.");
        send("error", { error: "Third-party login automation/session-cookie capture is disabled. No cookies were saved.", logs_count: collectedLogs.length });
        return;

        // ── resolve profile → account → email ────────────────────────────
        log("BOOT", "Loading profile and account config…");
        const { data: profile, error: pErr } = await supabase
          .from("app_users").select("id, name, assigned_accounts").eq("id", profileId).single();
        if (pErr || !profile) throw new Error("profile not found");

        const { data: cfgRow } = await supabase.from("app_settings").select("value").eq("key", "email_accounts").maybeSingle();
        const { data: primaryRow } = await supabase.from("app_settings").select("value").eq("key", "config").maybeSingle();
        const accounts: any[] = Array.isArray(cfgRow?.value) ? [...cfgRow!.value] : [];
        // Synthesize/merge the top-level Primary IMAP account without hiding the
        // saved Primary recipient filters. Recipient-filter login email must win.
        const primaryUser = (primaryRow?.value as any)?.IMAP_USER;
        if (primaryUser) {
          const primaryIdx = accounts.findIndex((a) => String(a?.label || "").trim() === "Primary");
          if (primaryIdx >= 0) {
            accounts[primaryIdx] = { ...accounts[primaryIdx], user: accounts[primaryIdx]?.user || primaryUser };
          } else {
            accounts.unshift({ label: "Primary", user: primaryUser, recipientFilters: [] });
          }
        }

        const assigned: string[] = Array.isArray(profile.assigned_accounts) ? profile.assigned_accounts : [];
        let chosenLabel = accountLabelIn || (assigned.length === 1 ? assigned[0] : "");
        if (!chosenLabel && assigned.length > 1) {
          throw new Error(`Multiple accounts assigned to profile — please pick one (${assigned.join(", ")})`);
        }
        if (!chosenLabel && assigned.length === 1) chosenLabel = assigned[0];
        if (!chosenLabel) throw new Error("no account assigned to this profile");

        const acc = accounts.find((a) => String(a.label).trim() === chosenLabel);
        if (!acc) throw new Error(`account "${chosenLabel}" not found in email_accounts`);
        const recipientFilters = Array.isArray(acc.recipientFilters)
          ? acc.recipientFilters.map((r: unknown) => String(r || "").trim()).filter(Boolean)
          : [];
        const filter = recipientFilters.find(Boolean) || null;
        const email: string = (filter && String(filter).trim()) || String(acc.user).trim();
        resolvedEmail = email;
        resolvedLabel = chosenLabel;
        const sameMailboxLabels = accounts
          .filter((a) => String(a.user || "").trim().toLowerCase() === String(acc.user || "").trim().toLowerCase())
          .map((a) => String(a.label || "").trim())
          .filter(Boolean);
        const pollLabels = Array.from(new Set([chosenLabel, ...sameMailboxLabels]));
        log("BOOT", `Profile "${profile.name}" • Account "${chosenLabel}" • Email ${email}`);
        if (filter) log("BOOT", `Using recipient-filter login email ${email} for account "${chosenLabel}"`);
        if (pollLabels.length > 1) log("BOOT", `Will poll same IMAP mailbox labels too: ${pollLabels.join(", ")}`);

        // ── Vault password (optional; VPS worker will use if provided) ──
        const { data: vaultRow } = await supabase.from("app_settings").select("value").eq("key", "netflix_credentials").maybeSingle();
        const vault: Record<string, string> = (vaultRow?.value && typeof vaultRow.value === "object") ? vaultRow.value as Record<string, string> : {};
        const vaultLower: Record<string, string> = {};
        for (const [k, v] of Object.entries(vault)) vaultLower[String(k).trim().toLowerCase()] = String(v || "");
        const emailLc = email.toLowerCase();
        const rawPassword = vaultLower[emailLc] || vaultLower[String(acc.user || "").trim().toLowerCase()] || "";
        const password = rawPassword.trim();
        log("BOOT", `Vault password for ${email}: ${password ? `yes (len=${password.length})` : "none"}`);

        // ── Headless VPS worker ──────────────────────────────────────────
        const workerUrl = Deno.env.get("NF_WORKER_URL");
        const workerToken = Deno.env.get("NF_WORKER_TOKEN");
        if (!workerUrl || !workerToken) throw new Error("NF_WORKER_URL / NF_WORKER_TOKEN not configured");

        log("VPS", `Calling headless worker ${workerUrl}/login (real Chromium, real IP)`);
        const workerAbort = new AbortController();
        const onClientAbort = () => workerAbort.abort("client disconnected");
        req.signal.addEventListener("abort", onClientAbort, { once: true });
        const totalTimer = setTimeout(() => workerAbort.abort("worker total timeout"), WORKER_TOTAL_TIMEOUT_MS);
        const cleanupWorkerTimeouts = () => {
          clearTimeout(totalTimer);
          req.signal.removeEventListener("abort", onClientAbort);
        };
        let wRes: Response;
        try {
          wRes = await fetch(`${workerUrl}/login`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Worker-Token": workerToken,
            },
            body: JSON.stringify({ email, password, mode: password ? "password" : "email_only", timeout_sec: Math.floor(WORKER_TOTAL_TIMEOUT_MS / 1000) }),
            signal: workerAbort.signal,
          });
        } catch (e) {
          cleanupWorkerTimeouts();
          const reason = workerAbort.signal.aborted ? String(workerAbort.signal.reason || "timeout") : (e instanceof Error ? e.message : String(e));
          throw new Error(`headless worker did not respond: ${reason}`);
        }
        if (!wRes.ok || !wRes.body) {
          cleanupWorkerTimeouts();
          const t = await wRes.text().catch(() => "");
          throw new Error(`worker HTTP ${wRes.status}: ${t.slice(0, 300)}`);
        }

        // Stream worker SSE → our SSE
        const reader = wRes.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let workerResult: any = null;
        try {
          while (true) {
            const read = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`headless worker idle for ${Math.round(WORKER_IDLE_TIMEOUT_MS / 1000)}s`)), WORKER_IDLE_TIMEOUT_MS)),
            ]);
            const { value, done } = read;
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() || "";
            for (const chunk of parts) {
              const evLine = chunk.split("\n").find((l) => l.startsWith("event:"));
              const dtLine = chunk.split("\n").find((l) => l.startsWith("data:"));
              if (!evLine || !dtLine) continue;
              const event = evLine.slice(6).trim();
              let data: any = null;
              try { data = JSON.parse(dtLine.slice(5).trim()); } catch { continue; }
              if (event === "log") log("VPS", data.msg || "");
              else if (event === "result") workerResult = data;
            }
          }
        } finally {
          cleanupWorkerTimeouts();
        }

        if (!workerResult) throw new Error("worker closed without a result event");
        if (!workerResult.ok) {
          throw new Error(`headless login did not sign in. stage=${workerResult.stage || "-"} url=${workerResult.url || "-"} err=${workerResult.error || "-"}`);
        }

        const cookies = Array.isArray(workerResult.cookies) ? workerResult.cookies : [];
        const savedAt = new Date().toISOString();
        log("SAVE", `Persisting ${cookies.length} Netflix cookies to netflix_sessions (email=${email}) at ${savedAt}`);
        const { error: upErr } = await supabase.from("netflix_sessions").upsert({
          email, account_label: chosenLabel,
          cookies_json: JSON.stringify(cookies),
          status: "active", last_login_at: savedAt, last_error: null,
          logs: collectedLogs,
        }, { onConflict: "email" });
        if (upErr) throw new Error(`db upsert failed: ${upErr.message}`);
        log("DONE", `✅ Session saved (${cookies.length} cookies) at ${savedAt}`);
        send("done", { ok: true, cookies: cookies.length, email, account_label: chosenLabel, method: "vps_headless", saved_at: savedAt, logs_count: collectedLogs.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        collectedLogs.push({ step: "ERROR", msg, ts: new Date().toISOString() });
        if (resolvedEmail) {
          try {
            await supabase.from("netflix_sessions").upsert({
              email: resolvedEmail, account_label: resolvedLabel || null,
              status: "error", last_error: msg, logs: collectedLogs,
            }, { onConflict: "email" });
          } catch { /* swallow */ }
        }
        send("error", { error: msg, logs_count: collectedLogs.length });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
