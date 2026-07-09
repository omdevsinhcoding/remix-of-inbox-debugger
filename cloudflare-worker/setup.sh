#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Auto-KV setup for Cloudflare Workers Builds
# ─────────────────────────────────────────────────────────────
# Runs in Cloudflare's build step BEFORE `npx wrangler deploy`.
# Uses the same API token the build is already authenticated with
# (CLOUDFLARE_API_TOKEN is injected automatically by CF Builds),
# so no manual config is needed per account.
#
# What it does:
#   1. Lists KV namespaces in this account.
#   2. Finds one titled "EMAIL_CACHE" — creates it if missing.
#   3. Appends a [[kv_namespaces]] binding with that ID into wrangler.toml.
#
# Requirement: the API token used to connect Git must include
# "Workers KV Storage: Edit" permission. (The default CF-generated
# "Workers Builds" token already has it.)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

KV_TITLE="EMAIL_CACHE"

echo "→ Checking for KV namespace '$KV_TITLE'..."

# List existing namespaces
LIST_JSON="$(npx --yes wrangler@latest kv namespace list 2>/dev/null || echo '[]')"

# Extract id where title == EMAIL_CACHE (portable jq-less parsing)
KV_ID="$(node -e "
  const list = JSON.parse(process.argv[1] || '[]');
  const hit = list.find(n => n.title === '$KV_TITLE' || n.title.endsWith('-$KV_TITLE'));
  process.stdout.write(hit ? hit.id : '');
" "$LIST_JSON")"

if [ -z "$KV_ID" ]; then
  echo "→ Not found. Creating KV namespace '$KV_TITLE'..."
  CREATE_OUT="$(npx --yes wrangler@latest kv namespace create "$KV_TITLE" 2>&1)"
  echo "$CREATE_OUT"
  # wrangler prints: id = "abc123..."  — grab it
  KV_ID="$(echo "$CREATE_OUT" | grep -oE 'id = "[a-f0-9]+"' | head -1 | sed -E 's/id = "([a-f0-9]+)"/\1/')"
fi

if [ -z "$KV_ID" ]; then
  echo "⚠  Could not determine KV namespace ID. Deploying WITHOUT KV binding."
  echo "   (Worker will still run — caching disabled. Check API token has 'Workers KV Storage: Edit'.)"
  exit 0
fi

echo "→ Using KV namespace id: $KV_ID"

# Append binding (idempotent — safe even if already present, wrangler will just overwrite)
cat >> wrangler.toml <<EOF

[[kv_namespaces]]
binding = "EMAIL_CACHE"
id = "$KV_ID"
EOF

echo "→ Final wrangler.toml:"
cat wrangler.toml
