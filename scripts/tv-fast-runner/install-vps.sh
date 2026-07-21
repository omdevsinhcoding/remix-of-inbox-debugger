#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/etc/tv-fast-runner.env"
SERVICE_FILE="/etc/systemd/system/tv-fast-runner.service"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/tv-fast-runner/install-vps.sh" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<'EOF'
PORT=8788
TV_LOGIN_MAX_MS=9000
TV_REPORT_URL=https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/manage-app
TV_REPORT_HMAC_KEY=paste_the_same_value_as_supabase_TV_REPORT_HMAC_KEY
EOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Put your real TV_REPORT_HMAC_KEY there, then rerun this script." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl nodejs npm
cd "$APP_DIR"
npm install
npx playwright install --with-deps chromium

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Warm TV Login Fast Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tv-fast-runner
systemctl status tv-fast-runner --no-pager