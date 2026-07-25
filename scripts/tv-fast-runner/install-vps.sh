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
  EXISTING_HMAC="$(grep -E '^TV_REPORT_HMAC_KEY=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  cp -a "$ENV_FILE" "${ENV_FILE}.bak"
fi

# ── Write the CURRENT recommended defaults ───────────────────────────────
# TV_LOGIN_MAX_MS=20000 matches scripts/tv-fast-runner/server.mjs.
cat >"$ENV_FILE" <<EOF
PORT=8788
TV_LOGIN_MAX_MS=20000
TV_RUNNER_CONCURRENCY=4
TV_REPORT_URL=https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/manage-app
TV_REPORT_HMAC_KEY=${EXISTING_HMAC}
EOF
chmod 600 "$ENV_FILE"

if [[ -z "$EXISTING_HMAC" ]]; then
  echo "WARNING: TV_REPORT_HMAC_KEY is empty in $ENV_FILE." >&2
  echo "         Paste the shared HMAC (same value set in the Supabase secret" >&2
  echo "         TV_REPORT_HMAC_KEY and the GitHub Actions repo secret) and" >&2
  echo "         re-run this script." >&2
fi

# ── Refresh code from the repo when this is a git worktree ───────────────
if [[ -d "$REPO_DIR/.git" ]]; then
  echo "▶ git pull --ff-only in $REPO_DIR"
  git -C "$REPO_DIR" pull --ff-only || echo "  (pull skipped — resolve manually if code is out of date)"
  COMMIT_SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD || echo unknown)"
else
  COMMIT_SHA="unknown"
  echo "▶ $REPO_DIR is not a git worktree; skipping git pull."
fi

# ── System deps ──────────────────────────────────────────────────────────
apt-get update
apt-get install -y ca-certificates curl nodejs

cd "$APP_DIR"
npm install --omit=dev
npx playwright install --with-deps chromium

# ── systemd unit ─────────────────────────────────────────────────────────
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Warm TV Login Fast Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=COMMIT_SHA=$COMMIT_SHA
ExecStart=/usr/bin/node $APP_DIR/server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tv-fast-runner
systemctl restart tv-fast-runner
sleep 2

echo
echo "──────── deploy verification ────────"
systemctl status tv-fast-runner --no-pager | head -n 8 || true
echo
echo "GET /health:"
curl -sS --max-time 5 "http://127.0.0.1:${PORT:-8788}/health" || echo "  health probe failed"
echo
echo
echo "Compare the 'version' field above with SERVER_VERSION in scripts/tv-fast-runner/server.mjs."
echo "They MUST match. If they don't, the VPS is serving stale code."
