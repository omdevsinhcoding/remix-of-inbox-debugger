// Warm Netflix TV auto-login runner for strict sub-20s attempts.
// Keep this process alive on the VPS. The app calls POST /run directly;
// no GitHub Actions queue, checkout, browser install, or runner allocation.
//
// 24/7 warm-browser policy:
//   - The Chromium process is launched at boot and NEVER intentionally closed.
//   - A background keep-alive pings it every 30s; if `browser.isConnected()`
//     ever returns false (crash, OOM, GPU reset, etc.), we relaunch instantly
//     so the next incoming /run has a hot browser waiting.
//   - A warm context pool holds N pre-created BrowserContexts with cookies
//     NOT yet injected. When a job arrives we pull one off the pool (no
//     newContext() latency on the hot path) and refill in the background.
//   - We NEVER call browser.close() on shutdown paths that aren't SIGTERM /
//     SIGINT — even the "safe teardown" after a job only closes the context,
//     never the browser.

import http from "node:http";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

// SERVER_VERSION is bumped whenever the on-wire /health schema, timeout
// budget, or reporting protocol changes. If /health shows a version older
// than this constant in the repo, the VPS is running a stale build.
const SERVER_VERSION = "2026.08.07-11";

const __dirname = dirname(fileURLToPath(import.meta.url));
let PACKAGE_VERSION = "unknown";
try { PACKAGE_VERSION = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version || "unknown"; } catch {}
let GIT_COMMIT = process.env.COMMIT_SHA || "";
if (!GIT_COMMIT) {
  try { GIT_COMMIT = execSync("git -C " + JSON.stringify(__dirname) + " rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
}
const STARTED_AT = new Date().toISOString();

const PORT = Number(process.env.PORT || 8788);
const TV_REPORT_URL = process.env.TV_REPORT_URL;
const TV_JOB_URL = process.env.TV_JOB_URL || TV_REPORT_URL.replace(/\/manage-app\/?$/, "/tv-runner-job");
const ENV_MAX_MS = process.env.TV_LOGIN_MAX_MS;
const MAX_MS = Math.max(12000, Math.min(30000, Number(ENV_MAX_MS || 24000)));
const MAX_CONCURRENT = Math.max(1, Math.min(8, Number(process.env.TV_RUNNER_CONCURRENCY || 4)));
const WARM_POOL_SIZE = Math.max(1, Math.min(MAX_CONCURRENT, Number(process.env.TV_WARM_POOL || 2)));
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

if (!TV_REPORT_URL) {
  console.error("Missing env: TV_REPORT_URL is required.");
  process.exit(1);
}

let browser = null;
let browserLaunchInFlight = null;
let browserRelaunchCount = 0;
let lastRelaunchAt = null;
const warmContexts = []; // pre-created BrowserContexts ready to accept cookies
let activeJobs = 0;
let lastJob = null;
let shuttingDown = false;

const now = () => Date.now();
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function launchBrowser() {
  const b = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter",
      "--no-zygote",
      "--disable-extensions",
    ],
  });
  b.on("disconnected", () => {
    console.error("[browser] disconnected — will relaunch on next demand");
    if (browser === b) browser = null;
    // Purge stale warm contexts tied to the dead browser.
    warmContexts.length = 0;
    if (!shuttingDown) {
      // Kick off an immediate relaunch so the next /run is hot.
      ensureBrowser().catch((e) => console.error("[browser] relaunch failed", e));
    }
  });
  return b;
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browserLaunchInFlight) return browserLaunchInFlight;
  browserLaunchInFlight = (async () => {
    try {
      const b = await launchBrowser();
      browser = b;
      if (browserRelaunchCount > 0) lastRelaunchAt = new Date().toISOString();
      browserRelaunchCount += 1;
      console.log(`[browser] launched (count=${browserRelaunchCount})`);
      // Kick off warm-pool refill in the background.
      refillWarmPool().catch(() => {});
      return b;
    } finally {
      browserLaunchInFlight = null;
    }
  })();
  return browserLaunchInFlight;
}

async function createWarmContext() {
  const b = await ensureBrowser();
  return b.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    javaScriptEnabled: true,
  });
}

async function refillWarmPool() {
  while (!shuttingDown && warmContexts.length < WARM_POOL_SIZE) {
    try {
      const ctx = await createWarmContext();
      // Guard: if browser died between await and here, discard.
      if (!browser || !browser.isConnected()) { try { await ctx.close(); } catch {} break; }
      warmContexts.push(ctx);
    } catch (e) {
      console.error("[pool] refill failed", e instanceof Error ? e.message : e);
      break;
    }
  }
}

async function takeWarmContext() {
  const ctx = warmContexts.shift();
  // Refill asynchronously so the next job also gets a warm context.
  refillWarmPool().catch(() => {});
  if (ctx) return ctx;
  return createWarmContext();
}

async function postJson(url, body, timeoutMs = 2500) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!res.ok || parsed?.success === false) throw new Error(`runner API ${body.action || "fetch_job"} failed [${res.status}]: ${text.slice(0, 300)}`);
  return parsed;
}

const postManageApp = (body, timeoutMs = 2500) => postJson(TV_REPORT_URL, body, timeoutMs);

async function report(eventId, runnerToken, { status, result, message, screenshot_url = "" }) {
  await postManageApp({ action: "tv_login_report", event_id: eventId, runner_token: runnerToken, status, result, message, screenshot_url, run_url: "fast-runner" });
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
    sameSite: c.sameSite === "None" || c.sameSite === "Lax" || c.sameSite === "Strict" ? c.sameSite : "Lax",
  };
  const exp = Number(c.expires || c.expirationDate);
  if (Number.isFinite(exp) && exp > 0) out.expires = Math.floor(exp);
  return out;
}

function parseCookies(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
      return arr.map(normalizeCookie).filter(Boolean);
    } catch {}
  }
  if (/^# Netscape/i.test(text) || /\t/.test(text)) {
    return text.split(/\r?\n/).flatMap((line) => {
      if (!line || line.startsWith("#")) return [];
      const parts = line.split("\t");
      if (parts.length < 7) return [];
      const [domain, , path, secure, expires, name, value] = parts;
      const c = normalizeCookie({ domain, path: path || "/", secure: /^true$/i.test(secure), expires: Number(expires) || undefined, name, value });
      return c ? [c] : [];
    });
  }
  if (text.includes("=")) {
    return text.split(/;\s*/).flatMap((part) => {
      const eq = part.indexOf("=");
      if (eq < 1) return [];
      const c = normalizeCookie({ name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim(), domain: ".netflix.com", path: "/" });
      return c ? [c] : [];
    });
  }
  return [];
}

async function runTvJob(eventId, runnerToken) {
  const started = now();
  const mark = {};
  let stage = "starting";
  let context = null;
  let reported = false;
  const elapsed = () => now() - started;
  const remaining = () => Math.max(1, MAX_MS - elapsed());
  lastJob = { eventId, startedAt: new Date().toISOString(), status: "running" };

  const safeReport = async (payload) => {
    try {
      await report(eventId, runnerToken, payload);
      reported = true;
    } catch (err) {
      console.error("report failed", err instanceof Error ? err.message : err);
    }
  };

  try {
    stage = "fetch_job";
    const job = await postJson(
      TV_JOB_URL,
      { event_id: eventId, runner_token: runnerToken },
      Math.min(4500, remaining()),
    );
    mark.fetch = elapsed();

    const code = String(job.code || "").replace(/\D/g, "");
    const cookies = parseCookies(job.cookies_content);
    if (code.length !== 8) throw new Error("Code from event is not 8 digits");
    if (cookies.length === 0) throw new Error("No cookies could be parsed");

    // Warm context from the pool — no launch latency on the hot path.
    context = await takeWarmContext();
    mark.browser = elapsed();
    stage = "inject_cookies";
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      try {
        const req = route.request();
        const type = req.resourceType();
        const url = req.url();
        if (["image", "media", "font"].includes(type)) return route.abort().catch(() => {});
        if (/googletagmanager|google-analytics|doubleclick|segment|monet|adtech|logs\.netflix\.com|\.mp4|\.jpg|\.png|\.webp/i.test(url)) return route.abort().catch(() => {});
        return route.continue().catch(() => {});
      } catch { /* context closed */ }
    });

    stage = "open_netflix_tv8";
    // Start PIN detection as soon as Netflix commits the document. Waiting for
    // DOMContentLoaded also waits on unrelated scripts even though the input is
    // already usable, adding several seconds to otherwise successful attempts.
    await page.goto("https://www.netflix.com/tv8", { waitUntil: "commit", timeout: Math.min(9000, remaining()) });
    mark.nav = elapsed();

    stage = "wait_code_input";
    // Netflix rotates TV code input markup; keep a broad, prioritized selector list.
    const selectorSets = [
      'input.pin-number-input',
      'input[data-uia="pin-number-input"]',
      'input[data-uia^="pin-number"]',
      'input[aria-label*="PIN" i]',
      'input[aria-label*="code" i]',
      'input[maxlength="1"]',
      'input[type="tel"][maxlength="1"]',
      'input[type="number"][maxlength="1"]',
      'input[type="text"][maxlength="1"]',
      'input[autocomplete="one-time-code"]',
      'input[autocomplete="off"][maxlength="1"]',
      'input[inputmode="numeric"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="PIN" i]',
    ];
    // Only target actionable fields. Netflix keeps hidden/transitioning inputs
    // in the DOM; the previous broad locator counted those too, so its fallback
    // could spend the whole attempt filling a hidden non-PIN field.
    const combinedSelector = selectorSets.map((selector) => `${selector}:visible`).join(", ");
    let digitInputs = page.locator(combinedSelector);
    let hasCodeInput = await digitInputs.first().waitFor({ timeout: Math.min(7000, remaining()) }).then(() => true).catch(() => false);
    if (!hasCodeInput && remaining() > 6000 && !/login|unsupportedbrowser/i.test(page.url())) {
      await page.goto("https://www.netflix.com/tv8", { waitUntil: "networkidle", timeout: Math.min(6000, remaining()) }).catch(() => {});
      hasCodeInput = await digitInputs.first().waitFor({ timeout: Math.min(5000, remaining()) }).then(() => true).catch(() => false);
    }
    if (!hasCodeInput) {
      // Last resort: scan every input for code/PIN-like attributes.
      const allInputs = await page.locator('input').all();
      const digitLike = [];
      for (const el of allInputs) {
        const max = String(await el.getAttribute("maxlength").catch(() => "") || "");
        const type = String(await el.getAttribute("type").catch(() => "") || "").toLowerCase();
        const inputmode = String(await el.getAttribute("inputmode").catch(() => "") || "").toLowerCase();
        const aria = String(await el.getAttribute("aria-label").catch(() => "") || "").toLowerCase();
        const placeholder = String(await el.getAttribute("placeholder").catch(() => "") || "").toLowerCase();
        if (max === "1" || type === "tel" || inputmode === "numeric" || aria.includes("pin") || aria.includes("code") || placeholder.includes("pin") || placeholder.includes("code")) {
          digitLike.push(el);
        }
      }
      if (digitLike.length >= 8) {
        // Re-target with a stable single-digit selector that the page actually contains.
        digitInputs = page.locator('input[maxlength="1"]:visible, input[type="tel"]:visible, input[inputmode="numeric"]:visible');
        hasCodeInput = true;
      }
    }
    if (!hasCodeInput) {
      const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      const url = page.url();
      const timing = `timing fetch=${mark.fetch}ms browser=${mark.browser}ms nav=${mark.nav}ms total=${elapsed()}ms`;
      const looksExpired = /sign ?in|log ?in|password|email|expired|unsupported|not available|something went wrong|your account has been|verify/i.test(bodyText) || /login|unsupportedbrowser/i.test(url);
      await safeReport({
        status: looksExpired ? "cookies_expired" : "error",
        result: looksExpired ? "cookies_expired" : "no_code_input",
        message: `${looksExpired ? "Cookies appear to be expired" : "Netflix code input did not appear"} | ${timing}`,
      });
      lastJob = { ...lastJob, status: looksExpired ? "cookies_expired" : "error", result: looksExpired ? "cookies_expired" : "no_code_input", finishedAt: new Date().toISOString(), timing };
      return;
    }
    const count = await digitInputs.count();
    stage = "fill_code";
    // Netflix auto-advances focus after each character, which makes
    // per-input .fill() calls race the DOM (the next input is briefly
    // not actionable). Focus the first input and type via keyboard so
    // auto-advance is handled the same way a real remote/keyboard would.
    try {
      await digitInputs.first().click({ timeout: Math.min(800, remaining()), force: true });
      // insertText only emits an input event. Netflix enables Continue from its
      // key-driven React state, so use real keyboard events for every digit.
      await page.keyboard.type(code, { delay: 18 });
      const enteredCode = await digitInputs.evaluateAll((inputs) => inputs
        .filter((input) => {
          if (!(input instanceof HTMLInputElement)) return false;
          const rect = input.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((input) => input.value)
        .join("")
        .replace(/\D/g, ""));
      if (enteredCode !== code) throw new Error("keyboard_input_incomplete");
    } catch {
      // Atomic fallback: update only the visible matched controls through the
      // native setter and dispatch the events React listens for. This avoids
      // eight serial Playwright actionability waits on Netflix's animated PIN
      // boxes while preserving the site's own state/update flow.
      const injected = await digitInputs.evaluateAll((inputs, value) => {
        const visible = inputs.filter((input) => {
          if (!(input instanceof HTMLInputElement)) return false;
          const rect = input.getBoundingClientRect();
          const style = getComputedStyle(input);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !input.disabled && !input.readOnly;
        });
        if (visible.length === 0) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) return false;
        const targets = visible.length >= 8 ? visible.slice(0, 8) : visible.slice(0, 1);
        targets.forEach((input, index) => {
          setter.call(input, targets.length === 1 ? value : value[index]);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: targets.length === 1 ? value : value[index] }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        targets.at(-1)?.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;
      }, code);
      if (!injected) throw new Error(`pin_injection_failed_visible_count_${count}`);
    }
    mark.fill = elapsed();

    stage = "submit_code";
    const submitReady = await page.waitForFunction(() => {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
      return candidates.some((element) => {
        const rect = element.getBoundingClientRect();
        const label = `${element.textContent || ""} ${element.getAttribute("value") || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("data-uia") || ""}`;
        const isSubmit = /enter code|continue|submit|tvsignup.*continue/i.test(label) || element.getAttribute("type") === "submit";
        const disabled = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
          ? element.disabled
          : element.getAttribute("aria-disabled") === "true";
        return isSubmit && !disabled && rect.width > 0 && rect.height > 0;
      });
    }, null, { timeout: Math.min(2200, remaining()) }).then(() => true).catch(() => false);
    if (submitReady) {
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
        const control = candidates.find((element) => {
          const rect = element.getBoundingClientRect();
          const label = `${element.textContent || ""} ${element.getAttribute("value") || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("data-uia") || ""}`;
          const isSubmit = /enter code|continue|submit|tvsignup.*continue/i.test(label) || element.getAttribute("type") === "submit";
          const disabled = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
            ? element.disabled
            : element.getAttribute("aria-disabled") === "true";
          return isSubmit && !disabled && rect.width > 0 && rect.height > 0;
        });
        if (!(control instanceof HTMLElement)) throw new Error("submit_button_missing");
        control.click();
      });
    } else {
      // Netflix variants sometimes submit the PIN form without rendering a
      // recognizable button. Enter follows the same native form path and does
      // not spend another actionability timeout.
      await page.keyboard.press("Enter");
    }
    mark.submit = elapsed();

    stage = "wait_netflix_result";
    let bodyText = "";
    const deadline = now() + Math.min(9000, remaining());
    while (now() < deadline) {
      await page.waitForTimeout(180);
      bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      if (/success|signed in|logged in|welcome|activated|linked|connected|invalid|incorrect|wrong|not recognized|try again|expired/i.test(bodyText)) break;
      if (!/\/tv8/i.test(page.url())) break;
    }
    mark.result = elapsed();

    let status = "error", result = "unknown", message = "Unable to determine result from page";
    if (/success|signed in|logged in|welcome|activated|linked|connected/i.test(bodyText) || !/\/tv8/i.test(page.url())) {
      status = "success"; result = "success"; message = "TV signed in successfully";
    } else if (/invalid|incorrect|wrong|couldn.?t|not recognized|try again/i.test(bodyText)) {
      status = "invalid_code"; result = "invalid_code"; message = "Netflix rejected the code";
    } else if (/expired|session|log ?in|sign ?in|password/i.test(bodyText)) {
      status = "cookies_expired"; result = "cookies_expired"; message = "Cookies appear to be expired";
    }

    const timing = `timing fetch=${mark.fetch}ms browser=${mark.browser}ms nav=${mark.nav}ms fill=${mark.fill}ms submit=${mark.submit}ms result=${mark.result}ms total=${elapsed()}ms`;
    await safeReport({ status, result, message: `${message} | ${timing}` });
    lastJob = { ...lastJob, status, result, finishedAt: new Date().toISOString(), timing };
  } catch (e) {
    if (reported) {
      console.error("post-report error", e instanceof Error ? e.message : String(e));
    } else {
      const message = e instanceof Error ? e.message : String(e);
      const timing = `timing total=${elapsed()}ms`;
      const result = /aborted due to timeout|timeout/i.test(message) ? "netflix_no_response" : "runner_error";
      const userMessage = result === "netflix_no_response"
        ? `Netflix did not respond cleanly during ${stage.replace(/_/g, " ")}`
        : `${message} (stage: ${stage})`;
      await safeReport({ status: "error", result, message: `${userMessage} | ${timing}` });
      lastJob = { ...lastJob, status: "error", result, finishedAt: new Date().toISOString(), error: userMessage, timing };
    }
  } finally {
    // Close the CONTEXT only. The browser stays warm.
    if (context) { try { await context.close(); } catch { /* pool context tied to dead browser */ } }
    activeJobs = Math.max(0, activeJobs - 1);
    // Top the pool back up for the next arrival.
    refillWarmPool().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/version")) {
      await ensureBrowser();
      return json(res, 200, {
        success: true,
        ok: true,
        version: SERVER_VERSION,
        package_version: PACKAGE_VERSION,
        commit: GIT_COMMIT || null,
        started_at: STARTED_AT,
        active_jobs: activeJobs,
        capacity: MAX_CONCURRENT,
        warm_pool: warmContexts.length,
        warm_pool_target: WARM_POOL_SIZE,
        browser_connected: !!(browser && browser.isConnected()),
        browser_relaunches: Math.max(0, browserRelaunchCount - 1),
        last_relaunch_at: lastRelaunchAt,
        max_ms: MAX_MS,
        env_max_ms: ENV_MAX_MS ? Number(ENV_MAX_MS) : null,
        schema: "v2",
        last_job: lastJob,
      });
    }
    if (req.method !== "POST" || req.url !== "/run") return json(res, 404, { success: false, error: "not_found" });
    if (activeJobs >= MAX_CONCURRENT) return json(res, 429, { success: false, error: "runner_at_capacity", message: "Fast runner is at capacity. Try again in a few seconds." });

    const body = await readJson(req);
    const eventId = String(body.event_id || "").trim();
    const runnerToken = String(body.runner_token || "").trim();
    if (!eventId || runnerToken.length < 32) return json(res, 400, { success: false, error: "bad_request" });

    activeJobs += 1;
    runTvJob(eventId, runnerToken).catch((e) => {
      console.error("job failed", e);
    });
    return json(res, 202, { success: true, status: "running", message: "Warm TV runner accepted the job." });
  } catch (e) {
    return json(res, 500, { success: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  await ensureBrowser();
  await refillWarmPool();
  console.log(`tv-fast-runner v${SERVER_VERSION} commit=${GIT_COMMIT || "unknown"} listening on :${PORT} max=${MAX_MS}ms env_max=${ENV_MAX_MS || "unset"} concurrency=${MAX_CONCURRENT} warm_pool=${WARM_POOL_SIZE}`);
});

// ── 24/7 keep-alive loop ───────────────────────────────────────────────
// Every 30s: verify browser is connected + pool is topped up. If Chromium
// silently died (e.g. renderer crash under memory pressure), this catches
// it BEFORE the next user hits /run.
setInterval(() => {
  if (shuttingDown) return;
  if (!browser || !browser.isConnected()) {
    console.log("[keepalive] browser missing/disconnected — relaunching");
    ensureBrowser().catch((e) => console.error("[keepalive] relaunch failed", e));
  } else if (warmContexts.length < WARM_POOL_SIZE) {
    refillWarmPool().catch(() => {});
  }
}, 30_000).unref();

// Log unhandled rejections rather than exit — systemd restart is expensive
// and we want to stay warm through transient noise.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack || reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err instanceof Error ? err.stack || err.message : err);
});

async function shutdown(signal) {
  shuttingDown = true;
  console.log(`received ${signal}; draining ${activeJobs} active job(s)…`);
  server.close(() => {});
  const deadline = Date.now() + Math.max(5000, MAX_MS * 2);
  while (activeJobs > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  // Close warm contexts first so browser.close() isn't racing them.
  for (const ctx of warmContexts.splice(0)) { try { await ctx.close(); } catch {} }
  try { await browser?.close?.(); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
