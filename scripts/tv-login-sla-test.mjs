#!/usr/bin/env node
// TV Login SLA test harness for the strict sub-10s direct runner path.
//
// Runs the flow N times by:
//   1. Selecting a saved-cookie IMAP account (or TV_TEST_IMAP_USER)
//   2. Inserting a synthetic public.tv_login_events row with a one-time runner token
//   3. Calling the warm VPS runner directly at POST /run (no GitHub Actions queue)
//   4. Polling tv_login_events until the runner reports a terminal state
//   5. Printing insert / runner accept / runner phase / app-observed totals
//
// Fails the process (exit 1) if ANY iteration app_total_ms >= SLA_MS (default 10_000).
//
// Required env:
//   SUPABASE_URL                 e.g. https://xxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    service-role key (server-side only, never ship)
//   TV_TEST_USER_ID              uuid of the app_user row to attribute events to
// Optional:
//   TV_FAST_RUNNER_URL           default http://140.238.226.213:8788
//   TV_TEST_IMAP_USER            IMAP account with saved Netflix cookies; auto-picks newest if absent
//   ITERATIONS                   default 3
//   SLA_MS                       default 10000
//   TV_TEST_CODE                 default 00000000 (invalid → Netflix rejects fast)

import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TV_TEST_USER_ID,
  TV_TEST_IMAP_USER = "",
  TV_FAST_RUNNER_URL = "http://140.238.226.213:8788",
  ITERATIONS = "3",
  SLA_MS = "10000",
  TV_TEST_CODE = "00000000",
} = process.env;

const missing = ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","TV_TEST_USER_ID"]
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing required env vars:", missing.join(", "));
  process.exit(2);
}

const iterations = Math.max(1, parseInt(ITERATIONS, 10) || 3);
const slaMs = Math.max(1000, parseInt(SLA_MS, 10) || 10_000);
const runnerUrl = (TV_FAST_RUNNER_URL.trim() || "http://140.238.226.213:8788").replace(/\/+$/g, "");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => `${(ms / 1000).toFixed(2)}s`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const mask = (value) => String(value || "").replace(/^(.{2}).*(@.*)$/, "$1•••$2");

function parseTiming(message = "") {
  const out = {};
  const timing = String(message).match(/timing\s+(.+)$/i)?.[1] || "";
  for (const part of timing.split(/\s+/)) {
    const m = part.match(/^([a-z_]+)=([0-9]+)ms$/i);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

async function pickImapUser() {
  if (TV_TEST_IMAP_USER.trim()) return TV_TEST_IMAP_USER.trim().toLowerCase();
  const { data, error } = await supabase
    .from("imap_cookies")
    .select("imap_user,count,updated_at")
    .gt("count", 0)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`cookie lookup failed: ${error.message}`);
  if (!data?.imap_user) throw new Error("No saved-cookie IMAP account found. Set TV_TEST_IMAP_USER or upload cookies first.");
  return String(data.imap_user).toLowerCase();
}

async function dispatch(eventId, runnerToken) {
  const t0 = Date.now();
  const res = await fetch(`${runnerUrl}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "tv-login-sla-test" },
    body: JSON.stringify({ event_id: eventId, runner_token: runnerToken }),
    signal: AbortSignal.timeout(Math.min(1800, slaMs - 500)),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`fast runner rejected job [${res.status}]: ${text.slice(0, 240)}`);
  }
  return { acceptMs: Date.now() - t0, body: text };
}

async function pollUntilDone(eventId, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("tv_login_events")
      .select("status,result,message,finished_at,created_at")
      .eq("id", eventId)
      .maybeSingle();
    if (error) throw new Error(`poll error: ${error.message}`);
    if (data) {
      if (!["queued", "running", "in_progress"].includes(data.status)) {
        return { row: data };
      }
    }
    await sleep(100);
  }
  return { row: null, timedOut: true };
}

async function runOnce(i, imapUser) {
  console.log(`\n── iteration ${i + 1}/${iterations} ──`);
  const submittedAt = Date.now();
  const runnerToken = randomBytes(32).toString("hex");
  const insertStart = Date.now();
  const { data: inserted, error: insErr } = await supabase
    .from("tv_login_events")
    .insert({
      user_id: TV_TEST_USER_ID,
      status: "running",
      code: TV_TEST_CODE,
      imap_user: imapUser,
      cookies_available: true,
      message: "sla-test",
      metadata: {
        source: "sla_synthetic_test",
        runnerMode: "direct",
        runnerTokenHash: sha256(runnerToken),
      },
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  const eventId = inserted.id;
  const insertMs = Date.now() - insertStart;

  const { acceptMs, body: acceptBody } = await dispatch(eventId, runnerToken);

  const { row, timedOut } = await pollUntilDone(eventId, slaMs + 1500);
  const finishedAt = Date.now();

  const totalMs = finishedAt - submittedAt;
  const timing = parseTiming(row?.message || "");
  const runnerTotalMs = Number.isFinite(timing.total) ? timing.total : null;
  const pollOverheadMs = runnerTotalMs == null ? null : Math.max(0, totalMs - insertMs - acceptMs - runnerTotalMs);

  const result = {
    eventId,
    status: row?.status || (timedOut ? "poll_timeout" : "unknown"),
    outcome: row?.result || "",
    message: row?.message || "",
    insert_ms: insertMs,
    runner_accept_ms: acceptMs,
    runner_total_ms: runnerTotalMs,
    poll_overhead_ms: pollOverheadMs,
    app_total_ms: totalMs,
    timing,
    within_sla: totalMs < slaMs,
  };

  console.log(`  event_id     : ${result.eventId}`);
  console.log(`  status       : ${result.status}  (${result.outcome})`);
  console.log(`  insert       : ${fmt(result.insert_ms)}`);
  console.log(`  runner accept: ${fmt(result.runner_accept_ms)}`);
  if (acceptBody) console.log(`  accept body  : ${acceptBody.slice(0, 120)}`);
  if (Object.keys(timing).length) {
    console.log(`  runner phases: ${Object.entries(timing).map(([k, v]) => `${k}=${fmt(v)}`).join("  ")}`);
  }
  if (result.poll_overhead_ms != null) console.log(`  poll overhead: ${fmt(result.poll_overhead_ms)}`);
  console.log(`  APP TOTAL    : ${fmt(result.app_total_ms)}  ${result.within_sla ? "✅" : "❌ over SLA"}`);
  if (result.message) console.log(`  message      : ${result.message.slice(0, 160)}`);
  return result;
}

(async () => {
  const imapUser = await pickImapUser();
  console.log(`TV login direct-runner SLA test — ${iterations} run(s), SLA < ${fmt(slaMs)}`);
  console.log(`Runner: ${runnerUrl}`);
  console.log(`IMAP: ${mask(imapUser)}`);
  const results = [];
  for (let i = 0; i < iterations; i++) {
    try {
      results.push(await runOnce(i, imapUser));
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      results.push({ error: e.message, app_total_ms: Infinity, within_sla: false });
    }
    if (i < iterations - 1) await sleep(1500);
  }

  const totals = results.map((r) => r.app_total_ms).filter((n) => Number.isFinite(n));
  const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
  const min = totals.length ? Math.min(...totals) : 0;
  const max = totals.length ? Math.max(...totals) : 0;
  const failures = results.filter((r) => !r.within_sla);

  console.log("\n══ Summary ══");
  console.log(`  runs      : ${results.length}`);
  console.log(`  min/avg/max: ${fmt(min)} / ${fmt(avg)} / ${fmt(max)}`);
  console.log(`  SLA       : < ${fmt(slaMs)}`);
  console.log(`  failures  : ${failures.length}`);

  if (failures.length) {
    console.error(`\n❌ SLA breach: ${failures.length}/${results.length} run(s) took >= ${fmt(slaMs)}`);
    process.exit(1);
  }
  console.log(`\n✅ All ${results.length} run(s) completed within SLA.`);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
