#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const env = process.env;

const isTruthy = (value) => /^(1|true|yes)$/i.test(String(value || ""));

const isFrontendHost = Boolean(
  env.VERCEL ||
    env.NETLIFY ||
    env.LOVABLE_BUILD ||
    env.LOVABLE ||
    env.CI_PLATFORM === "lovable"
);

const isCloudflareBuild = Boolean(
  isTruthy(env.CLOUDFLARE_WORKER_BUILD) ||
    isTruthy(env.CF_WORKER_BUILD) ||
    env.CLOUDFLARE_ACCOUNT_ID ||
    env.CF_ACCOUNT_ID ||
    env.CLOUDFLARE_API_TOKEN ||
    env.CF_PAGES ||
    env.CF_BRANCH ||
    env.CF_BUILD_ID
);

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  process.exit(result.status ?? 1);
};

if (isCloudflareBuild && !isFrontendHost) {
  console.log("[smart-build] Cloudflare build detected → deploying Worker with Wrangler");
  run("node", ["cloudflare-worker/deploy.mjs"]);
}

console.log("[smart-build] Frontend/static host build detected → running Vite");
run("npm", ["run", "build:app"]);