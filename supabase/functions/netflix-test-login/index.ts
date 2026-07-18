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

function htmlText(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlAttr(input: string) {
  return input
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractAuthURL(html: string) {
  return decodeHtmlAttr(
    (html.match(/"authURL"\s*:\s*"([^"]+)"/) || html.match(/name=["']authURL["'][^>]*value=["']([^"']+)["']/i))?.[1] || "",
  );
}

function hiddenInputsToForm(html: string) {
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/\bname=["']([^"']+)["']/i)?.[1] || "").trim();
    if (!name) continue;
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] || "";
    form.set(name, decodeHtmlAttr(value));
  }
  return form;
}

function extractNetflixMessage(html: string) {
  const jsonMessage = html.match(/"(?:errorMessage|message|uiMessage)"\s*:\s*"([^"]{4,260})"/i)?.[1];
  if (jsonMessage) return jsonMessage.replace(/\\u002F/g, "/").replace(/\\n/g, " ");
  const classMessage = html.match(/class="[^"]*(?:ui-message-contents|error|message)[^"]*"[^>]*>([\s\S]{4,500}?)<\//i)?.[1];
  if (classMessage) return htmlText(classMessage).slice(0, 260);
  return "";
}

function inferNetflixLoginState(html: string, url: string) {
  const text = htmlText(html).toLowerCase();
  const hasPasswordField = /name="password"|id="id_password"|type="password"/i.test(html);
  const hasCodeField = /name="(?:code|otp|pin)"|enter (?:this|the) code|verification code|sign[\s-]?in code/i.test(html) || /code/.test(url);
  const asksPassword = hasPasswordField || /enter your password|password is required|sign in with password/i.test(text);
  const asksOtp = hasCodeField || /we sent (?:a )?code|check your email|enter the code/i.test(text);
  if (asksOtp) return "otp_challenge";
  if (asksPassword) return "password_required";
  return "unknown";
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
        const accounts: any[] = Array.isArray(cfgRow?.value) ? [...cfgRow!.value] : [];
        // Synthesize/merge the top-level Primary IMAP account without hiding the
        // saved Primary recipient filters. Recipient-filter login email must win.
        const primaryUser = (primaryRow?.value as any)?.IMAP_USER;
        if (primaryUser) {
          const primaryIdx = accounts.findIndex((a) => String(a?.label || "").trim() === "Primary");
          if (primaryIdx >= 0) {
            accounts[primaryIdx] = { ...accounts[primaryIdx], user: accounts[primaryIdx]?.user || primaryUser };
          } else {
            accounts.unshift({ label: "Primary", user: primaryUser, recipientFilters: [] });
          }
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
        const recipientFilters = Array.isArray(acc.recipientFilters)
          ? acc.recipientFilters.map((r: unknown) => String(r || "").trim()).filter(Boolean)
          : [];
        const filter = recipientFilters.find(Boolean) || null;
        const email: string = (filter && String(filter).trim()) || String(acc.user).trim();
        const sameMailboxLabels = accounts
          .filter((a) => String(a.user || "").trim().toLowerCase() === String(acc.user || "").trim().toLowerCase())
          .map((a) => String(a.label || "").trim())
          .filter(Boolean);
        const pollLabels = Array.from(new Set([chosenLabel, ...sameMailboxLabels]));
        log("BOOT", `Profile "${profile.name}" • Account "${chosenLabel}" • Email ${email}`);
        if (filter) log("BOOT", `Using recipient-filter login email ${email} for account "${chosenLabel}"`);
        if (pollLabels.length > 1) log("BOOT", `Will poll same IMAP mailbox labels too: ${pollLabels.join(", ")}`);

        // ── load optional stored Netflix password for this email ────────
        // Admins can configure these in Admin panel → TV Auto-Login → Netflix
        // Credentials. When Netflix asks for a password (no OTP), we submit it
        // automatically instead of failing.
        const { data: credRow } = await supabase
          .from("app_settings").select("value").eq("key", "netflix_credentials").maybeSingle();
        const credMap: Record<string, string> = (credRow?.value && typeof credRow.value === "object" && !Array.isArray(credRow.value))
          ? credRow.value as Record<string, string> : {};
        const linkedEmails = new Set<string>();
        linkedEmails.add(email.toLowerCase());
        if (acc.user) linkedEmails.add(String(acc.user).trim().toLowerCase());
        for (const r of recipientFilters) linkedEmails.add(r.toLowerCase());
        for (const a of accounts) {
          if (String(a.user || "").trim().toLowerCase() !== String(acc.user || "").trim().toLowerCase()) continue;
          if (a.user) linkedEmails.add(String(a.user).trim().toLowerCase());
          for (const r of (Array.isArray(a.recipientFilters) ? a.recipientFilters : [])) {
            const val = String(r || "").trim().toLowerCase();
            if (val) linkedEmails.add(val);
          }
        }
        const credentialEmail = [...linkedEmails].find((candidate) => typeof credMap[candidate] === "string" && String(credMap[candidate]).length > 0) || "";
        const storedPassword = String(credentialEmail ? credMap[credentialEmail] : "").trim();
        log("BOOT", `Netflix password on file for ${email}: ${storedPassword ? `yes (${storedPassword.length} chars, matched ${credentialEmail === email.toLowerCase() ? "selected email" : credentialEmail})` : `no (checked ${linkedEmails.size} linked email key${linkedEmails.size === 1 ? "" : "s"})`}`);

        // ── Netflix flow ─────────────────────────────────────────────────
        const jar = new Map<string, string>();
        const triggerTs = new Date().toISOString();

        log("STEP-1", "GET https://www.netflix.com/login");
        const loginPage = await nfFetch(`${NF_BASE}/login`, {}, jar);
        const html = await loginPage.text();
        const authURL = extractAuthURL(html);
        log("STEP-1", `finalUrl=${loginPage.url}  status=${loginPage.status}  bytes=${html.length}  cookies=${jar.size}  authURL=${authURL ? "ok" : "MISSING"}`);
        if (!authURL) {
          const snippet = html.slice(0, 300).replace(/\s+/g, " ");
          throw new Error(`Netflix did not return authURL. First 300 chars: ${snippet}`);
        }

        const persistSession = async (method: "password" | "otp") => {
          log("STEP-5", "Storing cookies in netflix_sessions");
          const cookies = jarToHeader(jar);
          const { error: upErr } = await supabase.from("netflix_sessions").upsert({
            email, account_label: chosenLabel, cookies_json: cookies,
            status: "active", last_login_at: new Date().toISOString(),
          }, { onConflict: "email" });
          if (upErr) throw new Error(`db upsert failed: ${upErr.message}`);
          log("DONE", `Session persisted (${jar.size} cookies) via ${method} login`);
          send("done", { ok: true, cookies: jar.size, email, account_label: chosenLabel, method });
        };

        const useDirectPassword = storedPassword.length > 0;
        log("STEP-2", `POST /login  userLoginId="${email}"  password=${useDirectPassword ? "(from admin panel)" : "(empty — expecting OTP flow)"}`);
        const form = new URLSearchParams({
          userLoginId: email, password: storedPassword, rememberMe: "true",
          flow: "websiteSignUp", mode: "login", action: "loginAction",
          withFields: "userLoginId,password,rememberMe,nextPage,showPassword",
          authURL, nextPage: "", showPassword: "",
        });
        const sub = await nfFetch(`${NF_BASE}/login`, {
          method: "POST", body: form,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": loginPage.url || `${NF_BASE}/login`,
            "Origin": NF_BASE,
          },
        }, jar);
        let subBody = await sub.text().catch(() => "");
        let netflixMessage = extractNetflixMessage(subBody);
        let loginState = inferNetflixLoginState(subBody, sub.url || "");
        let authCookieHit = jar.has("NetflixId") || jar.has("SecureNetflixId");
        log("STEP-2", `status=${sub.status}  finalUrl=${sub.url}  cookies=${jar.size}  bytes=${subBody.length}  authCookies=${authCookieHit ? "yes" : "no"}`);
        log("STEP-2", `Netflix login state detected: ${loginState}`);
        if (netflixMessage) log("STEP-2", `Netflix said: ${netflixMessage.slice(0, 220)}`);
        else log("STEP-2", `body preview: ${subBody.slice(0, 250).replace(/\s+/g, " ")}`);

        // Some Netflix regions ignore password on the first email POST and render
        // a second password form. If Admin saved a password, submit that real
        // password screen too before deciding the credential is bad.
        if (useDirectPassword && !authCookieHit && loginState === "password_required") {
          const retryAuthURL = extractAuthURL(subBody) || authURL;
          const retryForm = hiddenInputsToForm(subBody);
          retryForm.set("userLoginId", email);
          retryForm.set("password", storedPassword);
          retryForm.set("rememberMe", "true");
          retryForm.set("authURL", retryAuthURL);
          if (!retryForm.has("flow")) retryForm.set("flow", "websiteSignUp");
          if (!retryForm.has("mode")) retryForm.set("mode", "login");
          if (!retryForm.has("action")) retryForm.set("action", "loginAction");
          if (!retryForm.has("withFields")) retryForm.set("withFields", "userLoginId,password,rememberMe,nextPage,showPassword");
          log("STEP-2B", `Password form detected — retrying with saved password for ${email}  authURL=${retryAuthURL ? "ok" : "missing"}`);
          const retry = await nfFetch(sub.url || `${NF_BASE}/login`, {
            method: "POST", body: retryForm,
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Referer": sub.url || loginPage.url || `${NF_BASE}/login`,
              "Origin": NF_BASE,
            },
          }, jar);
          subBody = await retry.text().catch(() => "");
          netflixMessage = extractNetflixMessage(subBody);
          loginState = inferNetflixLoginState(subBody, retry.url || "");
          authCookieHit = jar.has("NetflixId") || jar.has("SecureNetflixId");
          log("STEP-2B", `status=${retry.status}  finalUrl=${retry.url}  cookies=${jar.size}  bytes=${subBody.length}  authCookies=${authCookieHit ? "yes" : "no"}`);
          log("STEP-2B", `Netflix login state detected: ${loginState}`);
          if (netflixMessage) log("STEP-2B", `Netflix said: ${netflixMessage.slice(0, 220)}`);
          else log("STEP-2B", `body preview: ${subBody.slice(0, 250).replace(/\s+/g, " ")}`);
        }

        // Password-based success shortcut: if we submitted a password AND Netflix
        // set the auth cookie / redirected to /browse, skip OTP entirely.
        if (useDirectPassword && (authCookieHit || /\/(browse|profiles)/.test(sub.url || ""))) {
          log("STEP-3", "Password login accepted — skipping OTP polling.");
          await persistSession("password");
          return;
        }

        if (loginState === "password_required") {
          if (useDirectPassword) {
            throw new Error(`Netflix rejected the stored password for ${email}. Update it on the separate TV Auto-Login page → Netflix Vault, then retry.`);
          }
          throw new Error(`Netflix wants a password for ${email} instead of sending an OTP, but no saved password matched this selected/linked email. Add it on the separate TV Auto-Login page → Netflix Vault, then retry.`);
        }

        // Kick off IMAP sync so the OTP mail lands in cached_emails ASAP.
        log("STEP-3", "Triggering IMAP sync via fetch-emails…");
        try {
          const syncRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/fetch-emails`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-cron-secret": Deno.env.get("CRON_SHARED_SECRET") || "" },
            body: JSON.stringify({ mode: "sync", source: "netflix-test-login", accountLabels: pollLabels }),
          });
          const syncText = await syncRes.text().catch(() => "");
          let syncSummary = syncText.slice(0, 350).replace(/\s+/g, " ");
          try {
            const parsed = JSON.parse(syncText);
            syncSummary = `success=${parsed.success} totalFetched=${parsed.totalFetched ?? 0} inserted=${parsed.inserted ?? 0} warning=${parsed.warning || "-"}`;
          } catch { /* keep text summary */ }
          log("STEP-3", `IMAP sync trigger → status=${syncRes.status} ${syncSummary}`);
        } catch (e) {
          log("STEP-3", `sync trigger failed (continuing anyway): ${e instanceof Error ? e.message : String(e)}`);
        }

        log("STEP-3", `Polling latest Netflix mail  label="${chosenLabel}"  since=${triggerTs}`);
        let code = "";
        let matchedId = "";
        const pollStart = Date.now();
        let ticks = 0;
        while (Date.now() - pollStart < 90_000) {
          ticks++;
          // Re-trigger sync every ~10s so new mail is pulled from IMAP.
          if (ticks > 1 && ticks % 5 === 0) {
            fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/fetch-emails`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-cron-secret": Deno.env.get("CRON_SHARED_SECRET") || "" },
              body: JSON.stringify({ mode: "sync", source: "netflix-test-login-tick", accountLabels: pollLabels }),
            }).then((r) => r.text()).then((txt) => {
              try {
                const parsed = JSON.parse(txt);
                log("STEP-3", `background IMAP tick → success=${parsed.success} totalFetched=${parsed.totalFetched ?? 0} inserted=${parsed.inserted ?? 0}`);
              } catch { /* ignore */ }
            }).catch(() => {});
          }
          const { data: rows, error: pollErr } = await supabase
            .from("cached_emails")
            .select("id, subject, preview, html, from_address, to_address, otp, date")
            .in("account_label", pollLabels)
            .gt("date", triggerTs)
            .order("date", { ascending: false })
            .limit(10);
          if (pollErr) {
            log("STEP-3", `DB poll error: ${pollErr.message}`);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          if (rows && rows.length > 0 && ticks % 3 === 1) {
            log("STEP-3", `tick #${ticks} → ${rows.length} row(s) since trigger. Latest: "${(rows[0].subject || "").slice(0, 80)}" from ${String(rows[0].from_address || "").slice(0, 80)} to ${String(rows[0].to_address || "").slice(0, 80)}`);
          } else if (ticks % 3 === 1) {
            log("STEP-3", `tick #${ticks} → no cached Netflix mail newer than trigger yet in labels: ${pollLabels.join(", ")}`);
          }
          for (const row of rows || []) {
            const from = String(row.from_address || "").toLowerCase();
            if (!from.includes("netflix")) continue;
            const body = `${row.subject || ""} ${row.preview || ""} ${row.html || ""}`;
            const m = row.otp ? [row.otp, row.otp] : body.match(/\b(\d{4}|\d{6}|\d{8})\b/);
            if (m?.[1]) {
              code = m[1]; matchedId = row.id;
              log("STEP-3", `OTP found  id=${row.id}  subject="${(row.subject || "").slice(0, 80)}"  code=${code}`);
              break;
            }
          }
          if (code) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (!code) throw new Error(`OTP not received within 90s (polled ${ticks} times, from label="${chosenLabel}")`);
        log("STEP-3", `Using code ${code} from email ${matchedId}`);

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
