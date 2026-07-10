#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_CONFIG = join(__dirname, "wrangler.toml");
const BINDING = "EMAIL_CACHE";
const WRANGLER = ["--yes", "wrangler@latest"];
const WORKER_MAIN = join(__dirname, "worker.js").replace(/\\/g, "/");

function runWrangler(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync("npx", [...WRANGLER, ...args], {
    cwd: __dirname,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
    shell: process.platform === "win32",
  });

  if (!allowFailure && result.status !== 0) {
    if (capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }

  return result;
}

function parseJsonArray(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return [];
  }
}

function parseCreatedNamespaceId(output) {
  const idMatch = output.match(/\bid\s*=\s*["']([a-f0-9]{20,})["']/i) || output.match(/\b([a-f0-9]{32})\b/i);
  return idMatch?.[1] || "";
}

function patchKvId(configSource, namespaceId) {
  const withMain = /^main\s*=\s*["'][^"']+["']/m.test(configSource)
    ? configSource.replace(/^main\s*=\s*["'][^"']+["']/m, `main = "${WORKER_MAIN}"`)
    : `main = "${WORKER_MAIN}"\n${configSource}`;
  const blockRe = /\[\[kv_namespaces\]\][\s\S]*?(?=\n\[[^\[]|\n\[\[|$)/g;
  let patched = false;
  const next = withMain.replace(blockRe, (block) => {
    if (!new RegExp(`binding\\s*=\\s*["']${BINDING}["']`).test(block)) return block;
    patched = true;
    if (/\nid\s*=/.test(block)) return block.replace(/\nid\s*=\s*["'][^"']*["']/, `\nid = "${namespaceId}"`);
    return block.replace(/binding\s*=\s*["'][^"']*["']/, (line) => `${line}\nid = "${namespaceId}"`);
  });

  if (patched) return next;

  return `${configSource.trimEnd()}\n\n[[kv_namespaces]]\nbinding = "${BINDING}"\nid = "${namespaceId}"\n`;
}

function namespaceTitle(namespace) {
  return String(namespace.title || namespace.name || namespace.binding || "");
}

function findNamespace(namespaces) {
  return namespaces.find((namespace) => namespaceTitle(namespace) === BINDING) || null;
}

function ensureNamespaceId() {
  const explicitId = process.env.EMAIL_CACHE_KV_ID || process.env.CLOUDFLARE_KV_NAMESPACE_ID || process.env.KV_NAMESPACE_ID;
  if (explicitId) {
    console.log(`[deploy] Using KV namespace id from environment for ${BINDING}.`);
    return explicitId;
  }

  console.log(`[deploy] Checking Cloudflare account for KV namespace ${BINDING}...`);
  const list = runWrangler(["kv", "namespace", "list"], { capture: true, allowFailure: true });
  const namespaces = list.status === 0 ? parseJsonArray(list.stdout || "") : [];
  const existing = findNamespace(namespaces);
  if (existing?.id) {
    console.log(`[deploy] Found existing KV namespace ${BINDING}.`);
    return existing.id;
  }

  console.log(`[deploy] Creating KV namespace ${BINDING} in this Cloudflare account...`);
  const created = runWrangler(["kv", "namespace", "create", BINDING], { capture: true });
  const namespaceId = parseCreatedNamespaceId(`${created.stdout || ""}\n${created.stderr || ""}`);
  if (!namespaceId) {
    console.error(`[deploy] Could not read KV namespace id for ${BINDING}.`);
    console.error("[deploy] Fix: create KV namespace manually, then set build variable EMAIL_CACHE_KV_ID to its ID.");
    process.exit(1);
  }
  return namespaceId;
}

// ─────────────────────────────────────────────────────────────
// Auto-sync Worker secrets.
//
// PRIMARY (zero-setup): if CLOUDFLARE_API_TOKEN is present (Cloudflare Workers
// Builds auto-injects it), call the worker-bootstrap Supabase edge function.
// It returns SUPABASE_URL / SUPABASE_KEY / SESSION_SECRET so we can push them
// as Worker Secrets without the user ever touching Cloudflare env vars.
//
// FALLBACK: any secrets explicitly set as Cloudflare Build variables also get
// pushed (overrides bootstrap values).
// ─────────────────────────────────────────────────────────────
const AUTO_SECRET_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SESSION_SECRET",
  "SESSION_SIGNING_SECRET",
  "CRON_SHARED_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "DEBUG_TOKEN",
];

const BOOTSTRAP_URL =
  process.env.WORKER_BOOTSTRAP_URL ||
  "https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/worker-bootstrap";
const BOOTSTRAP_ANON_KEY =
  process.env.WORKER_BOOTSTRAP_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA";

async function fetchBootstrapSecrets() {
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!cfToken) {
    console.log("[deploy] CLOUDFLARE_API_TOKEN not present; skipping bootstrap fetch.");
    return {};
  }
  console.log("[deploy] Fetching secrets from worker-bootstrap...");
  try {
    const res = await fetch(BOOTSTRAP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CF-Token": cfToken,
        Authorization: `Bearer ${BOOTSTRAP_ANON_KEY}`,
        apikey: BOOTSTRAP_ANON_KEY,
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[deploy] Bootstrap fetch failed [${res.status}]:`, body);
      return {};
    }
    console.log(`[deploy] Bootstrap OK for CF account: ${body?.account?.name || "?"}`);
    const map = {};
    if (body.SUPABASE_URL) map.SUPABASE_URL = body.SUPABASE_URL;
    if (body.SUPABASE_KEY) map.SUPABASE_KEY = body.SUPABASE_KEY;
    if (body.SESSION_SECRET) {
      map.SESSION_SECRET = body.SESSION_SECRET;
      map.SESSION_SIGNING_SECRET = body.SESSION_SECRET;
    }
    return map;
  } catch (e) {
    console.warn("[deploy] Bootstrap fetch error:", e.message);
    return {};
  }
}

async function syncSecrets(tempConfig, workerName) {
  const bootstrap = await fetchBootstrapSecrets();
  const merged = { ...bootstrap };
  for (const name of AUTO_SECRET_NAMES) {
    const v = process.env[name];
    if (v && v.trim()) merged[name] = v; // Build variables override bootstrap
  }
  const present = Object.keys(merged);
  if (!present.length) {
    console.log("[deploy] No secrets to sync (bootstrap empty and no build vars).");
    return;
  }
  console.log(`[deploy] Syncing ${present.length} secret(s) to Worker: ${present.join(", ")}`);
  for (const name of present) {
    const args = ["secret", "put", name, "--config", tempConfig];
    if (workerName) args.push("--name", workerName);
    const res = spawnSync("npx", [...WRANGLER, ...args], {
      cwd: __dirname,
      input: merged[name],
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      console.error(`[deploy] Failed to set secret ${name} (continuing).`);
    }
  }
}


async function deploy() {
  if (!existsSync(BASE_CONFIG)) {
    console.error(`[deploy] Missing ${BASE_CONFIG}`);
    process.exit(1);
  }

  const namespaceId = ensureNamespaceId();
  const source = readFileSync(BASE_CONFIG, "utf8");
  const tempDir = mkdtempSync(join(tmpdir(), "inbox-worker-"));
  const tempConfig = join(tempDir, "wrangler.toml");
  writeFileSync(tempConfig, patchKvId(source, namespaceId));

  const workerName = process.env.WORKER_NAME || process.env.CLOUDFLARE_WORKER_NAME;

  // Push secrets BEFORE deploy so the first request already has them.
  await syncSecrets(tempConfig, workerName);

  const args = ["deploy", "--config", tempConfig, "--keep-vars"];
  if (workerName) args.push("--name", workerName);

  console.log("[deploy] Deploying Worker with KV binding EMAIL_CACHE...");
  runWrangler(args);
}

deploy().catch((e) => {
  console.error("[deploy] Fatal:", e);
  process.exit(1);
});
