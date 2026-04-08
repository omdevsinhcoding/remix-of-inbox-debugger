import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Simple password hashing using Web Crypto (works in Deno edge functions)
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // Support legacy bcrypt hashes (starts with $2) - always return true for migration
  if (stored.startsWith("$2")) {
    return password === stored; // Can't verify bcrypt in edge, treat as plain text match
  }
  
  // Support plain text passwords (migration)
  if (!stored.startsWith("pbkdf2:")) {
    return password === stored;
  }
  
  const [, saltHex, hashHex] = stored.split(":");
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computedHex === hashHex;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { action, ...params } = await req.json();

    if (action === "list") {
      const { data, error } = await supabase
        .from("app_users")
        .select("id, username, name, role")
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

      if (error || !user) throw new Error("Invalid username or password");

      const passwordMatch = await verifyPassword(password, user.password);
      if (!passwordMatch) throw new Error("Invalid username or password");

      // Upgrade to PBKDF2 if not already
      if (!user.password.startsWith("pbkdf2:")) {
        const hashed = await hashPassword(password);
        await supabase.from("app_users").update({ password: hashed }).eq("id", user.id);
      }

      return new Response(JSON.stringify({
        success: true,
        user: { id: user.id, username: user.username, name: user.name, role: user.role, totpSecret: user.totp_secret, mustChangePassword: user.must_change_password },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "create") {
      const { username, password, name, role } = params;
      if (!username || !password || !name) throw new Error("All fields required");

      const hashed = await hashPassword(password);
      const { data, error } = await supabase
        .from("app_users")
        .insert({ username, password: hashed, name, role: role || "user" })
        .select("id, username, name, role")
        .single();
      if (error) throw error;

      return new Response(JSON.stringify({ success: true, user: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete") {
      const { id } = params;
      const { error } = await supabase.from("app_users").delete().eq("id", id);
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "change_password") {
      const { id, current_password, new_password } = params;
      if (!id || !new_password) throw new Error("ID and new password required");

      const { data: user, error: fetchErr } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", id)
        .single();
      if (fetchErr || !user) throw new Error("User not found");

      // If current_password provided, verify it
      if (current_password) {
        const match = await verifyPassword(current_password, user.password);
        if (!match) throw new Error("Current password is incorrect");
      }

      const hashed = await hashPassword(new_password);
      const { error } = await supabase.from("app_users").update({ password: hashed, must_change_password: false }).eq("id", id);
      if (error) throw error;
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
      return new Response(JSON.stringify({ success: true, value: data?.value || null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "set_settings") {
      const { key, value } = params;
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value }, { onConflict: "key" });
      if (error) throw error;
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
