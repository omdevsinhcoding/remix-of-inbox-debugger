// Worker bootstrap endpoint — returns the 3 secrets a Cloudflare worker needs
// so `setup.sh` can auto-configure a fresh worker with zero manual steps.
//
// Protection: caller must send a fixed magic token in X-Bootstrap-Token that
// matches the one hardcoded in cloudflare-worker/setup.sh. This is NOT strong
// security — anyone with read access to the repo can call this and obtain
// SESSION_SECRET. Keep the repo private.
//
// The token is also gated by the Supabase anon key (default Edge Function auth).

import { corsHeaders } from "../_shared/crypto.ts";

// Rotate this string if you ever suspect the repo leaked.
const BOOTSTRAP_MAGIC = "wkr_bootstrap_2026_netflixfetch_auto_v1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const provided = req.headers.get("X-Bootstrap-Token") || "";
  if (provided !== BOOTSTRAP_MAGIC) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const SESSION_SECRET =
    Deno.env.get("SESSION_SIGNING_SECRET") ||
    Deno.env.get("SESSION_SECRET") ||
    "";

  if (!SUPABASE_URL || !SUPABASE_KEY || !SESSION_SECRET) {
    return new Response(
      JSON.stringify({ error: "Server missing required env vars" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ SUPABASE_URL, SUPABASE_KEY, SESSION_SECRET }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
