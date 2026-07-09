#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# TRUE ZERO-CONFIG SETUP for Cloudflare Workers Builds
# ─────────────────────────────────────────────────────────────
# You only click "Connect to Git" in Cloudflare. Everything else is automatic:
#   1. KV namespace EMAIL_CACHE  — create if missing, bind to worker
#   2. Deploy worker
#   3. Fetch SUPABASE_URL + SUPABASE_KEY + SESSION_SECRET from Supabase
#      worker-bootstrap endpoint and push all 3 as secrets
#
# Requirements per Cloudflare account (one-time, via the API token used to
# connect Git): permissions Workers Scripts:Edit + Workers KV Storage:Edit.
# Cloudflare's default "Workers Builds" token template has both.
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# Bootstrap endpoint (public + magic-token protected).
# Anon key below is only used to reach the Supabase edge function.
BOOTSTRAP_URL_HOST="https://jsqchutnfdeljajkxmly.supabase.co"
BOOTSTRAP_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA"
BOOTSTRAP_MAGIC="wkr_bootstrap_2026_netflixfetch_auto_v1"
BOOTSTRAP_URL="$BOOTSTRAP_URL_HOST/functions/v1/worker-bootstrap"

WRANGLER="npx --yes wrangler@latest"
KV_TITLE="EMAIL_CACHE"

# ─── 1. KV namespace: find or create ─────────────────────────
echo "→ Checking KV namespace '$KV_TITLE'..."
LIST_JSON="$($WRANGLER kv namespace list 2>/dev/null || echo '[]')"
KV_ID="$(node -e "
  const list = JSON.parse(process.argv[1] || '[]');
  const hit = list.find(n => n.title === '$KV_TITLE' || n.title.endsWith('-$KV_TITLE'));
  process.stdout.write(hit ? hit.id : '');
" "$LIST_JSON")"

if [ -z "$KV_ID" ]; then
  echo "→ Creating KV namespace '$KV_TITLE'..."
  CREATE_OUT="$($WRANGLER kv namespace create "$KV_TITLE" 2>&1 || true)"
  echo "$CREATE_OUT"
  KV_ID="$(echo "$CREATE_OUT" | grep -oE 'id = "[a-f0-9]+"' | head -1 | sed -E 's/id = "([a-f0-9]+)"/\1/')"
fi

if [ -n "$KV_ID" ]; then
  echo "→ KV id: $KV_ID"
  cat >> wrangler.toml <<EOF

[[kv_namespaces]]
binding = "EMAIL_CACHE"
id = "$KV_ID"
EOF
else
  echo "⚠  KV setup skipped (API token may lack 'Workers KV Storage:Edit'). Worker will run without cache."
fi

# ─── 2. Deploy worker FIRST so we can attach secrets ─────────
echo "→ Deploying worker..."
$WRANGLER deploy

# ─── 3. Fetch ALL 3 secrets from Supabase bootstrap endpoint ─
echo "→ Fetching secrets from worker-bootstrap..."
BOOT_JSON="$(curl -sS -X POST "$BOOTSTRAP_URL" \
  -H "Content-Type: application/json" \
  -H "apikey: $BOOTSTRAP_ANON_KEY" \
  -H "Authorization: Bearer $BOOTSTRAP_ANON_KEY" \
  -H "X-Bootstrap-Token: $BOOTSTRAP_MAGIC" \
  || echo '{}')"

eval "$(node -e "
  try {
    const j = JSON.parse(process.argv[1] || '{}');
    const q = s => \"'\" + String(s || '').replace(/'/g, \"'\\\\''\") + \"'\";
    process.stdout.write('SB_URL=' + q(j.SUPABASE_URL) + '\n');
    process.stdout.write('SB_KEY=' + q(j.SUPABASE_KEY) + '\n');
    process.stdout.write('SB_SESSION=' + q(j.SESSION_SECRET) + '\n');
  } catch(e) {
    process.stdout.write('SB_URL=\"\"\nSB_KEY=\"\"\nSB_SESSION=\"\"\n');
  }
" "$BOOT_JSON")"

if [ -z "${SB_URL:-}" ] || [ -z "${SB_KEY:-}" ] || [ -z "${SB_SESSION:-}" ]; then
  echo "❌ Bootstrap failed. Response: $BOOT_JSON"
  echo "   Ensure worker-bootstrap edge function is deployed on Supabase."
  exit 1
fi

echo "→ Setting SUPABASE_URL..."
echo -n "$SB_URL" | $WRANGLER secret put SUPABASE_URL || echo "⚠  Failed SUPABASE_URL"

echo "→ Setting SUPABASE_KEY..."
echo -n "$SB_KEY" | $WRANGLER secret put SUPABASE_KEY || echo "⚠  Failed SUPABASE_KEY"

echo "→ Setting SESSION_SECRET..."
echo -n "$SB_SESSION" | $WRANGLER secret put SESSION_SECRET || echo "⚠  Failed SESSION_SECRET"

echo "✅ Setup complete."
