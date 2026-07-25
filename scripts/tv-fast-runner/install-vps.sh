#!/usr/bin/env bash
# One-shot VPS installer / updater for tv-fast-runner.
#
# Idempotent: safe to re-run to pick up new code from the checked-out repo.
# Root-cause history: earlier revisions of this script only created the env
# file on the very first run and never pulled fresh code, so once a VPS had
# been provisioned it would silently keep serving stale server.mjs. This
# revision:
#   - always writes the CURRENT recommended defaults (backing up the old
#     env file to /etc/tv-fast-runner.env.bak) so timeout drift can't happen,
#   - runs `git pull --ff-only` when APP_DIR is a git worktree,
#   - reinstalls deps,
#   - restarts the systemd unit,
#   - prints /health so the caller can visually confirm the deployed
#     SERVER_VERSION matches the repo.
#
# Preserves TV_REPORT_HMAC_KEY from the previous env file (it's a shared
# secret you don't want to clobber).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$APP_DIR/../.." && pwd)"
ENV_FILE="/etc/tv-fast-runner.env"
SERVICE_FILE="/etc/systemd/system/tv-fast-runner.service"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/tv-fast-runner/install-vps.sh" >&2
  exit 1
fi

# ── Preserve existing HMAC key across re-installs ────────────────────────
EXISTING_HMAC=""
if [[ -f "$ENV_FILE" ]]; then
  # Strip surrounding whitespace and any wrapping single/double quotes so
  # we re-emit a clean unquoted value below. Previously a value like
  # TV_REPORT_HMAC_KEY="abc" round-tripped as ="abc"" which broke HMAC.
  EXISTING_HMAC="$(grep -E '^TV_REPORT_HMAC_KEY=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  EXISTING_HMAC="${EXISTING_HMAC#"${EXISTING_HMAC%%[![:space:]]*}"}"
  EXISTING_HMAC="${EXISTING_HMAC%"${EXISTING_HMAC##*[![:space:]]}"}"
  EXISTING_HMAC="${EXISTING_HMAC%\"}"; EXISTING_HMAC="${EXISTING_HMAC#\"}"
  EXISTING_HMAC="${EXISTING_HMAC%\'}"; EXISTING_HMAC="${EXISTING_HMAC#\'}"
  cp -a "$ENV_FILE" "${ENV_FILE}.bak"
fi

# ── Write the CURRENT recommended defaults ───────────────────────────────
# TV_LOGIN_MAX_MS=24000 matches scripts/tv-fast-runner/server.mjs.
cat >"$ENV_FILE" <<EOF
PORT=8788
TV_LOGIN_MAX_MS=24000
TV_RUNNER_CONCURRENCY=4
TV_REPORT_URL=https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/manage-app
TV_REPORT_HMAC_KEY=$EXISTING_HMAC
EOF
chmod 600 "$ENV_FILE"

if [[ -z "$EXISTING_HMAC" ]]; then
  echo "WARNING: TV_REPORT_HMAC_KEY is empty in $ENV_FILE." >&2
  echo "         Paste the shared HMAC (same value set in the Supabase secret" >&2
  echo "         TV_REPORT_HMAC_KEY and the GitHub Actions repo secret) and" >&2
  echo "         re-run this script." >&2
fi

# ── Refresh code from the repo when this is a git worktree ───────────────
# Fatal on failure: previously `git pull || echo "..."` swallowed errors and
# the version check further below then compared the local (stale) server.mjs
# against itself, so install reported success while deploying the exact
# stale build we were trying to replace.
COMMIT_SHA="unknown"
if [[ -d "$REPO_DIR/.git" ]]; then
  echo "▶ git fetch + pull --ff-only in $REPO_DIR"
  BEFORE_SHA="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  git -C "$REPO_DIR" fetch --quiet || { echo "ERROR: git fetch failed" >&2; exit 5; }
  UPSTREAM="$(git -C "$REPO_DIR" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)"
  if [[ -n "$UPSTREAM" ]]; then
    REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse @{u})"
    if [[ "$BEFORE_SHA" != "$REMOTE_SHA" ]]; then
      git -C "$REPO_DIR" pull --ff-only || { echo "ERROR: git pull --ff-only failed (diverged or dirty tree). Resolve manually and re-run." >&2; exit 5; }
    fi
  else
    echo "  (no upstream tracking branch; skipping remote compare)"
  fi
  COMMIT_SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD || echo unknown)"
else
  echo "▶ $REPO_DIR is not a git worktree; skipping git pull."
fi

# ── System deps ──────────────────────────────────────────────────────────
# apt's default `nodejs` package on Ubuntu 22.04 LTS is Node 12.22.9, which
# is far below Playwright 1.48's Node 18+ requirement and lacks
# `AbortSignal.timeout` (Node 17+) that server.mjs uses. Install the current
# LTS from NodeSource whenever a supported node is not already on PATH.
# Ref: https://playwright.dev/docs/intro#system-requirements
#      https://github.com/nodesource/distributions
apt-get update
apt-get install -y ca-certificates curl gnupg git
NEED_NODESOURCE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "${NODE_MAJOR:-0}" -ge 20 ]]; then NEED_NODESOURCE=0; fi
fi
if [[ "$NEED_NODESOURCE" -eq 1 ]]; then
  echo "▶ Installing Node.js 20.x from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

cd "$APP_DIR"
npm install --omit=dev
npx playwright install --with-deps chromium

# ── systemd unit ─────────────────────────────────────────────────────────
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Warm TV Login Fast Runner
After=network-online.target
Wants=network-online.target
# Never give up restarting — required for true 24/7 uptime.
StartLimitIntervalSec=0
StartLimitBurst=0

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=COMMIT_SHA=$COMMIT_SHA
ExecStart=/usr/bin/node $APP_DIR/server.mjs
# Aggressive self-heal: restart on any exit reason.
Restart=always
RestartSec=2
# Node/Chromium can be memory-hungry; if the box OOM-reaps us, come back fast.
OOMPolicy=continue
# Raise fd limit for many concurrent Playwright contexts.
LimitNOFILE=65536
# Kill lingering child processes (Chromium) when the unit stops/restarts.
KillMode=mixed
TimeoutStopSec=15
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tv-fast-runner
systemctl restart tv-fast-runner
sleep 2

# ── Strict deploy verification ───────────────────────────────────────────
# Fails the install if the running /health does NOT expose the same
# SERVER_VERSION string that exists in the repo's server.mjs, or if the
# deployed max_ms is below the 15s floor. Prevents the "install said OK
# but VPS is still stale / still on 9s timeout" failure mode that caused
# every runner_timeout in July 2026.
REPO_VERSION="$(grep -E '^const SERVER_VERSION' "$APP_DIR/server.mjs" | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')"
HEALTH_PORT="$(grep -E '^PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- || echo 8788)"
HEALTH_PORT="${HEALTH_PORT:-8788}"

echo
echo "──────── deploy verification ────────"
systemctl status tv-fast-runner --no-pager | head -n 8 || true
echo
echo "GET /health (port ${HEALTH_PORT}):"
HEALTH_JSON="$(curl -sS --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/health" || true)"
echo "$HEALTH_JSON"
echo

DEPLOYED_VERSION="$(printf '%s' "$HEALTH_JSON" | sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
DEPLOYED_MAX_MS="$(printf '%s' "$HEALTH_JSON" | sed -nE 's/.*"max_ms"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | head -n1)"

echo "repo SERVER_VERSION = $REPO_VERSION"
echo "deployed version    = ${DEPLOYED_VERSION:-<none>}"
echo "deployed max_ms     = ${DEPLOYED_MAX_MS:-<none>}"

if [[ -z "$DEPLOYED_VERSION" ]]; then
  echo "ERROR: /health did not return a version field. tv-fast-runner is not serving traffic." >&2
  exit 2
fi
if [[ "$DEPLOYED_VERSION" != "$REPO_VERSION" ]]; then
  echo "ERROR: VPS runs SERVER_VERSION=$DEPLOYED_VERSION but repo has $REPO_VERSION." >&2
  echo "       systemd probably failed to restart, or an older worktree is in \$APP_DIR." >&2
  exit 3
fi
if [[ -n "$DEPLOYED_MAX_MS" ]] && (( DEPLOYED_MAX_MS < 20000 )); then
  echo "ERROR: deployed max_ms=$DEPLOYED_MAX_MS is below the 20000ms floor." >&2
  echo "       The env file was not applied. Check $ENV_FILE and restart the unit." >&2
  exit 4
fi

echo
echo "✓ tv-fast-runner v$DEPLOYED_VERSION deployed at commit ${COMMIT_SHA} with max_ms=${DEPLOYED_MAX_MS}ms."
