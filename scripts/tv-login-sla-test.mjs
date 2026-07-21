#!/usr/bin/env node
// TV Login SLA test harness.
//
// Runs the end-to-end TV login flow N times by:
//   1. Inserting a synthetic row into public.tv_login_events (status=running)
//   2. Dispatching the tv-login workflow via GitHub `repository_dispatch`
//   3. Polling tv_login_events until status leaves running/queued
//   4. Recording dispatch_ms, queue_ms, run_ms, total_ms
//
// Fails the process (exit 1) if ANY iteration total >= SLA_MS (default 10_000).
//
// Required env:
//   SUPABASE_URL                 e.g. https://xxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    service-role key (server-side only, never ship)
//   GITHUB_PAT                   PAT with actions:write on the repo
//   GITHUB_REPO                  owner/repo
//   TV_TEST_USER_ID              uuid of the app_user row to attribute events to
// Optional:
//   ITERATIONS                   default 3
//   SLA_MS                       default 10000
//   TV_TEST_CODE                 default 00000000 (invalid → Netflix rejects fast)

import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GITHUB_PAT,
  GITHUB_REPO,
  TV_TEST_USER_ID,
  ITERATIONS = "3",
  SLA_MS = "10000",
  TV_TEST_CODE = "00000000",
} = process.env;

const missing = ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","GITHUB_PAT","GITHUB_REPO","TV_TEST_USER_ID"]
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing required env vars:", missing.join(", "));
  process.exit(2);
}

const iterations = Math.max(1, parseInt(ITERATIONS, 10) || 3);
const slaMs = Math.max(1000, parseInt(SLA_MS, 10) || 10_000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const ghHeaders = {
  Authorization: `Bearer ${GITHUB_PAT}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
  "User-Agent": "tv-login-sla-test",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => `${(ms / 1000).toFixed(2)}s`;

async function dispatch(eventId) {
  const t0 = Date.now();
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: ghHeaders,
    body: JSON.stringify({
      event_type: "tv-login",
      client_payload: { event_id: eventId, ts: Date.now() },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`dispatch failed [${res.status}]: ${text.slice(0, 200)}`);
  }
  return Date.now() - t0;
}

async function pollUntilDone(eventId, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let firstRunningAt = null;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("tv_login_events")
      .select("status,result,message,started_at,finished_at,created_at")
      .eq("id", eventId)
      .maybeSingle();
    if (error) throw new Error(`poll error: ${error.message}`);
    if (data) {
      if (!firstRunningAt && ["running", "in_progress"].includes(data.status)) {
        firstRunningAt = Date.now();
      }
      if (!["queued", "running", "in_progress"].includes(data.status)) {
        return { row: data, firstRunningAt };
      }
    }
    await sleep(250);
  }
  return { row: null, firstRunningAt, timedOut: true };
}

async function runOnce(i) {
  console.log(`\n── iteration ${i + 1}/${iterations} ──`);
  const submittedAt = Date.now();
  const { data: inserted, error: insErr } = await supabase
    .from("tv_login_events")
    .insert({
      user_id: TV_TEST_USER_ID,
      status: "running",
      code_last4: TV_TEST_CODE.slice(-4),
      message: "sla-test",
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  const eventId = inserted.id;

  const dispatchMs = await dispatch(eventId);
  const dispatchedAt = Date.now();

  const { row, firstRunningAt, timedOut } = await pollUntilDone(eventId, slaMs * 3);
  const finishedAt = Date.now();

  const totalMs = finishedAt - submittedAt;
  const queueMs = firstRunningAt ? firstRunningAt - dispatchedAt : (finishedAt - dispatchedAt);
  const runMs = firstRunningAt ? finishedAt - firstRunningAt : 0;

  const result = {
    eventId,
    status: row?.status || (timedOut ? "poll_timeout" : "unknown"),
    outcome: row?.result || "",
    message: row?.message || "",
    dispatch_ms: dispatchMs,
    queue_ms: queueMs,
    run_ms: runMs,
    total_ms: totalMs,
    within_sla: totalMs < slaMs,
  };

  console.log(`  event_id     : ${result.eventId}`);
  console.log(`  status       : ${result.status}  (${result.outcome})`);
  console.log(`  dispatch     : ${fmt(result.dispatch_ms)}`);
  console.log(`  queue→run    : ${fmt(result.queue_ms)}`);
  console.log(`  run→finish   : ${fmt(result.run_ms)}`);
  console.log(`  TOTAL        : ${fmt(result.total_ms)}  ${result.within_sla ? "✅" : "❌ over SLA"}`);
  if (result.message) console.log(`  message      : ${result.message.slice(0, 160)}`);
  return result;
}

(async () => {
  console.log(`TV login SLA test — ${iterations} run(s), SLA < ${fmt(slaMs)}`);
  const results = [];
  for (let i = 0; i < iterations; i++) {
    try {
      results.push(await runOnce(i));
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      results.push({ error: e.message, total_ms: Infinity, within_sla: false });
    }
    if (i < iterations - 1) await sleep(1500);
  }

  const totals = results.map((r) => r.total_ms).filter((n) => Number.isFinite(n));
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
