import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const secret = req.headers.get("x-probe-secret") || "";
  if (secret !== Deno.env.get("CRON_SHARED_SECRET")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });
  }
  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.deleteIds) ? body.deleteIds : [];
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const out: any = {};
  if (ids.length > 0) {
    const { error } = await supabase.from("cached_emails").delete().in("id", ids);
    out.deleteError = error?.message || null;
  }
  if (body.sync) {
    const started = Date.now();
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": Deno.env.get("CRON_SHARED_SECRET")!,
      },
      body: JSON.stringify({ mode: "user_sync", source: "user_refresh_direct", limit: 200, accountLabels: body.accountLabels || undefined }),
    });
    const data = await res.json().catch(() => null);
    out.syncMs = Date.now() - started;
    out.syncStatus = res.status;
    out.stats = data?.stats || null;
    out.inserted = data?.inserted ?? null;
    out.ids = Array.isArray(data?.emails) ? data.emails.map((e: any) => e.id) : null;
  }
  const { data: rows } = await supabase
    .from("cached_emails").select("id,account_label,subject,date,cached_at")
    .eq("destroyed", false).order("date", { ascending: false }).limit(6);
  out.newest = rows;
  return new Response(JSON.stringify(out), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
