// TEMPORARY: reveals SESSION_SIGNING_SECRET once. DELETE after use.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = new URL(req.url)
  const pass = url.searchParams.get('pass')
  // one-time access phrase — change if you want
  if (pass !== 'gohil-reveal-2026') {
    return new Response('forbidden', { status: 403, headers: corsHeaders })
  }

  const value = Deno.env.get('SESSION_SIGNING_SECRET') ?? ''
  return new Response(
    JSON.stringify({ present: !!value, length: value.length, value }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
