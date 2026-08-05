import { createClient } from "npm:@supabase/supabase-js@2";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { success: false, error: "method_not_allowed" });

  try {
    const body = await req.json().catch(() => ({}));
    const eventId = String(body?.event_id || "").trim();
    const runnerToken = String(body?.runner_token || "").trim();
    if (!uuidRe.test(eventId) || runnerToken.length < 32) {
      return json(400, { success: false, error: "bad_request" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) throw new Error("server_not_configured");
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: event, error: eventError } = await supabase
      .from("tv_login_events")
      .select("id, code, imap_user, status, metadata")
      .eq("id", eventId)
      .maybeSingle();
    if (eventError) throw eventError;

    const expectedHash = String((event?.metadata as Record<string, unknown> | null)?.runnerTokenHash || "");
    if (!event || !expectedHash || await sha256Hex(runnerToken) !== expectedHash) {
      return json(401, { success: false, error: "unauthorized" });
    }
    if (!event.imap_user) return json(409, { success: false, error: "no_account" });
    if (!["queued", "running", "in_progress"].includes(String(event.status || ""))) {
      return json(409, { success: false, error: "event_not_runnable" });
    }

    const { data: cookies, error: cookieError } = await supabase
      .from("imap_cookies")
      .select("content, format")
      .eq("imap_user", event.imap_user)
      .maybeSingle();
    if (cookieError) throw cookieError;
    if (!cookies?.content) return json(409, { success: false, error: "cookies_missing" });

    return json(200, {
      success: true,
      event_id: event.id,
      code: event.code,
      cookies_content: cookies.content,
      cookies_format: cookies.format || "auto",
    });
  } catch (error) {
    console.error("tv-runner-job", error instanceof Error ? error.message : String(error));
    return json(500, { success: false, error: "internal_error" });
  }
});