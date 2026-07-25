// VPS watchdog — pings the TV fast runner health endpoint on a schedule and:
//   - alerts Telegram on transition down/up
//   - auto-flips vps_config.mode to "github" when the runner is unhealthy so
//     users never see failures (and restores to prior mode when it recovers)
//   - records last_check state in app_settings/vps_watchdog_state for the UI
//
// Trigger via pg_cron every minute. Also callable manually with a shared secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const HEALTH_TIMEOUT_MS = 6000;
const CONSECUTIVE_FAIL_THRESHOLD = 2; // 2 consecutive failures (~2 min) before auto-flip

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function effectiveUrl(cfg: any): string {
  const runnerUrl = String(cfg?.runnerUrl || "").trim().replace(/\/+$/g, "");
  if (runnerUrl) return runnerUrl;
  const env = (Deno.env.get("TV_FAST_RUNNER_URL") || "").trim().replace(/\/+$/g, "");
  if (env) return env;
  const ip = String(cfg?.ip || "").trim();
  return ip ? `http://${ip}:8788` : "";
}

async function sendTelegram(text: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        text,
      }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    // best-effort
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // JWT verification is enforced by the Supabase runtime (this function
  // uses the default verify_jwt = true), so any request that reaches this
  // handler has already presented a valid apikey/JWT. An optional
  // x-cron-secret header lets us also gate manual invocations if desired.
  const cronSecret = Deno.env.get("CRON_SHARED_SECRET") || "";
  const provided = req.headers.get("x-cron-secret") || "";
  if (cronSecret && provided && provided !== cronSecret) {
    return json(401, { success: false, error: "unauthorized" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Load current vps_config and prior watchdog state.
  const [{ data: vpsRow }, { data: stateRow }] = await Promise.all([
    readSettingRow(supabase, "vps_config"),
    readSettingRow(supabase, "vps_watchdog_state"),
  ]);

  const vpsCfg = (vpsRow?.value || {}) as Record<string, any>;
  const url = effectiveUrl(vpsCfg);
  const prevState = (stateRow?.value || {}) as Record<string, any>;
  const prevOk: boolean = !!prevState.ok;
  const prevFails: number = Number(prevState.consecutive_fails || 0);
  const prevMode: string = String(prevState.previous_mode || vpsCfg.mode || "auto");

  if (!url) {
    return json(200, { success: true, skipped: "no_runner_url" });
  }

  let ok = false;
  let status = 0;
  let latencyMs = 0;
  let bodySnippet = "";
  let health: any = null;
  const started = Date.now();
  try {
    const r = await fetch(`${url}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    latencyMs = Date.now() - started;
    status = r.status;
    const txt = await r.text().catch(() => "");
    bodySnippet = txt.slice(0, 400);
    try { health = txt ? JSON.parse(txt) : null; } catch {}
    ok = r.ok && !!health?.ok;
  } catch (e: any) {
    latencyMs = Date.now() - started;
    bodySnippet = String(e?.message || e).slice(0, 200);
    ok = false;
  }

  const consecutiveFails = ok ? 0 : prevFails + 1;
  let autoFlipped = false;
  let autoRestored = false;
  let nextMode = String(vpsCfg.mode || "auto");

  // Auto-flip to github if runner has been down for >= threshold and we're
  // currently pointing traffic at the VPS.
  if (!ok && consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD && nextMode !== "github") {
    const rememberMode = nextMode;
    nextMode = "github";
    await supabase.from("app_settings").upsert(
      { key: "vps_config", value: { ...vpsCfg, mode: "github" } },
      { onConflict: "key" },
    );
    autoFlipped = true;
    await sendTelegram(
      `⚠️ <b>VPS runner unhealthy</b>\n` +
      `Runner: <code>${url}</code>\n` +
      `Consecutive fails: ${consecutiveFails}\n` +
      `Auto-switched TV login mode: <b>${rememberMode} → github</b>\n` +
      `Users are unaffected — GitHub Actions is handling logins.`
    );
    prevState.previous_mode = rememberMode;
  }

  // Auto-restore mode when the runner recovers, only if we were the ones
  // who flipped it (previous_mode is tracked in watchdog state).
  if (ok && !prevOk && prevState.auto_flipped && prevState.previous_mode && prevState.previous_mode !== "github" && nextMode === "github") {
    nextMode = String(prevState.previous_mode);
    await supabase.from("app_settings").upsert(
      { key: "vps_config", value: { ...vpsCfg, mode: nextMode } },
      { onConflict: "key" },
    );
    autoRestored = true;
    await sendTelegram(
      `✅ <b>VPS runner recovered</b>\n` +
      `Runner: <code>${url}</code>\n` +
      `Latency: ${latencyMs}ms\n` +
      `Restored TV login mode: <b>github → ${nextMode}</b>`
    );
  }

  // Alert on first transition to down (before we've hit the flip threshold),
  // so ops sees it fast.
  if (!ok && prevOk) {
    await sendTelegram(
      `🔴 <b>VPS runner check failed</b>\n` +
      `Runner: <code>${url}</code>\n` +
      `HTTP: ${status}, latency: ${latencyMs}ms\n` +
      `Body: <code>${bodySnippet.replace(/</g, "&lt;").slice(0, 200)}</code>\n` +
      `Will auto-flip to GitHub after ${CONSECUTIVE_FAIL_THRESHOLD} consecutive failures.`
    );
  }

  const nextState = {
    ok,
    status,
    latency_ms: latencyMs,
    checked_at: new Date().toISOString(),
    url,
    consecutive_fails: consecutiveFails,
    version: health?.version || null,
    active_jobs: health?.active_jobs ?? null,
    capacity: health?.capacity ?? null,
    auto_flipped: autoFlipped || (prevState.auto_flipped && !autoRestored),
    previous_mode: autoFlipped ? prevState.previous_mode : (autoRestored ? null : prevState.previous_mode || null),
    last_error: ok ? null : bodySnippet,
  };
  await supabase.from("app_settings").upsert(
    { key: "vps_watchdog_state", value: nextState },
    { onConflict: "key" },
  );

  return json(200, {
    success: true,
    ok,
    status,
    latency_ms: latencyMs,
    url,
    version: health?.version || null,
    active_jobs: health?.active_jobs ?? null,
    capacity: health?.capacity ?? null,
    consecutive_fails: consecutiveFails,
    auto_flipped: autoFlipped,
    auto_restored: autoRestored,
    mode: nextMode,
  });
});
