// Headless Netflix TV auto-login runner.
// Reads client_payload {event_id, ts} from GitHub Actions dispatch,
// fetches the job (code + cookies) from manage-app via HMAC,
// injects cookies into a Chromium context, submits the 8-digit code at
// https://www.netflix.com/tv8, then reports the result back.
//
// All calls to manage-app are signed with HMAC-SHA256 using TV_REPORT_HMAC_KEY.
// Cookies never appear in logs.

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";

const TV_REPORT_URL = process.env.TV_REPORT_URL;
const HMAC_KEY = process.env.TV_REPORT_HMAC_KEY;
const RUN_URL = process.env.GITHUB_RUN_URL || "";
const EVENT_PATH = process.env.EVENT_PATH;
const DIRECT_EVENT_ID = process.env.EVENT_ID;
const MAX_MS = Math.max(10000, Math.min(60000, Number(process.env.TV_LOGIN_MAX_MS || 30000)));
const SCRIPT_STARTED_AT = Date.now();

if (!TV_REPORT_URL || !HMAC_KEY || (!DIRECT_EVENT_ID && !EVENT_PATH)) {
  console.error("Missing required env: TV_REPORT_URL, TV_REPORT_HMAC_KEY, and EVENT_ID/EVENT_PATH");
  process.exit(1);
}

const sign = (payload) => createHmac("sha256", HMAC_KEY).update(payload).digest("hex");

const post = async (body) => {
  const res = await fetch(TV_REPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json?.success === false) {
    throw new Error(`manage-app ${body.action} failed [${res.status}]: ${text.slice(0, 300)}`);
  }
  return json;
};

const report = async ({ status, result, message, screenshot_url }) => {
  const ts = Date.now();
  const sig = sign(`tv_login_report|${EVENT_ID}|${ts}|${status || ""}|${result || ""}`);
  try {
    await post({
      action: "tv_login_report",
      event_id: EVENT_ID,
      ts, sig,
      status, result, message,
      screenshot_url: screenshot_url || "",
      run_url: RUN_URL,
    });
  } catch (e) {
    console.error("Report failed:", e.message);
  }
};

// ── Cookie parsing (JSON array/object + Netscape) ──────────────────
function parseCookies(raw, hint = "auto") {
  const text = String(raw || "").trim();
  if (!text) return [];
  // JSON
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
      return arr.map((c) => normalizeCookie(c)).filter(Boolean);
    } catch {}
  }
  // Netscape
  if (/^# Netscape/i.test(text) || /\t/.test(text)) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      if (parts.length < 7) continue;
      const [domain, , path, secure, expires, name, value] = parts;
      out.push(normalizeCookie({
        name, value, domain, path: path || "/",
        expires: Number(expires) || undefined,
        secure: /^true$/i.test(secure),
      }));
    }
    return out.filter(Boolean);
  }
  // Cookie header string: "a=b; c=d"
  if (text.includes("=")) {
    const out = [];
    for (const part of text.split(/;\s*/)) {
      const eq = part.indexOf("=");
      if (eq < 1) continue;
      out.push(normalizeCookie({
        name: part.slice(0, eq).trim(),
        value: part.slice(eq + 1).trim(),
        domain: ".netflix.com",
        path: "/",
      }));
    }
    return out.filter(Boolean);
  }
  return [];
}

function normalizeCookie(c) {
  if (!c || !c.name || c.value === undefined || c.value === null) return null;
  const domain = String(c.domain || ".netflix.com").trim();
  const out = {
    name: String(c.name),
    value: String(c.value),
    domain: domain.startsWith(".") ? domain : (domain.includes("netflix") ? domain : `.${domain}`),
    path: c.path || "/",
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: c.sameSite === "None" || c.sameSite === "Lax" || c.sameSite === "Strict"
      ? c.sameSite
      : "Lax",
  };
  const exp = Number(c.expires || c.expirationDate);
  if (Number.isFinite(exp) && exp > 0) out.expires = Math.floor(exp);
  return out;
}

const remaining = () => Math.max(0, MAX_MS - (Date.now() - SCRIPT_STARTED_AT));
const timeoutBudget = (desiredMs, floorMs = 1500) => {
  const left = remaining();
  if (left <= 0) return floorMs;
  return Math.max(floorMs, Math.min(desiredMs, left));
};

// ── Main ────────────────────────────────────────────────────────────
let EVENT_ID = DIRECT_EVENT_ID;
if (!EVENT_ID && EVENT_PATH) {
  const eventFile = await readFile(EVENT_PATH, "utf8");
  const eventObj = JSON.parse(eventFile);
  EVENT_ID = eventObj?.client_payload?.event_id;
}
if (!EVENT_ID) {
  console.error("Missing event_id in client_payload");
  process.exit(1);
}
console.log("Event:", EVENT_ID);

// 1) Fetch job (code + cookies)
const fetchTs = Date.now();
const fetchSig = sign(`tv_login_fetch_job|${EVENT_ID}|${fetchTs}`);
let job;
try {
  job = await post({
    action: "tv_login_fetch_job",
    event_id: EVENT_ID,
    ts: fetchTs,
    sig: fetchSig,
    run_url: RUN_URL,
  });
} catch (e) {
  console.error(e.message);
  await report({ status: "error", result: "fetch_failed", message: e.message });
  process.exit(1);
}

const code = String(job.code || "").replace(/\D/g, "");
const cookies = parseCookies(job.cookies_content, job.cookies_format);
console.log(`Parsed ${cookies.length} cookies. Code length: ${code.length}`);

if (code.length !== 8) {
  await report({ status: "error", result: "bad_code", message: "Code from event is not 8 digits" });
  process.exit(1);
}
if (cookies.length === 0) {
  await report({ status: "error", result: "no_cookies", message: "No cookies could be parsed" });
  process.exit(1);
}

// 2) Launch browser & do login — aggressive perf: block heavy resources,
//    skip images/media/fonts/analytics so /tv8 renders in ~1-2s instead of ~5-8s.
const t0 = Date.now();
  const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter",
  ],
});
let status = "error", result = "unknown", message = "", screenshotUrl = "";

try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    javaScriptEnabled: true,
  });
  await context.addCookies(cookies);

  const page = await context.newPage();

  // Block anything not needed to render + submit the tv8 form.
  // Block only heavy media + analytics. Do NOT block stylesheets — the /tv8
  // page is a React SPA and the PIN input positions/hydrates via CSS+JS.
  // Blocking stylesheets caused past `no_code_input` failures.
  await page.route("**/*", (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === "image" || type === "media" || type === "font") {
      return route.abort();
    }
    const url = req.url();
    if (/googletagmanager|google-analytics|doubleclick|segment|nflxext\.com\/.*\.jpg|nflxso\.net\/.*\.png|assets\.nflxext\.com\/.*\.mp4/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  await page.goto("https://www.netflix.com/tv8", { waitUntil: "domcontentloaded", timeout: timeoutBudget(10000, 5000) });
  console.log(`[perf] tv8 loaded in ${Date.now() - t0}ms url=${page.url()}`);

  // Netflix SPA hydrates the PIN inputs after JS runs. Give it real time
  // on GitHub runners (slower CPU than VPS).
  const hasCodeInput = await page.waitForSelector(
    'input.pin-number-input, input[aria-label^="PIN entry input"], input[maxlength="1"], input[data-uia*="digit"], input[type="tel"], input[inputmode="numeric"], input[name*="code" i]',
    { timeout: timeoutBudget(12000, 4000) },
  ).then(() => true).catch(() => false);

  if (!hasCodeInput) {
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const url = page.url();
    // Ship a short DOM snippet so we can see WHY inputs never appeared.
    const domSnippet = (await page.content().catch(() => "")).slice(0, 800).replace(/\s+/g, " ");
    console.log(`[debug] no_code_input url=${url} bodyStart="${bodyText.slice(0, 200)}"`);
    console.log(`[debug] dom="${domSnippet}"`);
    if (/sign ?in|log ?in|password|email|expired|unsupported|not available|something went wrong/i.test(bodyText) || /login|unsupportedbrowser/i.test(url)) {
      status = "cookies_expired"; result = "cookies_expired"; message = `Cookies expired at ${url}`;
    } else {
      status = "error"; result = "no_code_input"; message = `Netflix code input did not appear at ${url} | body="${bodyText.slice(0, 120)}"`;
    }
    throw new Error(message);
  }

  const boxes = await page.locator('input.pin-number-input, input[aria-label^="PIN entry input"], input[maxlength="1"], input[data-uia*="digit"], input[type="tel"][maxlength="1"]').all().catch(() => []);
  if (boxes.length >= 8) {
    for (let i = 0; i < 8; i++) {
      await boxes[i].fill(code[i]).catch(() => {});
    }
  } else {
    const single = page.locator('input[type="tel"], input[inputmode="numeric"], input[name*="code" i]').first();
    await single.waitFor({ timeout: timeoutBudget(3000, 1500) });
    await single.fill(code);
  }

  const ready = await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const btn = buttons.find((b) => b.classList.contains("tvsignup-continue-button") || /enter code|continue|sign in|submit/i.test(b.textContent || ""));
    if (!btn || btn.disabled) return false;
    const rect = btn.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, { timeout: timeoutBudget(5000, 2500) }).then(() => true).catch(() => false);

  if (!ready) {
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    status = "error"; result = "netflix_timeout"; message = `Netflix submit button did not become ready. body="${bodyText.slice(0, 160)}"`;
    throw new Error(message);
  }

  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const btn = buttons.find((b) => b.classList.contains("tvsignup-continue-button") || /enter code|continue|sign in|submit/i.test(b.textContent || ""));
    if (!btn) throw new Error("submit_button_missing");
    btn.click();
  });
  console.log(`[perf] code submitted at ${Date.now() - t0}ms`);

  // Poll for result inside the global 9s SLA.
  const deadline = Date.now() + Math.max(3000, Math.min(6000, timeoutBudget(6000, 3000)));
  let bodyText = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (/success|signed in|logged in|welcome|activated|linked|connected|invalid|incorrect|wrong|not recognized|try again|expired/i.test(bodyText)) break;
    if (!/\/tv8/i.test(page.url())) break;
  }
  console.log(`[perf] result detected at ${Date.now() - t0}ms`);

  if (/success|signed in|logged in|welcome|activated|linked|connected/i.test(bodyText)) {
    status = "success"; result = "success"; message = "TV signed in successfully";
  } else if (/invalid|incorrect|wrong|couldn.?t|not recognized|try again/i.test(bodyText)) {
    status = "invalid_code"; result = "invalid_code"; message = "Netflix rejected the code";
  } else if (/expired|session|log ?in|sign ?in|password/i.test(bodyText)) {
    status = "cookies_expired"; result = "cookies_expired"; message = "Cookies appear to be expired";
  } else {
    const url = page.url();
    if (!/\/tv8/i.test(url)) {
      status = "success"; result = "success"; message = `Redirected to ${url}`;
    } else {
      status = "error"; result = "unknown"; message = "Unable to determine result from page";
    }
  }

  console.log(`Result: ${status} | ${message.slice(0, 120)} | total ${Date.now() - t0}ms`);
  await context.close();
} catch (e) {
  const raw = e?.message || String(e);
  if (result === "netflix_timeout") {
    status = "error";
    message = "Netflix took too long to show the submit/result screen. Please try a fresh TV code.";
  } else if (/Timeout|timed out|timeout/i.test(raw)) {
    status = "error"; result = "netflix_timeout";
    message = "Netflix took too long to respond. Please try a fresh TV code.";
  } else if (/invalid|wasn.?t right|incorrect|not recognized|try again/i.test(raw)) {
    status = "invalid_code"; result = "invalid_code";
    message = "Netflix rejected the code. Please generate a fresh code on your TV.";
  } else if (/cookies expired|login|password|email/i.test(raw)) {
    status = "cookies_expired"; result = "cookies_expired";
    message = "Saved Netflix cookies are expired. Ask the admin to refresh cookies.";
  } else {
    status = "error"; result = "runner_error"; message = raw;
  }
  console.error("Runner error:", message);
} finally {
  await browser.close().catch(() => {});
}

await report({ status, result, message, screenshot_url: screenshotUrl });
console.log("Done.");
