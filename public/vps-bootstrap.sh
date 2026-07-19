#!/usr/bin/env bash
# =============================================================================
# Remote Browser Session Agent — one-shot bootstrap
# =============================================================================
# What this does on a fresh Ubuntu/Debian VPS (run as root):
#   1. Purges leftover chromium / snap / kasm / neko / large caches (safe cleanup)
#   2. Installs: Chromium, Xvfb, x11vnc, websockify+noVNC, Node.js LTS, Caddy
#   3. Writes a small Node "agent" that manages persistent browser sessions
#      (each session = its own Chromium + user-data-dir + Xvfb + VNC port)
#   4. Fronts the agent + noVNC with Caddy on HTTPS using sslip.io
#      (auto Let's Encrypt cert for  <ip-with-dashes>.sslip.io)
#   5. Prints the HTTPS base URL + a random AGENT_TOKEN to paste into the app
#
# Usage:
#   curl -fsSL https://<your-lovable-app>/vps-bootstrap.sh | sudo bash
# =============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (use: sudo bash $0)" >&2
  exit 1
fi

echo ">>> [1/6] Detecting public IP…"
PUBIP="$(curl -fsSL https://api.ipify.org || curl -fsSL https://ifconfig.me)"
if [[ -z "${PUBIP}" ]]; then echo "Could not detect public IP" >&2; exit 1; fi
SSLIP_HOST="${PUBIP//./-}.sslip.io"
echo "    Public IP : ${PUBIP}"
echo "    HTTPS host: ${SSLIP_HOST}"

echo ">>> [2/6] Cleaning leftover browser/session junk…"
systemctl stop rbs-agent 2>/dev/null || true
systemctl stop caddy 2>/dev/null || true
pkill -9 chromium chromium-browser chrome google-chrome Xvfb x11vnc websockify node 2>/dev/null || true
apt-get -y purge 'chromium*' 'google-chrome*' 'kasm*' 'neko*' 2>/dev/null || true
snap remove --purge chromium 2>/dev/null || true
rm -rf /var/lib/rbs /var/log/rbs /opt/rbs /opt/novnc /root/.cache/chromium /root/.config/chromium /tmp/.X*-lock /tmp/.X11-unix/* 2>/dev/null || true
apt-get -y autoremove --purge >/dev/null
apt-get -y clean >/dev/null

echo ">>> [3/6] Installing packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg jq ufw \
  chromium chromium-sandbox \
  xvfb x11vnc websockify novnc \
  fonts-liberation fonts-noto-color-emoji libnss3 libatk-bridge2.0-0 libgbm1 \
  >/dev/null 2>&1 || apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg jq ufw \
  chromium-browser \
  xvfb x11vnc websockify novnc \
  fonts-liberation fonts-noto-color-emoji libnss3 libatk-bridge2.0-0 libgbm1 >/dev/null

# Node 20 LTS
if ! command -v node >/dev/null || [[ "$(node -v 2>/dev/null | cut -c2-3)" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi

# Caddy
if ! command -v caddy >/dev/null; then
  curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    | sed 's|^deb |deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] |' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y >/dev/null
  apt-get install -y caddy >/dev/null
fi

CHROMIUM_BIN="$(command -v chromium || command -v chromium-browser)"
NOVNC_DIR="/usr/share/novnc"
[[ -d "$NOVNC_DIR" ]] || NOVNC_DIR="/usr/share/webapps/novnc"

echo ">>> [4/6] Writing agent…"
mkdir -p /opt/rbs /var/lib/rbs/sessions /var/log/rbs
AGENT_TOKEN="$(openssl rand -hex 24)"
echo "$AGENT_TOKEN" > /opt/rbs/token

cat >/opt/rbs/agent.mjs <<'AGENT_EOF'
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = readFileSync("/opt/rbs/token", "utf8").trim();
const CHROMIUM = process.env.CHROMIUM_BIN;
const ROOT = "/var/lib/rbs/sessions";
const STATE_FILE = "/var/lib/rbs/state.json";
const PORT_BASE = 6900; // websockify ports 6900..6999
mkdirSync(ROOT, { recursive: true });

/** state: { [id]: { name, port, display, pids:{xvfb,x11vnc,ws,chromium}, createdAt } } */
let state = {};
try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch {}
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function pickSlot() {
  const used = new Set(Object.values(state).map(s => s.port));
  for (let p = PORT_BASE; p < PORT_BASE + 100; p++) if (!used.has(p)) return p;
  throw new Error("no free ports");
}

import { openSync } from "node:fs";
function spawnBg(cmd, args, logfile, env) {
  const fd = openSync(logfile, "a");
  const p = spawn(cmd, args, { detached: true, env: env || process.env, stdio: ["ignore", fd, fd] });
  p.unref();
  return p.pid;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startSession(id, name) {
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  const port = pickSlot();
  const display = port - PORT_BASE + 90; // :90, :91, ...
  const vncPort = 5900 + (port - PORT_BASE);
  const log = `/var/log/rbs/${id}.log`;

  const xvfbPid = spawnBg("Xvfb", [`:${display}`, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], log);
  await sleep(600);
  const chromiumPid = spawnBg(CHROMIUM, [
    "--no-sandbox","--no-first-run","--no-default-browser-check",
    "--disable-gpu","--disable-dev-shm-usage",
    "--start-maximized","--window-size=1280,800",
    `--user-data-dir=${dir}`,
    "https://www.netflix.com/login"
  ], log, { ...process.env, DISPLAY: `:${display}` });


  await sleep(800);
  const x11vncPid = spawnBg("x11vnc", [
    "-display", `:${display}`, "-nopw", "-forever", "-shared",
    "-rfbport", String(5900 + (port - PORT_BASE)), "-quiet"
  ], log);
  await sleep(400);
  const wsPid = spawnBg("websockify", [
    "--web", process.env.NOVNC_DIR,
    String(port), `localhost:${5900 + (port - PORT_BASE)}`
  ], log);

  state[id] = { name, port, display, pids:{ xvfb:xvfbPid, chromium:chromiumPid, x11vnc:x11vncPid, ws:wsPid }, createdAt: Date.now() };
  saveState();
  return state[id];
}

function stopSession(id, purge=false) {
  const s = state[id];
  if (!s) return;
  for (const pid of Object.values(s.pids)) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
  if (purge) { try { rmSync(join(ROOT, id), { recursive:true, force:true }); } catch {} }
  delete state[id];
  saveState();
}

function auth(req) {
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}

async function readJson(req) {
  const bufs = []; for await (const c of req) bufs.push(c);
  const s = Buffer.concat(bufs).toString("utf8") || "{}";
  return JSON.parse(s);
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (!auth(req)) { res.writeHead(401); return res.end("unauthorized"); }

  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/sessions") {
      // sync: prune dead
      for (const [id, s] of Object.entries(state)) {
        const anyAlive = Object.values(s.pids).some(alive);
        if (!anyAlive) delete state[id];
      }
      saveState();
      // list saved profiles too (existing dirs not currently running)
      const running = new Set(Object.keys(state));
      const saved = readdirSync(ROOT).filter(d => !running.has(d)).map(id => ({ id, name: id, running:false }));
      const live = Object.entries(state).map(([id, s]) => ({ id, name: s.name, port: s.port, running:true, createdAt:s.createdAt }));
      res.writeHead(200, { "Content-Type":"application/json" });
      return res.end(JSON.stringify({ sessions:[...live, ...saved] }));
    }

    if (req.method === "POST" && url.pathname === "/sessions") {
      const { id, name } = await readJson(req);
      if (!id || !/^[a-z0-9_-]{1,40}$/i.test(id)) { res.writeHead(400); return res.end("bad id"); }
      if (state[id]) { res.writeHead(200, { "Content-Type":"application/json" }); return res.end(JSON.stringify(state[id])); }
      const s = await startSession(id, name || id);
      res.writeHead(200, { "Content-Type":"application/json" });
      return res.end(JSON.stringify({ id, ...s }));
    }

    if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/stop")) {
      const id = url.pathname.split("/")[2];
      stopSession(id, false);
      res.writeHead(200); return res.end("stopped");
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      const id = url.pathname.split("/")[2];
      stopSession(id, true);
      res.writeHead(200); return res.end("deleted");
    }

    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(500); res.end(String(e?.message || e));
  }
});

server.listen(7070, "127.0.0.1", () => console.log("agent on :7070"));
AGENT_EOF

cat >/etc/systemd/system/rbs-agent.service <<EOF
[Unit]
Description=Remote Browser Session Agent
After=network.target
[Service]
Environment=CHROMIUM_BIN=${CHROMIUM_BIN}
Environment=NOVNC_DIR=${NOVNC_DIR}
ExecStart=/usr/bin/node /opt/rbs/agent.mjs
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

echo ">>> [5/6] Writing Caddy config (HTTPS via sslip.io)…"
cat >/etc/caddy/Caddyfile <<EOF
${SSLIP_HOST} {
  encode gzip

  @agent path /api/*
  handle @agent {
    uri strip_prefix /api
    reverse_proxy 127.0.0.1:7070
  }

  # noVNC viewers: /vnc/<port>/  proxies to that websockify instance
  @vnc path_regexp vnc ^/vnc/([0-9]+)(/.*)?$
  handle @vnc {
    uri strip_prefix /vnc
    rewrite * /{re.vnc.1}{re.vnc.2}
    reverse_proxy 127.0.0.1:{re.vnc.1}
  }

  respond "rbs-agent up" 200
}
EOF

ufw allow 22/tcp  >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true

systemctl daemon-reload
systemctl enable --now rbs-agent >/dev/null
systemctl restart caddy

echo ">>> [6/6] Waiting for HTTPS cert…"
for i in {1..30}; do
  if curl -fsSL "https://${SSLIP_HOST}/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

cat <<DONE

=============================================================================
  DONE. Paste these two values into the admin panel > Connect with VPS:

    Agent base URL : https://${SSLIP_HOST}
    Agent token    : ${AGENT_TOKEN}

  Test:
    curl -H "Authorization: Bearer ${AGENT_TOKEN}" https://${SSLIP_HOST}/api/sessions
=============================================================================
DONE
