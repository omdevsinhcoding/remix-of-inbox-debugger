#!/usr/bin/env bash
# Universal Cloudflare Worker deploy wrapper.
# Cloudflare Workers Builds should run this as the Deploy command:
#   Deploy command = `bash setup.sh <worker-name>`
# Example:
#   bash setup.sh netflixfetch
# Build command can stay empty.
# The worker has public Supabase config built in and validates sessions through
# Supabase, so no Cloudflare runtime secrets or env injection are required.

set -euo pipefail

if [ "${SKIP_CF_AUTO_BOOTSTRAP:-}" = "1" ]; then
  echo "→ Inner deploy: bootstrap skipped."
  exit 0
fi

if [ "${WRANGLER_COMMAND:-}" = "dev" ] || [ "${WRANGLER_COMMAND:-}" = "types" ]; then
  echo "→ Local/dev wrangler command detected; bootstrap skipped."
  exit 0
fi

WRANGLER="npx --yes wrangler@latest"
WORKER_NAME="${1:-${WORKER_NAME:-${CLOUDFLARE_WORKER_NAME:-}}}"

if [ -z "$WORKER_NAME" ]; then
  echo "❌ Worker name missing. In Cloudflare Deploy command use: bash setup.sh YOUR_WORKER_NAME"
  echo "   Example: bash setup.sh netflixfetch"
  exit 1
fi

echo "→ Deploying universal Worker with auto KV provisioning..."
SKIP_CF_AUTO_BOOTSTRAP=1 $WRANGLER deploy --name "$WORKER_NAME" --keep-vars

echo "✅ Cloudflare Worker deploy complete: KV binding + built-in Supabase config."
