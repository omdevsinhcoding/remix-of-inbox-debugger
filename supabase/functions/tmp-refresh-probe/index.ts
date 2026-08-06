// TEMPORARY diagnostic function. Triggers the real fetch-emails refresh path
// server-side using the cron shared secret, so the household-mail ingestion fix
// can be verified end-to-end. Safe to delete.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL")!;
  const cron = Deno.env.get("CRON_SHARED_SECRET") || "";
  let payload: any = {};
  try { payload = await req.json(); } catch {}

  const started = Date.now();
  const res = await fetch(`${url}/functions/v1/fetch-emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": cron,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({
      mode: "sync",
      source: payload.source || "user_refresh_direct",
      accountLabels: payload.accountLabels ?? null,
    }),
  });
  const text = await res.text();

  return new Response(
    JSON.stringify({ status: res.status, elapsedMs: Date.now() - started, body: text.slice(0, 4000) }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
