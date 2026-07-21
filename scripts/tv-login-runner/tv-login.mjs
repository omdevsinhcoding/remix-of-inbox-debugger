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

if (!TV_REPORT_URL || !HMAC_KEY || !EVENT_PATH) {
  console.error("Missing required env: TV_REPORT_URL, TV_REPORT_HMAC_KEY, EVENT_PATH");
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

// ── Main ────────────────────────────────────────────────────────────
const eventFile = await readFile(EVENT_PATH, "utf8");
const eventObj = JSON.parse(eventFile);
const EVENT_ID = eventObj?.client_payload?.event_id;
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

// 2) Launch browser & do login
const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
let status = "error", result = "unknown", message = "", screenshotUrl = "";

try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });
  await context.addCookies(cookies);

  const page = await context.newPage();
  await page.goto("https://www.netflix.com/tv8", { waitUntil: "domcontentloaded", timeout: 45000 });

  // Wait for the code input(s). Netflix uses either a single input or 8 separate boxes.
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

  // Try 8 separate inputs first
  const boxes = await page.locator('input[maxlength="1"], input[data-uia*="digit"], input[type="tel"][maxlength="1"]').all().catch(() => []);
  if (boxes.length >= 8) {
    for (let i = 0; i < 8; i++) {
      await boxes[i].fill(code[i]).catch(() => {});
    }
  } else {
    // Fallback: single input
    const single = page.locator('input[type="tel"], input[inputmode="numeric"], input[name*="code" i]').first();
    await single.waitFor({ timeout: 10000 });
    await single.fill(code);
  }

  // Submit
  const submit = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign In"), button:has-text("Submit")').first();
  await submit.click({ timeout: 10000 }).catch(() => {});

  // Wait a moment for result
  await page.waitForTimeout(4000);
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

  if (/success|signed in|logged in|welcome|activated|linked|connected/i.test(bodyText)) {
    status = "success"; result = "success"; message = "TV signed in successfully";
  } else if (/invalid|incorrect|wrong|couldn.?t|not recognized|try again/i.test(bodyText)) {
    status = "invalid_code"; result = "invalid_code"; message = "Netflix rejected the code";
  } else if (/expired|session|log ?in|sign ?in|password/i.test(bodyText)) {
    status = "cookies_expired"; result = "cookies_expired"; message = "Cookies appear to be expired";
  } else {
    // Fallback: consider it success if we're no longer on /tv8
    const url = page.url();
    if (!/\/tv8/i.test(url)) {
      status = "success"; result = "success"; message = `Redirected to ${url}`;
    } else {
      status = "error"; result = "unknown"; message = "Unable to determine result from page";
    }
  }

  console.log(`Result: ${status} | ${message.slice(0, 120)}`);
  await context.close();
} catch (e) {
  status = "error"; result = "runner_error"; message = e?.message || String(e);
  console.error("Runner error:", message);
} finally {
  await browser.close().catch(() => {});
}

await report({ status, result, message, screenshot_url: screenshotUrl });
console.log("Done.");
