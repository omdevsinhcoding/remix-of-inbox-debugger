// Dedicated email-HTML endpoint for the Cloudflare worker cache.
// - Plaintext JSON (no encrypted transport needed) so the worker can proxy
//   directly with just SUPABASE_URL + SUPABASE_KEY on its side.
// - Self-contained auth: verifies X-Session-Token with the SAME signing
//   secret manage-app uses (SESSION_SIGNING_SECRET → SUPABASE_SERVICE_ROLE_KEY
//   fallback). No extra secrets required.
// - Body: { id: string, authz_only?: boolean }
//   authz_only=true → returns { allowed, account_label } (~80 bytes, for
//   worker cache-HIT authz check without shipping the full HTML again).
//   authz_only=false/absent → returns { html, account_label } (full body).

import { createClient } from "npm:@supabase/supabase-js@2";
import { redactEmailsHtml } from "../_shared/redact.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function verifyToken(token: string, secret: string): Promise<any | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["verify"],
    );
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, enc.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "method not allowed" }, 405);

  try {
    const token = req.headers.get("x-session-token") || "";
    if (!token) return json({ success: false, error: "session required" }, 401);

    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SIGNING = Deno.env.get("SESSION_SIGNING_SECRET") || SERVICE_ROLE;
    const LEGACY = SERVICE_ROLE;

    let session = await verifyToken(token, SIGNING);
    if (!session && LEGACY !== SIGNING) session = await verifyToken(token, LEGACY);
    if (!session?.userId) return json({ success: false, error: "invalid session" }, 401);

    let body: any = {};
    try { body = await req.json(); } catch {}
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    const authzOnly = !!body?.authz_only;
    if (!id) return json({ success: false, error: "id required" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);

    // Live session check (revocation-aware) — mirrors manage-app.requireSession
    const tokenHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(tokenHashBuf))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const { data: sessRow } = await supabase
      .from("app_sessions")
      .select("id, revoked_at, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!sessRow) return json({ success: false, error: "session not found" }, 401);
    if (sessRow.revoked_at) return json({ success: false, error: "session revoked" }, 401);
    if (sessRow.expires_at && new Date(sessRow.expires_at).getTime() < Date.now()) {
      return json({ success: false, error: "session expired" }, 401);
    }

    // Fresh authz from DB
    const { data: u } = await supabase
      .from("app_users")
      .select("assigned_accounts, role")
      .eq("id", session.userId)
      .single();
    if (!u) return json({ success: false, error: "user not found" }, 401);
    const isAdmin = u.role === "admin";
    const labels: string[] | null = Array.isArray(u.assigned_accounts) && u.assigned_accounts.length > 0
      ? u.assigned_accounts.map((s: any) => String(s).trim()).filter(Boolean)
      : (isAdmin ? null : []);

    const cols = authzOnly ? "id, account_label, destroyed" : "id, html, account_label, destroyed";
    const { data: row, error } = await supabase
      .from("cached_emails")
      .select(cols)
      .eq("id", id)
      .maybeSingle();
    if (error) return json({ success: false, error: error.message }, 500);
    if (!row || (row as any).destroyed) return json({ success: false, error: "Email not found" }, 404);

    const accountLabel = (row as any).account_label || "";
    if (labels && labels.length > 0 && !labels.includes(accountLabel)) {
      return json({ success: false, allowed: false, error: "Not authorized" }, 403);
    }
    if (labels && labels.length === 0 && !isAdmin) {
      return json({ success: false, allowed: false, error: "Not authorized" }, 403);
    }

    if (authzOnly) {
      return json({ success: true, allowed: true, id: (row as any).id, account_label: accountLabel });
    }
    return json({
      success: true,
      id: (row as any).id,
      html: (row as any).html || "",
      account_label: accountLabel,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
