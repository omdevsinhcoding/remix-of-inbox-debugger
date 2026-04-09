import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
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
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "unknown";
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

  // Helper to verify session from header
  async function requireSession(req: Request): Promise<Record<string, any>> {
    const token = req.headers.get("x-session-token");
    if (!token) throw new Error("Authentication required");
    const session = await verifySessionToken(token, SESSION_SECRET);
    if (!session) throw new Error("Session expired or invalid");
    return session;
  }

  async function requireAdmin(req: Request): Promise<Record<string, any>> {
    const session = await requireSession(req);
    if (session.role !== "admin") throw new Error("Admin access required");
    return session;
  }

  try {
    const { action, ...params } = await req.json();

    // --- Public actions (no session needed) ---
    if (action === "list") {
      const { data, error } = await supabase
        .from("app_users")
        .select("id, username, name, role, assigned_accounts")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, users: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "login") {
      const { username, password } = params;
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
        await auditLog(supabase, "login_failed", user.id, null, { username }, ip);
        throw new Error("Invalid username or password");
      }

      // Upgrade to PBKDF2 if not already
      if (!user.password.startsWith("pbkdf2:")) {
        const hashed = await hashPassword(password);
        await supabase.from("app_users").update({ password: hashed }).eq("id", user.id);
      }

      // Create session token (30 min expiry)
      const sessionPayload = {
        userId: user.id,
        username: user.username,
        role: user.role,
        assignedAccounts: user.assigned_accounts || null,
        exp: Date.now() + 30 * 60 * 1000,
      };
      const sessionToken = await createSessionToken(sessionPayload, SESSION_SECRET);

      await auditLog(supabase, "login_success", user.id, null, { username, role: user.role }, ip);

      return new Response(JSON.stringify({
        success: true,
        sessionToken,
        user: {
          id: user.id, username: user.username, name: user.name, role: user.role,
          totpSecret: user.totp_secret, mustChangePassword: user.must_change_password,
          assignedAccounts: user.assigned_accounts,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "create") {
      const { username, password, name, role, assigned_accounts } = params;
      if (!username || !password || !name) throw new Error("All fields required");

      // Optionally require admin session for creating users
      try {
        await requireAdmin(req);
      } catch {
        // Allow first user creation without session (bootstrap)
        const { data: existing } = await supabase.from("app_users").select("id").limit(1);
        if (existing && existing.length > 0) throw new Error("Admin session required to create users");
      }

      const hashed = await hashPassword(password);
      const { data, error } = await supabase
        .from("app_users")
        .insert({ username, password: hashed, name, role: role || "user", assigned_accounts: assigned_accounts || null })
        .select("id, username, name, role, assigned_accounts")
        .single();
      if (error) throw error;

      await auditLog(supabase, "user_created", null, data.id, { username, role: role || "user" }, ip);

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

    if (action === "update_totp") {
      const { id, totp_secret } = params;
      const { error } = await supabase.from("app_users").update({ totp_secret }).eq("id", id);
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "create_otp") {
      const { user_id, otp } = params;
      await supabase.from("app_otps").delete().eq("user_id", user_id);
      const { error } = await supabase.from("app_otps").insert({ user_id, otp });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "request_admin_otp") {
      const { user_id } = params;
      if (!user_id) throw new Error("user_id required");

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
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "get_settings") {
      const { key } = params;
      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", key)
        .single();

      let value = data?.value || null;

      // Mask IMAP passwords in email_accounts for frontend
      if (key === "email_accounts" && Array.isArray(value)) {
        value = value.map((acc: any) => ({
          ...acc,
          password: acc.password ? "••••••••" : "",
        }));
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

      const impersonatePayload = {
        userId: targetUser.id,
        username: targetUser.username,
        role: "user",
        assignedAccounts: targetUser.assigned_accounts || null,
        impersonated: true,
        adminId: session.userId,
        exp: Date.now() + 30 * 60 * 1000,
      };
      const token = await createSessionToken(impersonatePayload, SESSION_SECRET);

      await auditLog(supabase, "impersonate", session.userId, targetUser.id, { targetUsername: targetUser.username }, ip);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: token,
        user: {
          id: targetUser.id, username: targetUser.username, name: targetUser.name, role: "user",
          assignedAccounts: targetUser.assigned_accounts, mustChangePassword: false,
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

    throw new Error("Unknown action: " + action);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
