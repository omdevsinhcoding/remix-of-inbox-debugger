#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# TRUE ZERO-CONFIG SETUP for Cloudflare Workers Builds
# ─────────────────────────────────────────────────────────────
# You only click "Connect to Git" in Cloudflare. Everything else is automatic:
#   1. KV namespace EMAIL_CACHE  — create if missing, bind to worker
#   2. SUPABASE_URL              — hardcoded (publishable)
#   3. SUPABASE_KEY (anon)       — hardcoded (publishable)
#   4. SESSION_SECRET            — fetched at build time from Supabase
#                                   worker-bootstrap endpoint
#   5. Deploy
#
# Requirements per Cloudflare account (one-time, via the API token used to
# connect Git): permissions Workers Scripts:Edit + Workers KV Storage:Edit.
# Cloudflare's default "Workers Builds" token template has both.
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# --- Hardcoded public values (safe — publishable/anon key) ---
SUPABASE_URL_VALUE="https://jsqchutnfdeljajkxmly.supabase.co"
SUPABASE_KEY_VALUE="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA"

# Bootstrap magic — MUST match BOOTSTRAP_MAGIC in
# supabase/functions/worker-bootstrap/index.ts
BOOTSTRAP_MAGIC="wkr_bootstrap_2026_netflixfetch_auto_v1"
BOOTSTRAP_URL="$SUPABASE_URL_VALUE/functions/v1/worker-bootstrap"

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

# ─── 3. Push SUPABASE_URL + SUPABASE_KEY (hardcoded) ─────────
echo "→ Setting SUPABASE_URL..."
echo -n "$SUPABASE_URL_VALUE" | $WRANGLER secret put SUPABASE_URL || echo "⚠  Failed SUPABASE_URL"

echo "→ Setting SUPABASE_KEY..."
echo -n "$SUPABASE_KEY_VALUE" | $WRANGLER secret put SUPABASE_KEY || echo "⚠  Failed SUPABASE_KEY"

# ─── 4. Fetch SESSION_SECRET from Supabase bootstrap endpoint ─
echo "→ Fetching SESSION_SECRET from worker-bootstrap..."
BOOT_JSON="$(curl -sS -X POST "$BOOTSTRAP_URL" \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_KEY_VALUE" \
  -H "Authorization: Bearer $SUPABASE_KEY_VALUE" \
  -H "X-Bootstrap-Token: $BOOTSTRAP_MAGIC" \
  || echo '{}')"

SESSION_SECRET_VALUE="$(node -e "
  try { const j = JSON.parse(process.argv[1] || '{}'); process.stdout.write(j.SESSION_SECRET || ''); }
  catch(e) { process.stdout.write(''); }
" "$BOOT_JSON")"

if [ -n "$SESSION_SECRET_VALUE" ]; then
  echo "→ Setting SESSION_SECRET..."
  echo -n "$SESSION_SECRET_VALUE" | $WRANGLER secret put SESSION_SECRET || echo "⚠  Failed SESSION_SECRET"
else
  echo "⚠  Could not fetch SESSION_SECRET from bootstrap endpoint. Response: $BOOT_JSON"
  echo "   Ensure the worker-bootstrap edge function is deployed on Supabase."
fi

echo "✅ Setup complete."
