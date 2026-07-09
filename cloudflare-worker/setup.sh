#!/usr/bin/env bash
# Full-auto Cloudflare Worker bootstrap.
# Works in both Cloudflare Git modes:
#   1) Deploy command = `npx wrangler deploy` → wrangler.toml [build] runs this.
#   2) Build command = `bash setup.sh` → this script deploys by itself.

set -euo pipefail

if [ "${SKIP_CF_AUTO_BOOTSTRAP:-}" = "1" ]; then
  echo "→ Inner deploy: bootstrap skipped."
  exit 0
fi

if [ "${WRANGLER_COMMAND:-}" = "dev" ] || [ "${WRANGLER_COMMAND:-}" = "types" ]; then
  echo "→ Local/dev wrangler command detected; bootstrap skipped."
  exit 0
fi

BOOTSTRAP_URL_HOST="https://jsqchutnfdeljajkxmly.supabase.co"
BOOTSTRAP_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA"
BOOTSTRAP_URL="$BOOTSTRAP_URL_HOST/functions/v1/worker-bootstrap"
WRANGLER="npx --yes wrangler@latest"
OUT_DIR=".wrangler/generated"
SECRETS_FILE="$OUT_DIR/worker-secrets.json"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "❌ CLOUDFLARE_API_TOKEN missing. Use Cloudflare Workers Builds/Git deploy with an API token that has Account Settings:Read, Workers Scripts:Edit, Workers KV Storage:Edit."
  exit 1
fi

echo "→ Fetching runtime config from Supabase bootstrap..."
BOOT_JSON="$(curl -sS -X POST "$BOOTSTRAP_URL" \
  -H "Content-Type: application/json" \
  -H "apikey: $BOOTSTRAP_ANON_KEY" \
  -H "Authorization: Bearer $BOOTSTRAP_ANON_KEY" \
  -H "X-CF-Token: $CLOUDFLARE_API_TOKEN" \
  || echo '{}')"

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" || true

node -e '
  const fs = require("fs");
  const j = JSON.parse(process.argv[1] || "{}");
  if (!j.SUPABASE_URL || !j.SUPABASE_KEY || !j.SESSION_SECRET) {
    console.error("❌ Bootstrap failed: " + (j.error || "missing values"));
    process.exit(1);
  }
  fs.writeFileSync(process.argv[2], JSON.stringify({
    SUPABASE_URL: j.SUPABASE_URL,
    SUPABASE_KEY: j.SUPABASE_KEY,
    SESSION_SIGNING_SECRET: j.SESSION_SECRET,
    SESSION_SECRET: j.SESSION_SECRET
  }, null, 2));
' "$BOOT_JSON" "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE" || true

echo "→ Deploying with auto KV provisioning + secrets-file..."
SKIP_CF_AUTO_BOOTSTRAP=1 $WRANGLER deploy --secrets-file "$SECRETS_FILE"

rm -f "$SECRETS_FILE"
echo "✅ Cloudflare Worker auto setup complete: KV binding + runtime secrets + deploy."
