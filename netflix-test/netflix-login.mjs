#!/usr/bin/env node
/**
 * Netflix login — HTTP only, no browser, no Selenium.
 *
 * Standalone reference implementation. The same logic lives inside the
 * `netflix-test-login` edge function that the admin "Start Test" button
 * drives. Keep the two in sync when iterating.
 *
 * Usage:
 *   node netflix-test/netflix-login.mjs \
 *     --email omdevsinhgohil538+freenf@gmail.com \
 *     --account-label "Primary"
 */

import { createClient } from "@supabase/supabase-js";

const NF_BASE = "https://www.netflix.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function log(step, msg, extra) {
  const line = `[${new Date().toISOString()}] [${step}] ${msg}`;
  if (extra) console.log(line, extra);
  else console.log(line);
}

function argv(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

/** Serialize a Set-Cookie header set into a Cookie: header string. */
function jarToHeader(jar) {
  return [...jar.values()].map((c) => `${c.name}=${c.value}`).join("; ");
}

function splitSetCookieHeader(raw) {
  return raw.split(/,(?=\s*[^;,\s]+=)/g).map((s) => s.trim()).filter(Boolean);
}

function parseSetCookie(rawCookie, responseUrl) {
  const parts = rawCookie.split(";").map((p) => p.trim()).filter(Boolean);
  const first = parts.shift() || "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const url = new URL(responseUrl);
  const cookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    domain: url.hostname,
    hostOnly: true,
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: null,
    session: true,
    firstPartyDomain: "",
    partitionKey: null,
    storeId: null,
  };
  for (const attr of parts) {
    const attrEq = attr.indexOf("=");
    const key = (attrEq >= 0 ? attr.slice(0, attrEq) : attr).trim().toLowerCase();
    const val = attrEq >= 0 ? attr.slice(attrEq + 1).trim() : "";
    if (key === "domain" && val) { cookie.domain = val.toLowerCase(); cookie.hostOnly = false; }
    else if (key === "path" && val) cookie.path = val;
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite" && val) cookie.sameSite = val.toLowerCase() === "none" ? "no_restriction" : val.toLowerCase();
    else if (key === "expires" && val) {
      const ms = Date.parse(val);
      if (Number.isFinite(ms)) { cookie.expirationDate = Math.floor(ms / 1000); cookie.session = false; }
    } else if (key === "max-age" && val) {
      const seconds = Number(val);
      if (Number.isFinite(seconds)) { cookie.expirationDate = Math.floor(Date.now() / 1000 + seconds); cookie.session = false; }
    }
  }
  return cookie;
}

/** Merge Set-Cookie values from a response into `jar`. */
function collectCookies(res, jar) {
  const raw = res.headers.getSetCookie?.() ?? res.headers.get("set-cookie");
  const arr = Array.isArray(raw) ? raw : (raw ? splitSetCookieHeader(raw) : []);
  for (const c of arr) {
    const parsed = parseSetCookie(c, res.url || NF_BASE);
    if (parsed) jar.set(parsed.name, parsed);
  }
}

function htmlText(input) {
  return String(input || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeNetflixSignedIn(html, url, status) {
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return String(url || "").toLowerCase(); } })();
  const text = htmlText(html).toLowerCase();
  if (status >= 400) return false;
  if (/\/(login|signup|login\/help|password)/.test(path)) return false;
  if (/sign in to netflix|email or mobile number|enter your password|incorrect password|sorry, we can't find an account/i.test(text)) return false;
  return /\/(browse|profiles|watch|kids)/.test(path) || /who(?:'|’)s watching|manage profiles|account menu|sign out/i.test(text);
}

async function verifyNetflixSession(jar) {
  log("STEP-5", "GET /browse to verify real signed-in session");
  const res = await nfFetch(`${NF_BASE}/browse`, { headers: { Referer: NF_BASE } }, jar);
  const body = await res.text();
  const ok = looksLikeNetflixSignedIn(body, res.url, res.status);
  log("STEP-5", `status=${res.status} finalUrl=${res.url} validSession=${ok}`);
  if (!ok) throw new Error("Netflix cookies are not a real signed-in session; not saved");
  for (const name of ["NetflixId", "SecureNetflixId", "gsid"]) {
    if (!jar.has(name)) throw new Error(`verified session missing required cookie: ${name}`);
  }
}

async function nfFetch(url, init, jar) {
  const headers = new Headers(init?.headers || {});
  headers.set("User-Agent", UA);
  if (!headers.has("Accept")) headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9");
  if (jar && jar.size > 0) headers.set("Cookie", jarToHeader(jar));
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  if (jar) collectCookies(res, jar);
  return res;
}

function decodeNetflixString(input) {
  return String(input || "")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/");
}

function extractAuthURL(html) {
  return decodeNetflixString(html.match(/"authURL"\s*:\s*"([^"]+)"/)?.[1] || "");
}

function extractRequestCountryIso(html) {
  return (html.match(/"requestCountry"\s*:\s*\{[^}]*"id"\s*:\s*"([A-Z]{2})"/)?.[1] || "US").toUpperCase();
}

async function loadLoginPage(jar) {
  log("STEP-1", "GET /login");
  const res = await nfFetch(`${NF_BASE}/login`, {}, jar);
  const html = await res.text();
  const authURL = extractAuthURL(html) || null;
  const countryIso = extractRequestCountryIso(html);
  const build = html.match(/BUILD_IDENTIFIER"?\s*:\s*"([^"]+)"/)?.[1] || null;
  log("STEP-1", `status=${res.status} cookies=${jar.size} authURL=${!!authURL} country=${countryIso} build=${build ?? "n/a"}`);
  if (!authURL) throw new Error("authURL not found on /login page — Netflix may be bot-blocking this IP");
  return { authURL, countryIso, build, finalUrl: res.url || `${NF_BASE}/login` };
}

function moneyballField(value) {
  return { value };
}

function readMoneyballField(fields, key) {
  const field = fields?.[key];
  return typeof field === "object" && field && "value" in field ? field.value : undefined;
}

function inferMoneyballState(nextValue) {
  const result = nextValue?.result || {};
  const fields = result?.fields || {};
  const userContext = nextValue?.userContext || {};
  const errorCode = String(readMoneyballField(fields, "errorCode") || "").toLowerCase();
  const mode = String(result?.mode || "").toLowerCase();
  const fieldKeys = Object.keys(fields);
  if (String(userContext?.membershipStatus || "").toUpperCase() === "CURRENT_MEMBER" || userContext?.userGuid || userContext?.guid) return "signed_in";
  if (errorCode.includes("incorrect_password") || errorCode.includes("invalid_password")) return "incorrect_password";
  if (errorCode.includes("captcha") || errorCode.includes("recaptcha")) return "blocked";
  if (/otp|code/.test(mode) || fieldKeys.some((k) => /otp|code/i.test(k))) return "otp_challenge";
  if (fields.password || fields.loginAction) return "password_required";
  return "unknown";
}

async function submitMoneyballPassword(jar, { email, password, authURL, countryIso, referer }) {
  log("STEP-2", `POST Moneyball /api/aui/pathEvaluator email=${email} password=(provided)`);
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
  const res = await nfFetch(endpoint, {
    method: "POST",
    body: new URLSearchParams({ param, authURL }),
    headers: {
      "Accept": "application/json, text/javascript, */*",
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": NF_BASE,
      "Referer": referer,
      "X-Netflix.request.routing": JSON.stringify({ path: "/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator", control_tag: "auinqweb" }),
    },
  }, jar);
  const text = await res.text();
  const parsed = JSON.parse(text);
  const next = parsed?.jsonGraph?.aui?.moneyball?.next;
  if (next?.$type === "error") throw new Error(next?.value?.message || next?.value?.name || "Moneyball error");
  const state = inferMoneyballState(next?.value);
  log("STEP-2", `status=${res.status} bytes=${text.length} state=${state} cookies=${jar.size}`);
  return state;
}

async function submitEmail(jar, authURL, email) {
  log("STEP-2", `POST /login  email=${mask(email)}`);
  const form = new URLSearchParams({
    userLoginId: email,
    password: "",
    rememberMe: "true",
    flow: "websiteSignUp",
    mode: "login",
    action: "loginAction",
    withFields: "userLoginId,password,rememberMe,nextPage,showPassword",
    authURL,
    nextPage: "",
    showPassword: "",
  });
  const res = await nfFetch(`${NF_BASE}/login`, {
    method: "POST",
    body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }, jar);
  log("STEP-2", `status=${res.status}  location=${res.headers.get("location") || "-"}`);
  return res;
}

/**
 * Poll the cached_emails table for a freshly-arrived Netflix sign-in code
 * addressed to `accountLabel`, newer than `sinceIso`.
 */
async function waitForOtp({ supabase, accountLabel, sinceIso, timeoutMs = 90_000 }) {
  const start = Date.now();
  log("STEP-3", `polling cached_emails  label="${accountLabel}"  since=${sinceIso}`);
  while (Date.now() - start < timeoutMs) {
    const { data, error } = await supabase
      .from("cached_emails")
      .select("id, subject, preview, date, from")
      .eq("account_label", accountLabel)
      .gt("date", sinceIso)
      .order("date", { ascending: false })
      .limit(5);
    if (error) log("STEP-3", `query error: ${error.message}`);
    for (const row of data || []) {
      const from = String(row.from || "").toLowerCase();
      if (!from.includes("netflix")) continue;
      const hay = `${row.subject || ""} ${row.preview || ""}`;
      const m = hay.match(/\b(\d{4}|\d{6}|\d{8})\b/);
      if (m) {
        log("STEP-3", `OTP found  id=${row.id}  code=${m[1]}`);
        return m[1];
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`OTP not received within ${timeoutMs}ms`);
}

async function submitCode(jar, authURL, code) {
  log("STEP-4", `POST OTP code=${code}`);
  const form = new URLSearchParams({ code, authURL, action: "loginAction" });
  const res = await nfFetch(`${NF_BASE}/login/help`, {
    method: "POST",
    body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }, jar);
  log("STEP-4", `status=${res.status}  cookies=${jar.size}`);
  return res;
}

function mask(email) {
  const [u, d] = email.split("@");
  return `${u.slice(0, 2)}•••@${d}`;
}

async function main() {
  const email = argv("email");
  const accountLabel = argv("account-label", "Primary");
  const password = argv("password", process.env.NETFLIX_PASSWORD || "");
  if (!email) { console.error("--email required"); process.exit(1); }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  const jar = new Map();
  const t0 = new Date().toISOString();
  const { authURL, countryIso, finalUrl } = await loadLoginPage(jar);
  if (password) {
    const state = await submitMoneyballPassword(jar, { email, password, authURL, countryIso, referer: finalUrl });
    if (state === "incorrect_password") throw new Error("Netflix returned incorrect_password");
    if (state === "blocked") throw new Error("Netflix blocked automated login with reCAPTCHA/risk validation");
    if (state === "password_required") throw new Error("Netflix still shows password_required after Moneyball submit");
  } else {
    await submitEmail(jar, authURL, email);
    const code = await waitForOtp({ supabase, accountLabel, sinceIso: t0 });
    await submitCode(jar, authURL, code);
  }

  await verifyNetflixSession(jar);

  log("STEP-5", "Persisting cookies to netflix_sessions");
  const cookies = JSON.stringify([...jar.values()]);
  const { error } = await supabase
    .from("netflix_sessions")
    .upsert({
      email,
      account_label: accountLabel,
      cookies_json: cookies,
      status: "active",
      last_login_at: new Date().toISOString(),
    }, { onConflict: "email" });
  if (error) throw error;
  log("DONE", `session stored (${jar.size} cookies)`);
}

main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });
