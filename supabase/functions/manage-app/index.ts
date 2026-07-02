import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticator } from "npm:otplib@12.0.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token, x-pending-token, x-client-ip",
};

// --- Crypto helpers ---
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$2")) return password === stored;
  if (!stored.startsWith("pbkdf2:")) return password === stored;
  const [, saltHex, hashHex] = stored.split(":");
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computedHex === hashHex;
}

// --- Session Token (HMAC-SHA256) ---
async function createSessionToken(payload: Record<string, any>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = JSON.stringify(payload);
  const dataB64 = btoa(data);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(dataB64));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${dataB64}.${sigHex}`;
}

async function verifySessionToken(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- AES-256-GCM encryption for IMAP credentials ---
async function deriveEncKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("imap-enc-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptValue(plaintext: string, secret: string): Promise<string> {
  const key = await deriveEncKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  const ctHex = Array.from(new Uint8Array(ciphertext)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `enc:${ivHex}:${ctHex}`;
}

async function decryptValue(encrypted: string, secret: string): Promise<string> {
  if (!encrypted.startsWith("enc:")) return encrypted; // plain text fallback
  const [, ivHex, ctHex] = encrypted.split(":");
  const key = await deriveEncKey(secret);
  const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

// --- Audit logging ---
async function auditLog(supabase: any, action: string, actorId: string | null, targetId: string | null, details: any, ip: string) {
  try {
    await supabase.from("audit_logs").insert({ action, actor_id: actorId, target_id: targetId, details, ip });
  } catch (e) { console.error("Audit log error:", e); }
}

function getClientIp(req: Request): string {
  return req.headers.get("x-client-ip")?.trim()
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("cf-connecting-ip")
    || req.headers.get("x-real-ip")
    || "unknown";
}

function esc(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getTelegramConfig(supabase: any): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "config").single();
    const cfg = data?.value as any;
    if (cfg?.TELEGRAM_BOT_TOKEN && cfg?.TELEGRAM_CHAT_ID) {
      return { botToken: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID };
    }
  } catch {}
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  return botToken && chatId ? { botToken, chatId } : null;
}

async function fetchIpWhoIs(ip: string): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const url = ip && ip !== "unknown" ? `https://ipwho.is/${encodeURIComponent(ip)}` : "https://ipwho.is/";
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.success ? data : null;
  } catch (err) {
    console.warn("[ipwho.is] failed:", err);
    return null;
  }
}

// Validate a browser-supplied ipwho.is payload before trusting it.
function validClientGeo(g: any): boolean {
  if (!g || typeof g !== "object") return false;
  if (g.success !== true) return false;
  if (typeof g.ip !== "string" || g.ip.length < 3) return false;
  if (!g.country && !g.city) return false;
  return true;
}

async function sendLoginNotification(
  supabase: any,
  req: Request,
  user: any,
  status: "success" | "failed",
  clientGeo?: any | null,
) {
  try {
    const tg = await getTelegramConfig(supabase);
    if (!tg || !user) return;

    const headerIp = getClientIp(req);
    let source: "browser" | "server" | "header" = "header";
    let info: any = null;

    if (validClientGeo(clientGeo)) {
      info = {
        ip: clientGeo.ip,
        city: clientGeo.city,
        region: clientGeo.region,
        country: clientGeo.country,
        postal: clientGeo.postal,
        latitude: clientGeo.latitude,
        longitude: clientGeo.longitude,
        flag: { emoji: clientGeo.flag_emoji },
        connection: { isp: clientGeo.isp, org: clientGeo.org, asn: clientGeo.asn },
        timezone: { id: clientGeo.timezone_id, current_time: new Date().toISOString() },
      };
      source = "browser";
    } else {
      info = await fetchIpWhoIs(headerIp);
      source = info ? "server" : "header";
    }

    const ip = info?.ip || headerIp || "Unknown";
    const flag = info?.flag?.emoji || "🌐";
    const city = info?.city || "Unknown City";
    const region = info?.region || "";
    const country = info?.country || "Unknown Country";
    const locLine = [city, region, country].filter(Boolean).join(", ");
    const postal = info?.postal || "";
    const lat = info?.latitude;
    const lon = info?.longitude;
    const isp = info?.connection?.isp || info?.connection?.org || "Unknown ISP";
    const asn = info?.connection?.asn ? `AS${info.connection.asn}` : "";
    const tz = info?.timezone?.id || "";
    const tzTime = info?.timezone?.current_time || new Date().toISOString();
    const mapsLink = typeof lat === "number" && typeof lon === "number" ? `https://www.google.com/maps?q=${lat},${lon}` : null;
    const displayName = user.name || user.username || "Unknown User";
    const statusEmoji = status === "success" ? "✅ Success" : "❌ Failed";
    const copyLine = `${displayName} • ${ip} • ${locLine}`;
    const srcTag = source === "browser" ? "🌐 Browser (ipwho.is)" : source === "server" ? "🖥 Server (ipwho.is)" : "🔧 Header only";

    const lines = [
      `<b>${flag} Login Attempt</b>`,
      `<b>User:</b> ${esc(displayName)} (<code>${esc(user.username || "")}</code>)`,
      `<b>Status:</b> ${statusEmoji}`,
      "",
      `<b>📍 Location</b>`,
      `<b>Place:</b> ${esc(locLine)}`,
      postal ? `<b>Postal:</b> <code>${esc(postal)}</code>` : "",
      typeof lat === "number" && typeof lon === "number" ? `<b>Coords:</b> <code>${lat.toFixed(4)}, ${lon.toFixed(4)}</code>` : "",
      mapsLink ? `<b>Map:</b> <a href="${mapsLink}">Open in Google Maps</a>` : "",
      "",
      `<b>🛰 Network</b>`,
      `<b>IP:</b> <code>${esc(ip)}</code>`,
      `<b>ISP:</b> ${esc(isp)}${asn ? ` (${asn})` : ""}`,
      `<b>Source:</b> ${srcTag}`,
      "",
      `<b>🕒 Time</b>`,
      `<b>Local:</b> ${esc(tzTime)}${tz ? ` (${esc(tz)})` : ""}`,
      `<b>IST:</b> ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true })}`,
      "",
      `<b>📋 Quick Copy</b>`,
      `<code>${esc(copyLine)}</code>`,
    ].filter(Boolean).join("\n");

    const tgRes = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text: lines, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!tgRes.ok) console.error("[telegram] login notify failed:", await tgRes.text());
  } catch (err) {
    console.error("[notification] login notify failed:", err);
  }
}

async function loadWorkerUrls(supabase: any): Promise<string[]> {
  const workerUrls: string[] = [];
  try {
    const { data: primaryCfSetting } = await supabase.from("app_settings").select("value").eq("key", "primary_cloudflare_urls").single();
    if (Array.isArray(primaryCfSetting?.value)) {
      for (const u of primaryCfSetting.value) if (typeof u === "string" && u.length > 0 && !workerUrls.includes(u)) workerUrls.push(u);
    }
    const { data: emailAccountsSetting } = await supabase.from("app_settings").select("value").eq("key", "email_accounts").single();
    if (Array.isArray(emailAccountsSetting?.value)) {
      for (const acct of emailAccountsSetting.value) {
        if (Array.isArray(acct.cloudflareUrls)) {
          for (const u of acct.cloudflareUrls) if (typeof u === "string" && u.length > 0 && !workerUrls.includes(u)) workerUrls.push(u);
        }
      }
    }
  } catch (e) {
    console.error("Failed to fetch worker URLs:", e);
  }
  return workerUrls;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const SESSION_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ip = getClientIp(req);

  // --- Persist a session row in DB (source of truth for logged-in status) ---
  async function persistSession(userId: string, role: string, token: string, expiresAtMs: number) {
    const tokenHash = await sha256Hex(token);
    const ua = req.headers.get("user-agent") || null;
    await supabase.from("app_sessions").insert({
      user_id: userId,
      role,
      token_hash: tokenHash,
      expires_at: new Date(expiresAtMs).toISOString(),
      ip,
      user_agent: ua,
    });
    // Best-effort cleanup of expired rows for this user
    supabase.from("app_sessions").delete().lt("expires_at", new Date().toISOString()).eq("user_id", userId).then(() => {});
  }

  // Helper to verify session from header AND ensure a live DB row exists
  async function requireSession(req: Request): Promise<Record<string, any>> {
    const token = req.headers.get("x-session-token");
    if (!token) throw new Error("Authentication required");
    const session = await verifySessionToken(token, SESSION_SECRET);
    if (!session) throw new Error("Session expired or invalid");
    const tokenHash = await sha256Hex(token);
    const { data: row } = await supabase
      .from("app_sessions")
      .select("id, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!row) throw new Error("Session revoked. Please sign in again.");
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await supabase.from("app_sessions").delete().eq("id", row.id);
      throw new Error("Session expired. Please sign in again.");
    }
    // Fire-and-forget touch
    supabase.from("app_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", row.id).then(() => {});
    return session;
  }

  async function requireAdmin(req: Request): Promise<Record<string, any>> {
    const session = await requireSession(req);
    if (session.role !== "admin") throw new Error("Admin access required");
    return session;
  }

  async function requirePendingAdmin(req: Request, userId?: string): Promise<{ pending: Record<string, any>; token: string; tokenHash: string; state: any }> {
    const token = req.headers.get("x-pending-token") || req.headers.get("x-session-token");
    if (!token) throw new Error("Pending admin verification required");
    const pending = await verifySessionToken(token, SESSION_SECRET);
    if (!pending || pending.role !== "admin" || pending.pending !== true) throw new Error("Invalid or expired pending admin token");
    if (userId && pending.userId !== userId) throw new Error("Pending token does not match this admin");
    const tokenHash = await sha256Hex(token);
    const { data: state, error } = await supabase
      .from("app_admin_2fa_state")
      .select("*")
      .eq("token_hash", tokenHash)
      .eq("user_id", pending.userId)
      .gte("expires_at", new Date().toISOString())
      .single();
    if (error || !state) throw new Error("Pending admin verification expired");
    return { pending, token, tokenHash, state };
  }

  try {
    const { action, ...params } = await req.json();

    // --- Public actions (no session needed) ---

    // Bootstrap: returns profiles, recaptcha config, and worker URLs for fresh browsers
    if (action === "bootstrap_public") {
      // Public profile picker — only non-admin users, minimal fields.
      const { data: users, error: usersErr } = await supabase
        .from("app_users")
        .select("id, username, name, role, profile_prefs")
        .neq("role", "admin")
        .order("created_at", { ascending: true });
      if (usersErr) throw usersErr;

      let recaptcha = null;
      try {
        const { data: rcData } = await supabase.from("app_settings").select("value").eq("key", "recaptcha").single();
        if (rcData?.value?.enabled === true && rcData?.value?.siteKey) {
          recaptcha = { enabled: true, siteKey: rcData.value.siteKey };
        }
      } catch {}

      let workerUrls: string[] = [];
      try {
        const { data: pcf } = await supabase.from("app_settings").select("value").eq("key", "primary_cloudflare_urls").single();
        if (pcf?.value && Array.isArray(pcf.value)) {
          workerUrls = pcf.value.filter((u: any) => typeof u === "string" && u.length > 0);
        }
      } catch {}

      const mappedUsers = (users || []).map((u: any) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        profileAvatar: u.profile_prefs?.avatarId || null,
      }));
      return new Response(JSON.stringify({ success: true, users: mappedUsers, recaptcha, workerUrls }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "list") {
      // Admin dashboard only
      await requireAdmin(req);
      const { data, error } = await supabase
        .from("app_users")
        .select("id, username, name, role, assigned_accounts, profile_prefs")
        .order("created_at", { ascending: true });
      if (error) throw error;
      const mappedData = (data || []).map((u: any) => ({
        ...u,
        assignedAccounts: u.assigned_accounts || null,
        profileAvatar: u.profile_prefs?.avatarId || null,
      }));
      return new Response(JSON.stringify({ success: true, users: mappedData }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "login") {
      const { username, password, geo: clientGeo } = params;
      if (!username || !password) throw new Error("Username and password required");

      const { data: user, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("username", username)
        .single();

      if (error || !user) {
        await auditLog(supabase, "login_failed", null, null, { username }, ip);
        throw new Error("Invalid username or password");
      }

      const passwordMatch = await verifyPassword(password, user.password);
      if (!passwordMatch) {
        await auditLog(supabase, "login_failed", user.id, null, { username, geoIp: clientGeo?.ip || null }, ip);
        ((globalThis as any).EdgeRuntime?.waitUntil?.(sendLoginNotification(supabase, req, user, "failed", clientGeo)) ?? sendLoginNotification(supabase, req, user, "failed", clientGeo).catch(() => {}));
        throw new Error("Invalid username or password");
      }

      // Upgrade to PBKDF2 if not already
      if (!user.password.startsWith("pbkdf2:")) {
        const hashed = await hashPassword(password);
        await supabase.from("app_users").update({ password: hashed }).eq("id", user.id);
      }

      await auditLog(supabase, "login_success", user.id, null, { username, role: user.role, geoIp: clientGeo?.ip || null }, ip);
      ((globalThis as any).EdgeRuntime?.waitUntil?.(sendLoginNotification(supabase, req, user, "success", clientGeo)) ?? sendLoginNotification(supabase, req, user, "success", clientGeo).catch(() => {}));

      if (user.role === "admin") {
        const pendingPayload = { userId: user.id, username: user.username, role: "admin", pending: true, exp: Date.now() + 5 * 60 * 1000 };
        const pendingToken = await createSessionToken(pendingPayload, SESSION_SECRET);
        const tokenHash = await sha256Hex(pendingToken);
        await supabase.from("app_admin_2fa_state").delete().eq("user_id", user.id);
        const { error: stateErr } = await supabase.from("app_admin_2fa_state").insert({
          token_hash: tokenHash,
          user_id: user.id,
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
        if (stateErr) throw stateErr;
        return new Response(JSON.stringify({
          success: true,
          pendingToken,
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            totpConfigured: !!user.totp_secret,
            mustChangePassword: user.must_change_password,
          },
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Create normal user session token (30 min expiry)
      const expMs = Date.now() + 30 * 60 * 1000;
      const sessionPayload = {
        userId: user.id,
        username: user.username,
        role: user.role,
        assignedAccounts: user.assigned_accounts || null,
        exp: expMs,
      };
      const sessionToken = await createSessionToken(sessionPayload, SESSION_SECRET);
      await persistSession(user.id, user.role, sessionToken, expMs);
      const workerUrls = await loadWorkerUrls(supabase);

      return new Response(JSON.stringify({
        success: true,
        sessionToken,
        workerUrls,
        user: {
          id: user.id, username: user.username, name: user.name, role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: user.assigned_accounts,
          profilePrefs: user.profile_prefs || {},
          profileAvatar: user.profile_prefs?.avatarId || null,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "create") {
      const { username, password, name, role, assigned_accounts } = params;
      if (!username || !password || !name) throw new Error("All fields required");

      // Optionally require admin session for creating users
      let bootstrapCreate = false;
      let actorId: string | null = null;
      try {
        const admin = await requireAdmin(req);
        actorId = admin.userId;
      } catch {
        // Allow first user creation without session (bootstrap)
        const { data: existing } = await supabase.from("app_users").select("id").limit(1);
        if (existing && existing.length > 0) throw new Error("Admin session required to create users");
        bootstrapCreate = true;
      }

      const hashed = await hashPassword(password);
      const { data, error } = await supabase
        .from("app_users")
        .insert({ username, password: hashed, name, role: role || "user", assigned_accounts: assigned_accounts || null })
        .select("id, username, name, role, assigned_accounts, profile_prefs")
        .single();
      if (error) throw error;

      await auditLog(supabase, bootstrapCreate ? "bootstrap_admin_created" : "user_created", actorId, data.id, { username, role: role || "user" }, ip);

      return new Response(JSON.stringify({ success: true, user: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete") {
      const session = await requireAdmin(req);
      const { id } = params;
      const { error } = await supabase.from("app_users").delete().eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "user_deleted", session.userId, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "change_password") {
      const { id, current_password, new_password } = params;
      if (!id || !new_password) throw new Error("ID and new password required");
      if (new_password.length < 6) throw new Error("Password must be at least 6 characters");

      const { data: user, error: fetchErr } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", id)
        .single();
      if (fetchErr || !user) throw new Error("User not found");

      if (current_password) {
        // Normal self-change: verify current password
        const match = await verifyPassword(current_password, user.password);
        if (!match) throw new Error("Current password is incorrect");
      } else {
        // Either admin reset OR forced first-time password set
        const token = req.headers.get("x-session-token");
        if (!token) throw new Error("Authentication required to change password");
        const session = await verifySessionToken(token, SESSION_SECRET);
        if (!session) throw new Error("Session expired or invalid");

        if (session.role === "admin") {
          // Admin reset — allowed
        } else if (session.userId === id && user.must_change_password) {
          // First-time forced password set — allowed
        } else {
          throw new Error("Provide your current password or contact an admin");
        }
      }

      const hashed = await hashPassword(new_password);
      const { error } = await supabase.from("app_users").update({ password: hashed, must_change_password: false }).eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "password_changed", id, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_profile_prefs") {
      const session = await requireSession(req);
      const { profile_prefs } = params;
      if (!profile_prefs || typeof profile_prefs !== "object" || Array.isArray(profile_prefs)) {
        throw new Error("Profile settings are invalid");
      }

      const cleanPrefs = {
        avatarId: typeof profile_prefs.avatarId === "string" ? profile_prefs.avatarId : null,
        hiddenBefore: typeof profile_prefs.hiddenBefore === "string" ? profile_prefs.hiddenBefore : null,
        hiddenEmailIds: Array.isArray(profile_prefs.hiddenEmailIds)
          ? profile_prefs.hiddenEmailIds.filter((id: any) => typeof id === "string").slice(0, 2000)
          : [],
      };

      const { error } = await supabase
        .from("app_users")
        .update({ profile_prefs: cleanPrefs })
        .eq("id", session.userId);
      if (error) throw error;

      await auditLog(supabase, "profile_prefs_updated", session.userId, session.userId, { avatarId: cleanPrefs.avatarId, hiddenBefore: cleanPrefs.hiddenBefore }, ip);
      return new Response(JSON.stringify({ success: true, profilePrefs: cleanPrefs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_totp") {
      const { user_id } = params;
      const { pending } = await requirePendingAdmin(req, user_id);
      const { data: existing, error: exErr } = await supabase
        .from("app_users").select("id, username, totp_secret").eq("id", pending.userId).single();
      if (exErr) throw exErr;
      if (existing?.totp_secret) throw new Error("TOTP is already configured");
      const secret = authenticator.generateSecret();
      const otpauthUrl = authenticator.keyuri(existing.username, "AdminPanel", secret);
      const { error } = await supabase.from("app_users").update({ totp_secret: secret }).eq("id", pending.userId);
      if (error) throw error;
      await auditLog(supabase, "totp_setup_created", pending.userId, pending.userId, {}, ip);
      return new Response(JSON.stringify({ success: true, secret, otpauthUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // NOTE: The insecure `create_otp` action was removed. OTPs are generated
    // server-side by `request_admin_otp` and never accepted from the client.

    if (action === "request_admin_otp") {
      const { user_id } = params;
      if (!user_id) throw new Error("user_id required");
      await requirePendingAdmin(req, user_id);

      // Generate OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

      // Save OTP to DB
      await supabase.from("app_otps").delete().eq("user_id", user_id);
      const { error: otpErr } = await supabase.from("app_otps").insert({ user_id, otp: otpCode });
      if (otpErr) throw otpErr;

      // Get Telegram config
      let tgConfig: { botToken: string; chatId: string } | null = null;
      try {
        const { data: settingsData } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "config")
          .single();
        if (settingsData?.value) {
          const cfg = settingsData.value as any;
          if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) {
            tgConfig = { botToken: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID };
          }
        }
      } catch {}
      if (!tgConfig) {
        const bt = Deno.env.get("TELEGRAM_BOT_TOKEN");
        const ci = Deno.env.get("TELEGRAM_CHAT_ID");
        if (bt && ci) tgConfig = { botToken: bt, chatId: ci };
      }

      if (!tgConfig) {
        throw new Error("Telegram not configured. Set bot token and chat ID in admin settings.");
      }

      // Send OTP via Telegram
      const telegramRes = await fetch(`https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: tgConfig.chatId,
          text: `🛡 Admin 3FA OTP: <code>${otpCode}</code>\nValid for 5 minutes.`,
          parse_mode: "HTML",
        }),
      });

      if (!telegramRes.ok) {
        const errText = await telegramRes.text();
        console.error("Telegram API error:", errText);
        throw new Error("Failed to send OTP via Telegram. Check bot token and chat ID.");
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_otp") {
      const { pending, tokenHash } = await requirePendingAdmin(req, params.user_id);
      const { user_id, otp } = params;
      const { data, error } = await supabase
        .from("app_otps")
        .select("*")
        .eq("user_id", user_id)
        .eq("otp", otp)
        .gte("expires_at", new Date().toISOString())
        .single();

      if (error || !data) throw new Error("Invalid or expired OTP");
      await supabase.from("app_otps").delete().eq("id", data.id);
      await supabase.from("app_admin_2fa_state").update({ otp_verified_at: new Date().toISOString() }).eq("token_hash", tokenHash).eq("user_id", pending.userId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_totp") {
      const { pending, tokenHash } = await requirePendingAdmin(req, params.user_id);
      const { code } = params;
      if (!code || String(code).length < 6) throw new Error("TOTP code required");
      const { data: user, error } = await supabase.from("app_users").select("totp_secret").eq("id", pending.userId).single();
      if (error || !user?.totp_secret) throw new Error("TOTP is not configured");
      if (!authenticator.check(String(code), user.totp_secret)) throw new Error("Invalid Google Authenticator code");
      await supabase.from("app_admin_2fa_state").update({ totp_verified_at: new Date().toISOString() }).eq("token_hash", tokenHash).eq("user_id", pending.userId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "finalize_admin_session") {
      const { pending, tokenHash, state } = await requirePendingAdmin(req, params.user_id);
      const now = Date.now();
      const otpAt = state.otp_verified_at ? new Date(state.otp_verified_at).getTime() : 0;
      const totpAt = state.totp_verified_at ? new Date(state.totp_verified_at).getTime() : 0;
      if (!otpAt || now - otpAt > 60_000) throw new Error("Telegram OTP proof expired");
      if (!totpAt || now - totpAt > 60_000) throw new Error("Authenticator proof expired");

      const { data: user, error } = await supabase.from("app_users").select("*").eq("id", pending.userId).single();
      if (error || !user || user.role !== "admin") throw new Error("Admin not found");
      const expMs = Date.now() + 30 * 60 * 1000;
      const sessionPayload = {
        userId: user.id,
        username: user.username,
        role: "admin",
        assignedAccounts: user.assigned_accounts || null,
        exp: expMs,
      };
      const sessionToken = await createSessionToken(sessionPayload, SESSION_SECRET);
      await persistSession(user.id, "admin", sessionToken, expMs);
      const workerUrls = await loadWorkerUrls(supabase);
      await supabase.from("app_admin_2fa_state").delete().eq("token_hash", tokenHash);
      await auditLog(supabase, "admin_2fa_finalized", user.id, user.id, {}, ip);
      return new Response(JSON.stringify({
        success: true,
        sessionToken,
        workerUrls,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: user.assigned_accounts,
          profilePrefs: user.profile_prefs || {},
          profileAvatar: user.profile_prefs?.avatarId || null,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "get_settings") {
      const { key } = params;
      let session: Record<string, any> | null = null;

      // Fully admin-only keys
      const adminOnlyKeys = ["config", "cron_config"];
      if (adminOnlyKeys.includes(key)) {
        session = await requireAdmin(req);
      }

      // Keys that any authenticated user can read (with masked sensitive data)
      const authenticatedKeys = ["primary_cloudflare_urls", "email_accounts", "recaptcha", "email_filters", "session_config"];
      if (!session && authenticatedKeys.includes(key)) {
        session = await requireSession(req);
      }

      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", key)
        .single();

      let value = data?.value || null;

      // Mask IMAP passwords in email_accounts for non-admin users
      if (key === "email_accounts" && Array.isArray(value)) {
        const isAdmin = session?.role === "admin";
        value = value.map((acc: any) => ({
          ...acc,
          password: isAdmin ? acc.password : "••••••••",
          // Non-admin users only see cloudflare URLs and label
          ...(isAdmin ? {} : { host: undefined, port: undefined, user: undefined }),
        }));
      }

      if (key === "recaptcha" && value && session?.role !== "admin") {
        const { secretKey, ...safeValue } = value;
        value = safeValue;
      }

      return new Response(JSON.stringify({ success: true, value }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "set_settings") {
      const session = await requireAdmin(req);
      const { key, value } = params;

      let processedValue = value;

      // Encrypt IMAP passwords in email_accounts
      if (key === "email_accounts" && Array.isArray(value)) {
        // Get existing accounts to preserve encrypted passwords when masked
        const { data: existingData } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "email_accounts")
          .single();
        const existingAccounts = existingData?.value || [];

        processedValue = await Promise.all(value.map(async (acc: any, i: number) => {
          let password = acc.password;
          if (password === "••••••••" && existingAccounts[i]?.password) {
            password = existingAccounts[i].password; // Keep existing encrypted password
          } else if (password && !password.startsWith("enc:")) {
            password = await encryptValue(password, SESSION_SECRET); // Encrypt new password
          }
          return { ...acc, password };
        }));
      }

      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value: processedValue }, { onConflict: "key" });
      if (error) throw error;
      await auditLog(supabase, "settings_changed", session.userId, null, { key }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_user") {
      const session = await requireAdmin(req);
      const { id, assigned_accounts } = params;
      if (!id) throw new Error("User ID required");
      const { error } = await supabase.from("app_users").update({ assigned_accounts }).eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "user_updated", session.userId, id, { assigned_accounts }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "impersonate") {
      const session = await requireAdmin(req);
      const { target_user_id } = params;
      if (!target_user_id) throw new Error("Target user ID required");

      const { data: targetUser, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", target_user_id)
        .single();
      if (error || !targetUser) throw new Error("User not found");

      const expMs = Date.now() + 30 * 60 * 1000;
      const impersonatePayload = {
        userId: targetUser.id,
        username: targetUser.username,
        role: "user",
        assignedAccounts: targetUser.assigned_accounts || null,
        impersonated: true,
        adminId: session.userId,
        exp: expMs,
      };
      const token = await createSessionToken(impersonatePayload, SESSION_SECRET);
      await persistSession(targetUser.id, "user", token, expMs);

      await auditLog(supabase, "impersonate", session.userId, targetUser.id, { targetUsername: targetUser.username }, ip);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: token,
        user: {
          id: targetUser.id, username: targetUser.username, name: targetUser.name, role: "user",
          assignedAccounts: targetUser.assigned_accounts, mustChangePassword: false,
          profilePrefs: targetUser.profile_prefs || {},
          profileAvatar: targetUser.profile_prefs?.avatarId || null,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Decrypt IMAP passwords (internal use for fetch-emails)
    if (action === "get_decrypted_accounts") {
      // Only allow from internal edge functions (check for service role key in auth header)
      const authHeader = req.headers.get("authorization") || "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      if (!authHeader.includes(serviceKey)) throw new Error("Unauthorized");

      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "email_accounts")
        .single();

      if (!data?.value || !Array.isArray(data.value)) {
        return new Response(JSON.stringify({ success: true, accounts: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const decrypted = await Promise.all(data.value.map(async (acc: any) => ({
        ...acc,
        password: acc.password ? await decryptValue(acc.password, SESSION_SECRET) : "",
      })));

      return new Response(JSON.stringify({ success: true, accounts: decrypted }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_session") {
      const token = params.token || req.headers.get("x-session-token");
      if (!token) throw new Error("No token provided");
      const session = await verifySessionToken(token, SESSION_SECRET);
      if (!session) throw new Error("Invalid or expired session");
      return new Response(JSON.stringify({ success: true, session }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Hydrate the logged-in user from the DB. Used on page load / refresh so
    // localStorage cannot be trusted for who the user is or their role.
    if (action === "me") {
      const session = await requireSession(req);
      const { data: user, error } = await supabase
        .from("app_users")
        .select("id, username, name, role, must_change_password, assigned_accounts, profile_prefs")
        .eq("id", session.userId)
        .single();
      if (error || !user) throw new Error("Account not found");
      return new Response(JSON.stringify({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: user.assigned_accounts,
          profilePrefs: user.profile_prefs || {},
          profileAvatar: user.profile_prefs?.avatarId || null,
          impersonated: session.impersonated === true,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "logout") {
      const token = req.headers.get("x-session-token");
      if (token) {
        const tokenHash = await sha256Hex(token);
        await supabase.from("app_sessions").delete().eq("token_hash", tokenHash);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Unknown action: " + action);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
