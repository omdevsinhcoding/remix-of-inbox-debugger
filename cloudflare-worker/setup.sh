#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# FULL AUTO SETUP for Cloudflare Workers Builds
# ─────────────────────────────────────────────────────────────
# Runs before `npx wrangler deploy`. Does everything automatically:
#   1. Finds/creates the EMAIL_CACHE KV namespace and binds it
#   2. Sets SUPABASE_URL and SUPABASE_KEY secrets (safe public values)
#   3. Deploys worker
#
# The ONLY thing you can't fully automate is SESSION_SECRET — it's a real
# secret that must match your Supabase project's SESSION_SECRET. It gets
# read from a Cloudflare Build Variable named SESSION_SECRET if present;
# otherwise setup skips it and the worker uses a fallback (see bottom).
#
# Uses CLOUDFLARE_API_TOKEN that Cloudflare Builds injects automatically.
# API token must have: Workers Scripts:Edit, Workers KV Storage:Edit.
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# --- Hardcoded PUBLIC values (safe to commit — publishable/anon key) ---
SUPABASE_URL_VALUE="https://jsqchutnfdeljajkxmly.supabase.co"
SUPABASE_KEY_VALUE="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA"

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
  echo "⚠  KV setup skipped (token may lack 'Workers KV Storage:Edit'). Worker will run without cache."
fi

# ─── 2. Deploy worker FIRST so we can attach secrets to it ───
echo "→ Deploying worker..."
$WRANGLER deploy

# ─── 3. Push public secrets automatically ────────────────────
echo "→ Setting SUPABASE_URL secret..."
echo -n "$SUPABASE_URL_VALUE" | $WRANGLER secret put SUPABASE_URL || echo "⚠  Failed to set SUPABASE_URL"

echo "→ Setting SUPABASE_KEY secret..."
echo -n "$SUPABASE_KEY_VALUE" | $WRANGLER secret put SUPABASE_KEY || echo "⚠  Failed to set SUPABASE_KEY"

# ─── 4. SESSION_SECRET (from build variable if provided) ─────
if [ -n "${SESSION_SECRET:-}" ]; then
  echo "→ Setting SESSION_SECRET secret from build variable..."
  echo -n "$SESSION_SECRET" | $WRANGLER secret put SESSION_SECRET || echo "⚠  Failed to set SESSION_SECRET"
else
  echo "ℹ  SESSION_SECRET not provided as build variable — set it once in dashboard if not already set."
fi

echo "✅ Setup complete."
