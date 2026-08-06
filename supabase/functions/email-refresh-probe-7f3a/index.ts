import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

// TEMPORARY verification probe: triggers fetch-emails as a server-side caller.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const res = await fetch(`${url}/functions/v1/fetch-emails`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceRole}`,
      apikey: serviceRole,
    },
    body: JSON.stringify({ mode: 'sync', source: 'probe', manual: true }),
  });
  const text = await res.text();

  return new Response(JSON.stringify({ status: res.status, body: text.slice(0, 4000) }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
