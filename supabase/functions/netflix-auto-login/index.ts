// Netflix Auto-Login — isolated test edge function.
// Actions:
//   list_accounts        (admin) → returns admin-configured email accounts
//   trigger              (admin) → forwards to external Playwright service
//   get_logs             (admin) → returns netflix_sessions rows for polling UI
//   set_status           (worker, x-worker-secret) → update session status
//   append_log           (worker) → push log entry
//   store_cookies        (worker) → persist cookies_json
//   get_otp              (worker) → poll cached_emails for OTP for that account
//
// Not wired to any user path. Safe to delete.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("NETFLIX_AUTOMATION_SECRET") || "";
const AUTOMATION_URL = Deno.env.get("NETFLIX_AUTOMATION_URL") || "";

const supa = createClient(SUPABASE_URL, SERVICE_KEY);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function isAdminReq(req: Request): Promise<boolean> {
  // Reuse the app_sessions cookie/header the admin panel already sends.
  const token = req.headers.get("x-session-token") || "";
  if (!token) return false;
  const { data } = await supa.from("app_sessions").select("user_id").eq("session_token", token).maybeSingle();
  if (!data?.user_id) return false;
  const { data: u } = await supa.from("app_users").select("role").eq("id", data.user_id).maybeSingle();
  return u?.role === "admin";
}

function isWorker(req: Request): boolean {
  return WORKER_SECRET.length > 0 && req.headers.get("x-worker-secret") === WORKER_SECRET;
}

async function loadAccounts(): Promise<Array<{ label: string; email: string }>> {
  const { data } = await supa.from("app_settings").select("value").eq("key", "email_accounts").maybeSingle();
  const list: Array<{ label: string; email: string }> = [];
  const primaryUser = Deno.env.get("IMAP_USER") || "";
  if (primaryUser) list.push({ label: "Primary", email: primaryUser });
  if (Array.isArray(data?.value)) {
    for (const a of data.value as any[]) {
      const email = String(a?.user || "").trim();
      const label = String(a?.label || email).trim();
      if (email && !list.find(x => x.email === email)) list.push({ label, email });
    }
  }
  return list;
}

async function appendLog(email: string, level: string, message: string) {
  const { data } = await supa.from("netflix_sessions").select("logs").eq("email", email).maybeSingle();
  const logs = Array.isArray(data?.logs) ? data!.logs : [];
  logs.push({ ts: new Date().toISOString(), level, message });
  const trimmed = logs.slice(-200);
  await supa.from("netflix_sessions").upsert({ email, logs: trimmed }, { onConflict: "email" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // ---- worker-only actions ----
    if (["set_status", "append_log", "store_cookies", "get_otp"].includes(action)) {
      if (!isWorker(req)) return json({ error: "unauthorized" }, 401);

      if (action === "set_status") {
        const patch: any = { email: body.email, status: body.status };
        if (body.accountLabel) patch.account_label = body.accountLabel;
        if (body.error) patch.last_error = body.error;
        if (body.status === "success") patch.last_login_at = new Date().toISOString();
        await supa.from("netflix_sessions").upsert(patch, { onConflict: "email" });
        return json({ ok: true });
      }
      if (action === "append_log") {
        await appendLog(String(body.email), String(body.level || "info"), String(body.message || ""));
        return json({ ok: true });
      }
      if (action === "store_cookies") {
        await supa.from("netflix_sessions").upsert({
          email: body.email,
          account_label: body.accountLabel || null,
          cookies_json: JSON.stringify(body.cookies || []),
        }, { onConflict: "email" });
        return json({ ok: true });
      }
      if (action === "get_otp") {
        const label = String(body.accountLabel || "Primary");
        const since = body.sinceISO ? new Date(body.sinceISO).toISOString() : new Date(Date.now() - 5 * 60_000).toISOString();
        const { data } = await supa.from("cached_emails")
          .select("id, otp, subject, date, account_label")
          .eq("account_label", label)
          .gte("date", since)
          .not("otp", "is", null)
          .order("date", { ascending: false })
          .limit(1);
        const otp = data?.[0]?.otp || null;
        return json({ otp });
      }
    }

    // ---- admin-only actions ----
    if (!(await isAdminReq(req))) return json({ error: "unauthorized" }, 401);

    if (action === "list_accounts") {
      const accounts = await loadAccounts();
      const { data: sessions } = await supa.from("netflix_sessions").select("email, status, last_error, last_login_at");
      const byEmail = new Map((sessions || []).map(s => [s.email, s]));
      return json({
        accounts: accounts.map(a => ({ ...a, session: byEmail.get(a.email) || null })),
        automation_url_configured: !!AUTOMATION_URL,
      });
    }

    if (action === "get_logs") {
      const email = String(body.email || "");
      const { data } = await supa.from("netflix_sessions").select("email, status, last_error, logs, last_login_at").eq("email", email).maybeSingle();
      return json({ session: data || null });
    }

    if (action === "trigger") {
      if (!AUTOMATION_URL) return json({ error: "NETFLIX_AUTOMATION_URL not configured" }, 400);
      const email = String(body.email || "");
      const accountLabel = String(body.accountLabel || "Primary");
      if (!email) return json({ error: "email required" }, 400);

      // reset log/status
      await supa.from("netflix_sessions").upsert({
        email, account_label: accountLabel, status: "queued", last_error: null, logs: [{ ts: new Date().toISOString(), level: "info", message: "Queued" }],
      }, { onConflict: "email" });

      // fire-and-forget to worker
      fetch(`${AUTOMATION_URL.replace(/\/$/, "")}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-secret": WORKER_SECRET },
        body: JSON.stringify({ email, accountLabel }),
      }).catch(async (e) => { await appendLog(email, "error", `Worker unreachable: ${e?.message || e}`); });

      return json({ ok: true, queued: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: (err as Error)?.message || "server error" }, 500);
  }
});
