#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# TRUE ZERO-CONFIG SETUP for Cloudflare Workers Builds
# ─────────────────────────────────────────────────────────────
# Only "Connect to Git" in Cloudflare. Nothing else.
#
# What this script does automatically:
#   1. Create KV namespace EMAIL_CACHE if missing, bind to worker
#   2. Deploy the worker
#   3. Authenticate to Supabase using $CLOUDFLARE_API_TOKEN (auto-injected
#      by Cloudflare Workers Builds — NOT stored in git) — Supabase verifies
#      the token with Cloudflare and checks the account against an allowlist
#   4. Fetch SUPABASE_URL / SUPABASE_KEY / SESSION_SECRET and set them
#
# SECURITY: no shared secret lives in this repo. Auth is proof that the caller
# owns a Cloudflare account that's in the allowlist. First unknown account
# triggers a Telegram alert (trust-on-first-use).
# ─────────────────────────────────────────────────────────────

set -euo pipefail

BOOTSTRAP_URL_HOST="https://jsqchutnfdeljajkxmly.supabase.co"
# This anon key is publishable — safe to commit. It only lets us reach the
# Supabase edge function gateway; auth is done via CF token below.
BOOTSTRAP_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA"
BOOTSTRAP_URL="$BOOTSTRAP_URL_HOST/functions/v1/worker-bootstrap"

WRANGLER="npx --yes wrangler@latest"
KV_TITLE="EMAIL_CACHE"

# ─── Sanity check ─────────────────────────────────────────────
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "❌ CLOUDFLARE_API_TOKEN not set. This must run inside Cloudflare"
  echo "   Workers Builds — CF auto-injects the token there."
  exit 1
fi

# ─── 1. KV namespace: find or create (SHARED across workers in this account) ─
# Agar is CF account me pehle se koi worker ne EMAIL_CACHE bana rakha hai,
# to wahi KV reuse hoga — dono workers same cache/data share karenge.
echo "→ Checking KV namespace '$KV_TITLE' in this Cloudflare account..."
LIST_JSON="$($WRANGLER kv namespace list 2>/dev/null || echo '[]')"
KV_ID="$(node -e "
  const list = JSON.parse(process.argv[1] || '[]');
  const hit = list.find(n => n.title === '$KV_TITLE' || n.title.endsWith('-$KV_TITLE'));
  process.stdout.write(hit ? hit.id : '');
" "$LIST_JSON")"

if [ -n "$KV_ID" ]; then
  echo "→ Reusing existing KV namespace (id: $KV_ID) — shared with other workers on this account."
else
  echo "→ Creating new KV namespace '$KV_TITLE'..."
  CREATE_OUT="$($WRANGLER kv namespace create "$KV_TITLE" 2>&1 || true)"
  echo "$CREATE_OUT"
  KV_ID="$(echo "$CREATE_OUT" | grep -oE 'id = "[a-f0-9]+"' | head -1 | sed -E 's/id = "([a-f0-9]+)"/\1/')"
  [ -n "$KV_ID" ] && echo "→ Created KV id: $KV_ID"
fi

if [ -n "$KV_ID" ]; then
  # Prevent duplicate [[kv_namespaces]] block if script re-runs on same checkout
  if ! grep -q "^\[\[kv_namespaces\]\]" wrangler.toml; then
    cat >> wrangler.toml <<EOF

[[kv_namespaces]]
binding = "EMAIL_CACHE"
id = "$KV_ID"
EOF
    echo "→ Bound KV to this worker (binding: EMAIL_CACHE)"
  else
    echo "→ KV binding already present in wrangler.toml, skipping append."
  fi
else
  echo "⚠  KV setup skipped (token may lack 'Workers KV Storage:Edit'). Worker will run without cache."
fi

# ─── 2. Deploy worker (needed before secrets can be attached) ─
echo "→ Deploying worker..."
DEPLOY_OUT="$($WRANGLER deploy 2>&1 | tee /dev/stderr)"

# CF Workers Builds may override the worker name (CI project name != wrangler.toml name).
# Parse the actual deployed name from "Uploaded <name>" so `wrangler secret put`
# targets the SAME worker instead of the wrangler.toml default.
DEPLOYED_NAME="$(echo "$DEPLOY_OUT" | grep -oE 'Uploaded [a-zA-Z0-9_-]+' | head -1 | awk '{print $2}')"
CONFIG_NAME="$(grep -oE '^name = "[^"]+"' wrangler.toml | head -1 | sed -E 's/name = "([^"]+)"/\1/')"
if [ -n "$DEPLOYED_NAME" ] && [ "$DEPLOYED_NAME" != "$CONFIG_NAME" ]; then
  echo "→ CI overrode worker name: '$CONFIG_NAME' → '$DEPLOYED_NAME'. Patching wrangler.toml so secrets target the right worker..."
  sed -i.bak -E "s/^name = \"[^\"]+\"/name = \"$DEPLOYED_NAME\"/" wrangler.toml
  rm -f wrangler.toml.bak
fi

# ─── 3. Fetch secrets from Supabase using CF token as auth ───
echo "→ Fetching secrets from worker-bootstrap (auth = CF API token)..."
BOOT_JSON="$(curl -sS -X POST "$BOOTSTRAP_URL" \
  -H "Content-Type: application/json" \
  -H "apikey: $BOOTSTRAP_ANON_KEY" \
  -H "Authorization: Bearer $BOOTSTRAP_ANON_KEY" \
  -H "X-CF-Token: $CLOUDFLARE_API_TOKEN" \
  || echo '{}')"

eval "$(node -e "
  try {
    const j = JSON.parse(process.argv[1] || '{}');
    const q = s => \"'\" + String(s || '').replace(/'/g, \"'\\\\''\") + \"'\";
    process.stdout.write('SB_URL=' + q(j.SUPABASE_URL) + '\n');
    process.stdout.write('SB_KEY=' + q(j.SUPABASE_KEY) + '\n');
    process.stdout.write('SB_SESSION=' + q(j.SESSION_SECRET) + '\n');
    process.stdout.write('SB_ERR=' + q(j.error || '') + '\n');
  } catch(e) {
    process.stdout.write('SB_URL=\"\"\nSB_KEY=\"\"\nSB_SESSION=\"\"\nSB_ERR=\"parse failed\"\n');
  }
" "$BOOT_JSON")"

if [ -z "${SB_URL:-}" ] || [ -z "${SB_KEY:-}" ] || [ -z "${SB_SESSION:-}" ]; then
  echo "❌ Bootstrap failed: ${SB_ERR:-unknown}"
  echo "   Full response: $BOOT_JSON"
  echo ""
  echo "   Possible causes:"
  echo "   • CLOUDFLARE_API_TOKEN missing Account.Read permission (needed to verify account)"
  echo "   • Your Cloudflare account is not yet in the allowlist AND the cap is reached"
  echo "   • Check Telegram for a bootstrap-rejection alert"
  exit 1
fi

echo "→ Setting SUPABASE_URL..."
echo -n "$SB_URL" | $WRANGLER secret put SUPABASE_URL

echo "→ Setting SUPABASE_KEY..."
echo -n "$SB_KEY" | $WRANGLER secret put SUPABASE_KEY

echo "→ Setting SESSION_SECRET..."
echo -n "$SB_SESSION" | $WRANGLER secret put SESSION_SECRET

echo "✅ Setup complete."
