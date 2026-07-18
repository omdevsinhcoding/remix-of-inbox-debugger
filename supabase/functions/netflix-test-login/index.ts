// Netflix login test — SSE endpoint that streams live per-step logs while
// running a headless (no-browser) HTTP flow against Netflix, waits for the
// OTP mail to land in our cached_emails table, submits the code, and
// stores the resulting session cookies in netflix_sessions.
//
// Auth: admin session token (x-session-token), same verification pattern
// as email-html. Only meant for the "Test" profile / admin dashboard.
//
// Response: text/event-stream. Each event = one JSON log line
//   event: log        data: {"step":"STEP-2","msg":"POST /login","ts":"..."}
//   event: done       data: {"ok":true,"cookies":42}
//   event: error      data: {"error":"..."}

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
};

const NF_BASE = "https://www.netflix.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

async function verifyToken(token: string, secret: string): Promise<any | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, enc.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function jarToHeader(jar: Map<string, string>) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function collectCookies(res: Response, jar: Map<string, string>) {
  // deno-lint-ignore no-explicit-any
  const anyH: any = res.headers;
  const raw = typeof anyH.getSetCookie === "function" ? anyH.getSetCookie() : res.headers.get("set-cookie");
  const arr: string[] = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  for (const c of arr) {
    const first = c.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}
async function nfFetch(url: string, init: RequestInit | undefined, jar: Map<string, string>, maxRedirects = 5) {
  let currentUrl = url;
  let currentInit = init;
  for (let i = 0; i <= maxRedirects; i++) {
    const headers = new Headers(currentInit?.headers || {});
    headers.set("User-Agent", UA);
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    headers.set("Accept-Language", "en-US,en;q=0.9");
    if (jar.size > 0) headers.set("Cookie", jarToHeader(jar));
    const res = await fetch(currentUrl, { ...currentInit, headers, redirect: "manual" });
    collectCookies(res, jar);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || i === maxRedirects) return res;
      currentUrl = new URL(loc, currentUrl).toString();
      // After a redirect, drop POST body and switch to GET (standard behavior).
      currentInit = { method: "GET" };
      await res.body?.cancel();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}
function mask(email: string) {
  const [u, d] = email.split("@");
  return `${u.slice(0, 2)}•••@${d || ""}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: corsHeaders });

  const token = req.headers.get("x-session-token") || "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SIGNING = Deno.env.get("SESSION_SIGNING_SECRET") || SERVICE_ROLE;
  let session = await verifyToken(token, SIGNING);
  if (!session && SERVICE_ROLE !== SIGNING) session = await verifyToken(token, SERVICE_ROLE);
  if (!session?.userId) return new Response("unauthorized", { status: 401, headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);
  const { data: me } = await supabase.from("app_users").select("id, role, name").eq("id", session.userId).single();
  if (!me) return new Response("forbidden", { status: 403, headers: corsHeaders });

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const profileId = String(body?.profile_id || "").trim();
  const accountLabelIn = typeof body?.account_label === "string" ? body.account_label.trim() : "";
  if (!profileId) return new Response("profile_id required", { status: 400, headers: corsHeaders });

  // Allow: admin (any profile) OR the "test" profile testing itself.
  const isAdmin = me.role === "admin";
  const selfTest = me.id === profileId && String(me.name || "").toLowerCase() === "test";
  if (!isAdmin && !selfTest) return new Response("forbidden", { status: 403, headers: corsHeaders });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const log = (step: string, msg: string) => send("log", { step, msg, ts: new Date().toISOString() });

      try {
        // ── resolve profile → account → email ────────────────────────────
        log("BOOT", "Loading profile and account config…");
        const { data: profile, error: pErr } = await supabase
          .from("app_users").select("id, name, assigned_accounts").eq("id", profileId).single();
        if (pErr || !profile) throw new Error("profile not found");

        const { data: cfgRow } = await supabase.from("app_settings").select("value").eq("key", "email_accounts").maybeSingle();
        const { data: primaryRow } = await supabase.from("app_settings").select("value").eq("key", "config").maybeSingle();
        const accounts: any[] = Array.isArray(cfgRow?.value) ? cfgRow!.value : [];
        // Synthesize "Primary" account from the top-level config for parity with the app.
        const primaryUser = (primaryRow?.value as any)?.IMAP_USER;
        if (primaryUser) {
          accounts.unshift({ label: "Primary", user: primaryUser, recipientFilters: [] });
        }

        const assigned: string[] = Array.isArray(profile.assigned_accounts) ? profile.assigned_accounts : [];
        let chosenLabel = accountLabelIn || (assigned.length === 1 ? assigned[0] : "");
        if (!chosenLabel && assigned.length > 1) {
          throw new Error(`Multiple accounts assigned to profile — please pick one (${assigned.join(", ")})`);
        }
        if (!chosenLabel && assigned.length === 1) chosenLabel = assigned[0];
        if (!chosenLabel) throw new Error("no account assigned to this profile");

        const acc = accounts.find((a) => String(a.label).trim() === chosenLabel);
        if (!acc) throw new Error(`account "${chosenLabel}" not found in email_accounts`);
        const filter = Array.isArray(acc.recipientFilters) ? acc.recipientFilters.find(Boolean) : null;
        const email: string = (filter && String(filter).trim()) || String(acc.user).trim();
        log("BOOT", `Profile "${profile.name}" • Account "${chosenLabel}" • Email ${mask(email)}`);

        // ── Netflix flow ─────────────────────────────────────────────────
        const jar = new Map<string, string>();
        const triggerTs = new Date().toISOString();

        log("STEP-1", "GET https://www.netflix.com/login");
        const loginPage = await nfFetch(`${NF_BASE}/login`, {}, jar);
        const html = await loginPage.text();
        const authURL = html.match(/"authURL"\s*:\s*"([^"]+)"/)?.[1] || "";
        log("STEP-1", `status=${loginPage.status} cookies=${jar.size} authURL=${authURL ? "ok" : "MISSING"}`);
        if (!authURL) throw new Error("Netflix did not return authURL — IP may be bot-blocked");

        log("STEP-2", `POST /login  userLoginId=${mask(email)}`);
        const form = new URLSearchParams({
          userLoginId: email, password: "", rememberMe: "true",
          flow: "websiteSignUp", mode: "login", action: "loginAction",
          withFields: "userLoginId,password,rememberMe,nextPage,showPassword",
          authURL, nextPage: "", showPassword: "",
        });
        const sub = await nfFetch(`${NF_BASE}/login`, {
          method: "POST", body: form,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }, jar);
        log("STEP-2", `status=${sub.status}  location=${sub.headers.get("location") || "-"}  cookies=${jar.size}`);

        log("STEP-3", `Polling cached_emails for OTP  label="${chosenLabel}"  since=${triggerTs}`);
        let code = "";
        const pollStart = Date.now();
        while (Date.now() - pollStart < 90_000) {
          const { data: rows } = await supabase
            .from("cached_emails")
            .select("id, subject, preview, from, date")
            .eq("account_label", chosenLabel)
            .gt("date", triggerTs)
            .order("date", { ascending: false })
            .limit(5);
          for (const row of rows || []) {
            const from = String(row.from || "").toLowerCase();
            if (!from.includes("netflix")) continue;
            const m = `${row.subject || ""} ${row.preview || ""}`.match(/\b(\d{4}|\d{6}|\d{8})\b/);
            if (m) { code = m[1]; log("STEP-3", `OTP found  id=${row.id}  code=${code}`); break; }
          }
          if (code) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (!code) throw new Error("OTP not received within 90s");

        log("STEP-4", `POST OTP code=${code}`);
        const otpForm = new URLSearchParams({ code, authURL, action: "loginAction" });
        const otp = await nfFetch(`${NF_BASE}/login/help`, {
          method: "POST", body: otpForm,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }, jar);
        log("STEP-4", `status=${otp.status}  cookies=${jar.size}`);

        log("STEP-5", "Storing cookies in netflix_sessions");
        const cookies = jarToHeader(jar);
        const { error: upErr } = await supabase.from("netflix_sessions").upsert({
          email, account_label: chosenLabel, cookies_json: cookies,
          status: "active", last_login_at: new Date().toISOString(),
        }, { onConflict: "email" });
        if (upErr) throw new Error(`db upsert failed: ${upErr.message}`);

        log("DONE", `Session persisted (${jar.size} cookies)`);
        send("done", { ok: true, cookies: jar.size, email, account_label: chosenLabel });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send("error", { error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
