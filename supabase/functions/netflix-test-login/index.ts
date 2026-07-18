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

function hiddenInputsToForm(html: string) {
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/\bname=["']([^"']+)["']/i)?.[1] || "").trim();
    if (!name) continue;
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] || "";
    form.set(name, decodeHtmlAttr(value));
  }
  return form;
}

function extractPasswordFormAction(html: string, fallbackUrl: string) {
  for (const m of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const formHtml = m[0];
    if (!/type=["']password["']|name=["']password["']/i.test(formHtml)) continue;
    const action = formHtml.match(/\baction=["']([^"']+)["']/i)?.[1];
    if (action) return new URL(decodeHtmlAttr(action), fallbackUrl).toString();
  }
  return fallbackUrl;
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

async function secretFingerprint(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
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

type MoneyballSubmitResult = {
  ok: boolean;
  status: number;
  state: "signed_in" | "otp_challenge" | "password_required" | "incorrect_password" | "blocked" | "unknown";
  message: string;
  authURL: string;
  rawBytes: number;
};

function moneyballField(value: unknown) {
  return { value };
}

function readMoneyballField(fields: Record<string, any>, key: string) {
  const field = fields?.[key];
  return typeof field === "object" && field && "value" in field ? field.value : undefined;
}

function inferMoneyballState(nextValue: any): { state: MoneyballSubmitResult["state"]; message: string; authURL: string } {
  const result = nextValue?.result || {};
  const fields = result?.fields || {};
  const userContext = nextValue?.userContext || {};
  const authURL = String(userContext?.authURL || "");
  const errorCode = String(readMoneyballField(fields, "errorCode") || "").toLowerCase();
  const mode = String(result?.mode || "").toLowerCase();
  const fieldKeys = Object.keys(fields);

  if (String(userContext?.membershipStatus || "").toUpperCase() === "CURRENT_MEMBER" || userContext?.userGuid || userContext?.guid) {
    return { state: "signed_in", message: "Moneyball returned CURRENT_MEMBER user context", authURL };
  }
  if (errorCode.includes("incorrect_password") || errorCode.includes("invalid_password")) {
    return { state: "incorrect_password", message: errorCode, authURL };
  }
  if (errorCode.includes("captcha") || errorCode.includes("recaptcha") || Boolean(readMoneyballField(fields, "recaptchaError"))) {
    return { state: "blocked", message: errorCode || "Netflix requested reCAPTCHA/risk validation", authURL };
  }
  if (/otp|code/.test(mode) || fieldKeys.some((k) => /otp|code/i.test(k))) {
    return { state: "otp_challenge", message: `mode=${result?.mode || "-"}`, authURL };
  }
  if (fields.password || fields.loginAction) {
    return { state: "password_required", message: errorCode || `mode=${result?.mode || "login"}`, authURL };
  }
  return { state: "unknown", message: `mode=${result?.mode || "-"} fields=${fieldKeys.slice(0, 12).join(",")}`, authURL };
}

async function submitMoneyballPassword(params: {
  jar: CookieJar;
  email: string;
  password: string;
  authURL: string;
  referer: string;
  countryIso: string;
}): Promise<MoneyballSubmitResult> {
  const { jar, email, password, authURL, referer, countryIso } = params;
  const callPath = JSON.stringify(["aui", "moneyball", "next"]);
  const endpoint = `${NF_BASE}/api/aui/pathEvaluator/web/%5E2.0.0?method=call&callPath=${encodeURIComponent(callPath)}&falcor_server=0.1.0`;
  const param = JSON.stringify({
    flow: "websiteSignUp",
    mode: "login",
    action: "loginAction",
    fields: {
      rememberMe: moneyballField(true),
      nextPage: moneyballField(""),
      userLoginId: moneyballField(email),
      password: moneyballField(password),
      countryCode: moneyballField(""),
      countryIsoCode: moneyballField(countryIso),
      recaptchaResponseToken: moneyballField(""),
      recaptchaError: moneyballField(""),
      recaptchaResponseTime: moneyballField(0),
    },
  });
  const body = new URLSearchParams({ param, authURL });
  const res = await nfFetch(endpoint, {
    method: "POST",
    body,
    headers: {
      "Accept": "application/json, text/javascript, */*",
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": referer,
      "Origin": NF_BASE,
      "X-Netflix.request.routing": JSON.stringify({ path: "/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator", control_tag: "auinqweb" }),
    },
  }, jar, 0);
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    const next = parsed?.jsonGraph?.aui?.moneyball?.next;
    if (next?.$type === "error") {
      const msg = String(next?.value?.message || next?.value?.name || "Moneyball error");
      return { ok: false, status: res.status, state: res.status === 401 ? "blocked" : "unknown", message: msg, authURL, rawBytes: text.length };
    }
    const inferred = inferMoneyballState(next?.value);
    return { ok: res.ok, status: res.status, ...inferred, authURL: inferred.authURL || authURL, rawBytes: text.length };
  } catch {
    return { ok: res.ok, status: res.status, state: "unknown", message: text.slice(0, 220).replace(/\s+/g, " "), authURL, rawBytes: text.length };
  }
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
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const log = (step: string, msg: string) => send("log", { step, msg, ts: new Date().toISOString() });

      try {
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
        const sameMailboxLabels = accounts
          .filter((a) => String(a.user || "").trim().toLowerCase() === String(acc.user || "").trim().toLowerCase())
          .map((a) => String(a.label || "").trim())
          .filter(Boolean);
        const pollLabels = Array.from(new Set([chosenLabel, ...sameMailboxLabels]));
        log("BOOT", `Profile "${profile.name}" • Account "${chosenLabel}" • Email ${email}`);
        if (filter) log("BOOT", `Using recipient-filter login email ${email} for account "${chosenLabel}"`);
        if (pollLabels.length > 1) log("BOOT", `Will poll same IMAP mailbox labels too: ${pollLabels.join(", ")}`);

        // ── load optional stored Netflix password for this email ────────
        // Admins configure these on the separate TV Auto-Login → Netflix Vault
        // page. When Netflix asks for a password (no OTP), we submit it
        // automatically instead of failing.
        const { data: credRow } = await supabase
          .from("app_settings").select("value").eq("key", "netflix_credentials").maybeSingle();
        const credMapRaw: Record<string, string> = (credRow?.value && typeof credRow.value === "object" && !Array.isArray(credRow.value))
          ? credRow.value as Record<string, string> : {};
        const credMap: Record<string, string> = {};
        for (const [k, v] of Object.entries(credMapRaw)) {
          const normalizedKey = String(k || "").trim().toLowerCase();
          if (normalizedKey) credMap[normalizedKey] = String(v || "");
        }
        const linkedEmails = new Set<string>();
        linkedEmails.add(email.toLowerCase());
        if (acc.user) linkedEmails.add(String(acc.user).trim().toLowerCase());
        for (const r of recipientFilters) linkedEmails.add(r.toLowerCase());
        for (const a of accounts) {
          if (String(a.user || "").trim().toLowerCase() !== String(acc.user || "").trim().toLowerCase()) continue;
          if (a.user) linkedEmails.add(String(a.user).trim().toLowerCase());
          for (const r of (Array.isArray(a.recipientFilters) ? a.recipientFilters : [])) {
            const val = String(r || "").trim().toLowerCase();
            if (val) linkedEmails.add(val);
          }
        }
        const linkedCandidates = [...linkedEmails];
        const checkedVaultRows: string[] = [];
        for (const candidate of linkedCandidates) {
          const raw = typeof credMap[candidate] === "string" ? credMap[candidate] : "";
          checkedVaultRows.push(`${candidate}:${raw ? `${raw.length}c#${await secretFingerprint(raw)}` : "empty"}`);
        }
        const credentialEmail = linkedCandidates.find((candidate) => typeof credMap[candidate] === "string" && String(credMap[candidate]).length > 0) || "";
        const storedPasswordRaw = String(credentialEmail ? credMap[credentialEmail] : "");
        const storedPassword = storedPasswordRaw.trim();
        const selectedKey = email.toLowerCase();
        log("BOOT", `Vault keys checked → ${checkedVaultRows.join(" | ") || "none"}`);
        log("BOOT", `Netflix password on file for ${email}: ${storedPassword ? `yes (${storedPasswordRaw.length} chars, sha256:${await secretFingerprint(storedPasswordRaw)}, matched ${credentialEmail === selectedKey ? "selected email" : credentialEmail}${storedPasswordRaw !== storedPassword ? ", trimmed before submit" : ""})` : `no (checked ${linkedEmails.size} linked email key${linkedEmails.size === 1 ? "" : "s"})`}`);

        // ── Netflix flow ─────────────────────────────────────────────────
        const jar: CookieJar = new Map();
        const triggerTs = new Date().toISOString();

        log("STEP-1", "GET https://www.netflix.com/login");
        const loginPage = await nfFetch(`${NF_BASE}/login`, {}, jar);
        const html = await loginPage.text();
        const authURL = extractAuthURL(html);
        const countryIso = extractRequestCountryIso(html);
        log("STEP-1", `finalUrl=${loginPage.url}  status=${loginPage.status}  bytes=${html.length}  cookies=${jar.size}  authURL=${authURL ? "ok" : "MISSING"}  country=${countryIso}`);
        log("STEP-1", `cookie names: ${cookieNames(jar) || "none"}`);
        if (!authURL) {
          const snippet = html.slice(0, 300).replace(/\s+/g, " ");
          throw new Error(`Netflix did not return authURL. First 300 chars: ${snippet}`);
        }

        const persistSession = async (method: "password" | "otp") => {
          log("STEP-5", "Verifying Netflix session with /browse before saving…");
          const verify = await nfFetch(`${NF_BASE}/browse`, {
            method: "GET",
            headers: { "Referer": NF_BASE },
          }, jar);
          const verifyBody = await verify.text().catch(() => "");
          const verified = looksLikeNetflixSignedIn(verifyBody, verify.url || "", verify.status);
          log("STEP-5", `verify status=${verify.status} finalUrl=${verify.url} bytes=${verifyBody.length} validSession=${verified ? "yes" : "no"}`);
          if (!verified) {
            const preview = htmlText(verifyBody).slice(0, 180);
            throw new Error(`Netflix cookies are not a real signed-in session; not saved. Verify URL=${verify.url || "-"}${preview ? ` preview="${preview}"` : ""}`);
          }

          const required = ["NetflixId", "SecureNetflixId", "gsid"];
          const missing = required.filter((name) => !jar.has(name));
          if (missing.length) {
            throw new Error(`Netflix session verified but required real-session cookie(s) missing: ${missing.join(", ")}. Cookies seen: ${cookieNames(jar) || "none"}`);
          }

          log("STEP-5", `Storing verified browser-cookie export in netflix_sessions. Cookies: ${cookieNames(jar)}`);
          const cookies = JSON.stringify(cookieJarToBrowserExport(jar));
          const { error: upErr } = await supabase.from("netflix_sessions").upsert({
            email, account_label: chosenLabel, cookies_json: cookies,
            status: "active", last_login_at: new Date().toISOString(), last_error: null,
          }, { onConflict: "email" });
          if (upErr) throw new Error(`db upsert failed: ${upErr.message}`);
          log("DONE", `Session persisted (${jar.size} cookies) via ${method} login`);
          send("done", { ok: true, cookies: jar.size, email, account_label: chosenLabel, method });
        };

        const useDirectPassword = storedPassword.length > 0;
        let subBody = "";
        let netflixMessage = "";
        let loginState: "otp_challenge" | "password_required" | "unknown" | "signed_in" | "incorrect_password" | "blocked" = "unknown";
        let finalLoginUrl = loginPage.url || `${NF_BASE}/login`;

        if (useDirectPassword) {
          log("STEP-2", `POST Moneyball /api/aui/pathEvaluator  userLoginId="${email}"  password=(from admin panel)`);
          const mb = await submitMoneyballPassword({ jar, email, password: storedPassword, authURL, referer: loginPage.url || `${NF_BASE}/login`, countryIso });
          loginState = mb.state;
          netflixMessage = mb.message;
          log("STEP-2", `status=${mb.status}  bytes=${mb.rawBytes}  state=${mb.state}  cookies=${jar.size}`);
          log("STEP-2", `cookie names: ${cookieNames(jar) || "none"}`);
          if (mb.message) log("STEP-2", `Netflix API said: ${mb.message.slice(0, 220)}`);
          if (mb.authURL && mb.authURL !== authURL) log("STEP-2", "Netflix returned a refreshed authURL for any next step");
        } else {
          log("STEP-2", `POST /login  userLoginId="${email}"  password=(empty — expecting OTP flow)`);
          const form = new URLSearchParams({
            userLoginId: email, password: "", rememberMe: "true",
            flow: "websiteSignUp", mode: "login", action: "loginAction",
            withFields: "userLoginId,password,rememberMe,nextPage,showPassword",
            authURL, nextPage: "", showPassword: "",
          });
          const sub = await nfFetch(`${NF_BASE}/login`, {
            method: "POST", body: form,
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Referer": loginPage.url || `${NF_BASE}/login`,
              "Origin": NF_BASE,
            },
          }, jar);
          subBody = await sub.text().catch(() => "");
          netflixMessage = extractNetflixMessage(subBody);
          loginState = inferNetflixLoginState(subBody, sub.url || "");
          finalLoginUrl = sub.url || finalLoginUrl;
          log("STEP-2", `status=${sub.status}  finalUrl=${sub.url}  cookies=${jar.size}  bytes=${subBody.length}`);
          log("STEP-2", `cookie names: ${cookieNames(jar) || "none"}`);
          log("STEP-2", `Netflix login state detected: ${loginState}`);
          if (netflixMessage) log("STEP-2", `Netflix said: ${netflixMessage.slice(0, 220)}`);
          else log("STEP-2", `body preview: ${subBody.slice(0, 250).replace(/\s+/g, " ")}`);
        }

        if (loginState === "incorrect_password") {
          throw new Error(`Netflix explicitly returned incorrect_password for ${email}. The script is now using Netflix's real Moneyball API, so update the saved password in TV Auto-Login → Netflix Vault if this persists.`);
        }
        if (loginState === "blocked") {
          throw new Error(`Netflix blocked automated password login for ${email}: ${netflixMessage || "risk/reCAPTCHA validation required"}. Try again later or refresh the vault password from a trusted device.`);
        }
        if (loginState === "password_required") {
          if (useDirectPassword) {
            throw new Error(`Netflix rejected the stored password for ${email}. Update it on the separate TV Auto-Login page → Netflix Vault, then retry.`);
          }
          throw new Error(`Netflix wants a password for ${email} instead of sending an OTP, but no saved password matched this selected/linked email. Add it on the separate TV Auto-Login page → Netflix Vault, then retry.`);
        }

        // Password-based success shortcut: do not trust cookie presence or the
        // POST URL. Only /browse verification can prove these are real session
        // cookies. If verification fails, nothing is saved.
        if (useDirectPassword && loginState !== "otp_challenge") {
          log("STEP-3", `Password submitted — verifying /browse before save. finalLoginUrl=${finalLoginUrl || "-"}`);
          await persistSession("password");
          return;
        }

        // Kick off IMAP sync so the OTP mail lands in cached_emails ASAP.
        log("STEP-3", "Triggering IMAP sync via fetch-emails…");
        try {
          const syncRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/fetch-emails`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-cron-secret": Deno.env.get("CRON_SHARED_SECRET") || "" },
            body: JSON.stringify({ mode: "sync", source: "netflix-test-login", accountLabels: pollLabels }),
          });
          const syncText = await syncRes.text().catch(() => "");
          let syncSummary = syncText.slice(0, 350).replace(/\s+/g, " ");
          try {
            const parsed = JSON.parse(syncText);
            syncSummary = `success=${parsed.success} totalFetched=${parsed.totalFetched ?? 0} inserted=${parsed.inserted ?? 0} warning=${parsed.warning || "-"}`;
          } catch { /* keep text summary */ }
          log("STEP-3", `IMAP sync trigger → status=${syncRes.status} ${syncSummary}`);
        } catch (e) {
          log("STEP-3", `sync trigger failed (continuing anyway): ${e instanceof Error ? e.message : String(e)}`);
        }

        log("STEP-3", `Polling latest Netflix mail  label="${chosenLabel}"  since=${triggerTs}`);
        let code = "";
        let matchedId = "";
        const pollStart = Date.now();
        let ticks = 0;
        while (Date.now() - pollStart < 90_000) {
          ticks++;
          // Re-trigger sync every ~10s so new mail is pulled from IMAP.
          if (ticks > 1 && ticks % 5 === 0) {
            fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/fetch-emails`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-cron-secret": Deno.env.get("CRON_SHARED_SECRET") || "" },
              body: JSON.stringify({ mode: "sync", source: "netflix-test-login-tick", accountLabels: pollLabels }),
            }).then((r) => r.text()).then((txt) => {
              try {
                const parsed = JSON.parse(txt);
                log("STEP-3", `background IMAP tick → success=${parsed.success} totalFetched=${parsed.totalFetched ?? 0} inserted=${parsed.inserted ?? 0}`);
              } catch { /* ignore */ }
            }).catch(() => {});
          }
          const { data: rows, error: pollErr } = await supabase
            .from("cached_emails")
            .select("id, subject, preview, html, from_address, to_address, otp, date")
            .in("account_label", pollLabels)
            .gt("date", triggerTs)
            .order("date", { ascending: false })
            .limit(10);
          if (pollErr) {
            log("STEP-3", `DB poll error: ${pollErr.message}`);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          if (rows && rows.length > 0 && ticks % 3 === 1) {
            log("STEP-3", `tick #${ticks} → ${rows.length} row(s) since trigger. Latest: "${(rows[0].subject || "").slice(0, 80)}" from ${String(rows[0].from_address || "").slice(0, 80)} to ${String(rows[0].to_address || "").slice(0, 80)}`);
          } else if (ticks % 3 === 1) {
            log("STEP-3", `tick #${ticks} → no cached Netflix mail newer than trigger yet in labels: ${pollLabels.join(", ")}`);
          }
          for (const row of rows || []) {
            const from = String(row.from_address || "").toLowerCase();
            if (!from.includes("netflix")) continue;
            const body = `${row.subject || ""} ${row.preview || ""} ${row.html || ""}`;
            const m = row.otp ? [row.otp, row.otp] : body.match(/\b(\d{4}|\d{6}|\d{8})\b/);
            if (m?.[1]) {
              code = m[1]; matchedId = row.id;
              log("STEP-3", `OTP found  id=${row.id}  subject="${(row.subject || "").slice(0, 80)}"  code=${code}`);
              break;
            }
          }
          if (code) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (!code) throw new Error(`OTP not received within 90s (polled ${ticks} times, from label="${chosenLabel}")`);
        log("STEP-3", `Using code ${code} from email ${matchedId}`);

        log("STEP-4", `POST OTP code=${code}`);
        const otpForm = new URLSearchParams({ code, authURL, action: "loginAction" });
        const otp = await nfFetch(`${NF_BASE}/login/help`, {
          method: "POST", body: otpForm,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }, jar);
        log("STEP-4", `status=${otp.status}  cookies=${jar.size}`);

        await persistSession("otp");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send("error", { error: msg });
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
