#!/usr/bin/env bash
# Universal Cloudflare Worker deploy wrapper.
# Cloudflare Workers Builds should run this as the Deploy command:
#   Deploy command = `npx wrangler deploy` or `bash setup.sh <worker-name>`
# Example:
#   bash setup.sh feeedda
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
WORKER_NAME="${1:-${WORKER_NAME:-${CLOUDFLARE_WORKER_NAME:-feeedda}}}"

if [ -z "$WORKER_NAME" ]; then
  echo "❌ Worker name missing. In Cloudflare Deploy command use: bash setup.sh YOUR_WORKER_NAME"
  echo "   Example: bash setup.sh feeedda"
  exit 1
fi

echo "→ Deploying universal Worker with KV auto-create + binding..."
CLOUDFLARE_WORKER_NAME="$WORKER_NAME" node deploy.mjs

echo "✅ Cloudflare Worker deploy complete: KV binding + built-in Supabase config."
