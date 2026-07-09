// Worker bootstrap endpoint — returns SUPABASE_URL, SUPABASE_KEY, SESSION_SECRET
// to the Cloudflare Workers Builds `setup.sh`.
//
// SECURITY MODEL (hardened — no TOFU):
//   1. Caller must send X-CF-Token header (Cloudflare API token). CF Builds
//      injects CLOUDFLARE_API_TOKEN at build time.
//   2. Caller must ALSO send X-Bootstrap-Secret header matching
//      WORKER_BOOTSTRAP_SECRET env var. This shared secret is stored in the
//      Cloudflare Worker's build env by the admin — an attacker with only a
//      leaked repo cannot obtain it.
//   3. We verify the CF token AND check the caller's CF account is in
//      app_settings.worker_account_allowlist. Unknown accounts are REJECTED
//      (no auto-add) and generate a Telegram alert. Admin must explicitly
//      add the account_id to the allowlist first.
//
// Previous TOFU behavior (auto-add first N accounts) leaked SESSION_SECRET
// to any Cloudflare account holder — removed.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cf-token, x-bootstrap-secret",
};

// Constant-time string compare to avoid timing oracles on the shared secret.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendTelegramAlert(text: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("[worker-bootstrap] telegram alert failed:", (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const cfToken = (req.headers.get("x-cf-token") || "").trim();
  if (!cfToken) {
    return json({ error: "Missing X-CF-Token header" }, 401);
  }

  // 0. Verify the shared bootstrap secret. Without this, ANY valid Cloudflare
  //    token holder could request our SESSION_SECRET. This secret is only
  //    known to the admin and to the Cloudflare Worker build environment.
  const expectedSecret = (Deno.env.get("WORKER_BOOTSTRAP_SECRET") || "").trim();
  if (!expectedSecret) {
    return json({ error: "Server not configured: WORKER_BOOTSTRAP_SECRET missing" }, 500);
  }
  const providedSecret = (req.headers.get("x-bootstrap-secret") || "").trim();
  if (!providedSecret || !timingSafeEqual(providedSecret, expectedSecret)) {
    await sendTelegramAlert(
      `🚫 worker-bootstrap: bad or missing X-Bootstrap-Secret from ${req.headers.get("cf-connecting-ip") || "unknown"}`,
    );
    return json({ error: "Invalid bootstrap secret" }, 403);
  }


  // 1. Verify the CF token is valid & active
  let verifyRes: any = null;
  try {
    const r = await fetch(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      { headers: { Authorization: `Bearer ${cfToken}` } },
    );
    verifyRes = await r.json();
  } catch (e) {
    return json({ error: "Could not reach Cloudflare API", detail: (e as Error).message }, 502);
  }
  if (!verifyRes?.success || verifyRes?.result?.status !== "active") {
    return json({ error: "Invalid or inactive Cloudflare API token", cf: verifyRes }, 403);
  }

  // 2. Get the account(s) this token can access
  let accountsRes: any = null;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: { Authorization: `Bearer ${cfToken}` },
    });
    accountsRes = await r.json();
  } catch (e) {
    return json({ error: "Could not list Cloudflare accounts", detail: (e as Error).message }, 502);
  }
  const accounts: Array<{ id: string; name: string }> = accountsRes?.result || [];
  if (!accounts.length) {
    return json({ error: "Token has no accessible accounts" }, 403);
  }
  // Use first account (CF Builds runs against one specific account)
  const account = accounts[0];

  // 3. Load allowlist from Supabase
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: "Server not configured" }, 500);
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: row } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "worker_account_allowlist")
    .maybeSingle();

  const list: Array<{ id: string; name: string; added_at: string }> =
    Array.isArray(row?.value) ? row.value : [];
  const known = list.find((x) => x.id === account.id);

  if (!known) {
    if (list.length >= MAX_TOFU_ACCOUNTS) {
      await sendTelegramAlert(
        `🚫 Worker bootstrap REJECTED — allowlist full.\n` +
        `Account: <code>${account.name}</code> (<code>${account.id}</code>)`,
      );
      return json({ error: "Account not in allowlist and cap reached. Contact admin." }, 403);
    }
    // Trust-on-first-use: add and alert
    const updated = [
      ...list,
      { id: account.id, name: account.name, added_at: new Date().toISOString() },
    ];
    await supabase
      .from("app_settings")
      .upsert({ key: "worker_account_allowlist", value: updated }, { onConflict: "key" });

    await sendTelegramAlert(
      `✅ New Cloudflare account added to worker allowlist (TOFU)\n` +
      `Name: <b>${account.name}</b>\n` +
      `ID: <code>${account.id}</code>\n` +
      `Slot ${updated.length}/${MAX_TOFU_ACCOUNTS} used`,
    );
  }

  // 4. Return the secrets the worker needs
  const SUPABASE_KEY =
    Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    "";
  const SESSION_SECRET =
    Deno.env.get("SESSION_SIGNING_SECRET") ||
    Deno.env.get("SESSION_SECRET") ||
    "";

  if (!SUPABASE_KEY || !SESSION_SECRET) {
    return json({
      error: "Server missing SUPABASE_KEY or SESSION_SECRET",
      missing: { SUPABASE_KEY: !SUPABASE_KEY, SESSION_SECRET: !SESSION_SECRET },
    }, 500);
  }

  return json({
    SUPABASE_URL,
    SUPABASE_KEY,
    SESSION_SECRET,
    account: { id: account.id, name: account.name, tofu: !known },
  });
});
