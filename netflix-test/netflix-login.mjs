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
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Merge Set-Cookie values from a response into `jar`. */
function collectCookies(res, jar) {
  const raw = res.headers.getSetCookie?.() ?? res.headers.get("set-cookie");
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  for (const c of arr) {
    const first = c.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

async function nfFetch(url, init, jar) {
  const headers = new Headers(init?.headers || {});
  headers.set("User-Agent", UA);
  headers.set("Accept-Language", "en-US,en;q=0.9");
  if (jar && jar.size > 0) headers.set("Cookie", jarToHeader(jar));
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  if (jar) collectCookies(res, jar);
  return res;
}

async function loadLoginPage(jar) {
  log("STEP-1", "GET /login");
  const res = await nfFetch(`${NF_BASE}/login`, {}, jar);
  const html = await res.text();
  const authURL = html.match(/"authURL"\s*:\s*"([^"]+)"/)?.[1] || null;
  const build = html.match(/BUILD_IDENTIFIER"?\s*:\s*"([^"]+)"/)?.[1] || null;
  log("STEP-1", `status=${res.status} cookies=${jar.size} authURL=${!!authURL} build=${build ?? "n/a"}`);
  if (!authURL) throw new Error("authURL not found on /login page — Netflix may be bot-blocking this IP");
  return { authURL, build };
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
  if (!email) { console.error("--email required"); process.exit(1); }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  const jar = new Map();
  const t0 = new Date().toISOString();
  const { authURL } = await loadLoginPage(jar);
  await submitEmail(jar, authURL, email);
  const code = await waitForOtp({ supabase, accountLabel, sinceIso: t0 });
  await submitCode(jar, authURL, code);

  log("STEP-5", "Persisting cookies to netflix_sessions");
  const cookies = jarToHeader(jar);
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
