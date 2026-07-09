#!/usr/bin/env bash
# Cloudflare Workers Builds — per-account config injector.
#
# In each Cloudflare account's Worker → Settings → Build → Build variables, set:
#   WORKER_NAME   (e.g. netflixfetch, inboxproxy, gmail2fetch — the worker's name in THIS account)
#   KV_ID         (that account's EMAIL_CACHE namespace id from KV dashboard)
#
# Optional:
#   KV_ID_V2      (second KV namespace id when the first fills up)
#
# Then set the Cloudflare "Build command" to:  bash build.sh
# and the "Deploy command" stays:              npx wrangler deploy

set -euo pipefail

: "${WORKER_NAME:?Build variable WORKER_NAME is not set in Cloudflare dashboard}"
: "${KV_ID:?Build variable KV_ID is not set in Cloudflare dashboard}"

echo "→ Injecting WORKER_NAME=$WORKER_NAME"
sed -i "s|__WORKER_NAME__|$WORKER_NAME|g" wrangler.toml

echo "→ Injecting KV_ID"
sed -i "s|__KV_ID__|$KV_ID|g" wrangler.toml

# Optional second KV namespace
if [ -n "${KV_ID_V2:-}" ]; then
  echo "→ Appending EMAIL_CACHE_V2 binding"
  cat >> wrangler.toml <<EOF

[[kv_namespaces]]
binding = "EMAIL_CACHE_V2"
id = "$KV_ID_V2"
EOF
fi

echo "→ Final wrangler.toml:"
cat wrangler.toml
