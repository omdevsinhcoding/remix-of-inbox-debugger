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
// Auto-sync Worker secrets from Cloudflare build-time env vars.
// Set these in Cloudflare → Worker → Settings → Variables → Build variables
// (any that exist will be pushed as encrypted Worker secrets on every deploy).
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

function syncSecrets(tempConfig, workerName) {
  const present = AUTO_SECRET_NAMES.filter((n) => process.env[n] && process.env[n].trim());
  if (!present.length) {
    console.log("[deploy] No build-env secrets found to sync. (Set them in Worker → Settings → Variables → Build variables)");
    return;
  }
  console.log(`[deploy] Syncing ${present.length} secret(s) to Worker: ${present.join(", ")}`);
  for (const name of present) {
    const args = ["secret", "put", name, "--config", tempConfig];
    if (workerName) args.push("--name", workerName);
    const res = spawnSync("npx", [...WRANGLER, ...args], {
      cwd: __dirname,
      input: process.env[name],
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      console.error(`[deploy] Failed to set secret ${name} (continuing).`);
    }
  }
}

function deploy() {
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
  syncSecrets(tempConfig, workerName);

  const args = ["deploy", "--config", tempConfig, "--keep-vars"];
  if (workerName) args.push("--name", workerName);

  console.log("[deploy] Deploying Worker with KV binding EMAIL_CACHE...");
  runWrangler(args);
}

deploy();