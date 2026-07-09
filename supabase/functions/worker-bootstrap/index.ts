// Worker bootstrap endpoint — returns the 3 secrets a Cloudflare worker needs
// so `setup.sh` can auto-configure a fresh worker with zero manual steps.
//
// Protection: caller must send a fixed magic token in X-Bootstrap-Token that
// matches the one hardcoded in cloudflare-worker/setup.sh. This is NOT strong
// security — anyone with read access to the repo can call this and obtain
// SESSION_SECRET. Keep the repo private.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bootstrap-token",
};

// Rotate this string if you ever suspect the repo leaked.
const BOOTSTRAP_MAGIC = "wkr_bootstrap_2026_netflixfetch_auto_v1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const provided = req.headers.get("X-Bootstrap-Token") || req.headers.get("x-bootstrap-token") || "";
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
      JSON.stringify({
        error: "Server missing required env vars",
        missing: {
          SUPABASE_URL: !SUPABASE_URL,
          SUPABASE_ANON_KEY: !SUPABASE_KEY,
          SESSION_SECRET: !SESSION_SECRET,
        },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ SUPABASE_URL, SUPABASE_KEY, SESSION_SECRET }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
