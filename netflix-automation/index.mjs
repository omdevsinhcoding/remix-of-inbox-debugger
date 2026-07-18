// Netflix Auto-Login Test Service — headless Playwright, no visible browser.
// Isolated: not wired into any production path. Removing this folder is safe.
import express from "express";
import { chromium } from "playwright";
import "dotenv/config";

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.NETFLIX_AUTOMATION_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NETFLIX_AUTOMATION_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// -------- helpers --------
async function callEdge(action, payload) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/netflix-auto-login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey": SUPABASE_KEY,
      "x-worker-secret": SECRET,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  return r.json();
}

async function appendLog(email, level, message) {
  console.log(`[${email}] ${level}: ${message}`);
  await callEdge("append_log", { email, level, message }).catch(() => {});
}

async function pollForOtp(email, accountLabel, sentAtISO, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await callEdge("get_otp", { email, accountLabel, sinceISO: sentAtISO });
    if (res?.otp) return String(res.otp);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for OTP in cached_emails");
}

// -------- Netflix flow (headless) --------
async function runNetflixLogin(email, accountLabel) {
  await appendLog(email, "info", "Launching headless Chromium");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  const sentAt = new Date().toISOString();

  try {
    await appendLog(email, "info", "Navigating to netflix.com/login");
    await page.goto("https://www.netflix.com/login", { waitUntil: "domcontentloaded", timeout: 45_000 });

    const emailSel = "input[name='userLoginId'], input#id_userLoginId, input[type='email']";
    await page.waitForSelector(emailSel, { timeout: 15_000 });
    await page.fill(emailSel, email);
    await appendLog(email, "info", `Filled email: ${email}`);

    const submitSel = "button[data-uia='login-submit-button'], button[type='submit']";
    await page.click(submitSel);
    await appendLog(email, "info", "Submitted email — waiting for Netflix response");

    await page.waitForTimeout(3500);
    const url = page.url();
    const source = (await page.content()).toLowerCase();

    if (source.includes("password")) {
      await appendLog(email, "warn", "Netflix asked for password (no OTP path). Skipping — cannot proceed without stored credentials.");
      return { success: false, error: "password_required" };
    }

    if (url.includes("code") || source.includes("verify") || source.includes("enter the code")) {
      await appendLog(email, "info", "OTP page detected — polling inbox for code");
      const otp = await pollForOtp(email, accountLabel, sentAt);
      await appendLog(email, "info", `OTP received: ${otp.replace(/.(?=.{2})/g, "•")}`);

      // Netflix uses 4–8 individual boxes; try both single-input and multi-box.
      const singleInput = await page.$("input[type='tel'], input[name='otp']");
      if (singleInput) {
        await singleInput.fill(otp);
      } else {
        const boxes = await page.$$("input[maxlength='1']");
        for (let i = 0; i < boxes.length && i < otp.length; i++) {
          await boxes[i].fill(otp[i]);
        }
      }
      const nextBtn = await page.$("button[type='submit'], button[data-uia*='submit']");
      if (nextBtn) await nextBtn.click();
      await page.waitForTimeout(4000);
      await appendLog(email, "info", "OTP submitted");
    } else {
      await appendLog(email, "warn", `Unknown page state at ${url}`);
    }

    const cookies = await context.cookies();
    await appendLog(email, "info", `Captured ${cookies.length} cookies`);
    return { success: true, cookies };
  } finally {
    await browser.close().catch(() => {});
  }
}

// -------- routes --------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/login", async (req, res) => {
  if ((req.headers["x-secret"] || "") !== SECRET) {
    return res.status(401).json({ error: "bad secret" });
  }
  const { email, accountLabel } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    await callEdge("set_status", { email, status: "running", accountLabel });
    const out = await runNetflixLogin(String(email), String(accountLabel || "Primary"));
    if (out.success) {
      await callEdge("store_cookies", { email, accountLabel, cookies: out.cookies });
      await callEdge("set_status", { email, status: "success" });
    } else {
      await callEdge("set_status", { email, status: "failed", error: out.error });
    }
    res.json(out);
  } catch (err) {
    const msg = err?.message || String(err);
    await appendLog(email, "error", msg);
    await callEdge("set_status", { email, status: "failed", error: msg });
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => console.log(`Netflix automation service listening on :${PORT}`));
