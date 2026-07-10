<div align="center">

# 📬 Inbox Debugger

**Netflix-style email inbox** — IMAP sync → Supabase cache → Cloudflare Workers edge delivery

[![Deploy Status](https://img.shields.io/badge/deploy-production-success)]() [![Stack](https://img.shields.io/badge/stack-React_+_Vite_+_Supabase_+_CF_Workers-blue)]() [![License](https://img.shields.io/badge/license-private-lightgrey)]()

</div>

---

## 🏗️ Architecture

```
┌─────────────┐    ┌──────────────────┐    ┌───────────────────┐    ┌──────────┐
│   Browser   │───▶│ Cloudflare Worker│───▶│  Supabase Edge Fn │───▶│   IMAP   │
│  (React)    │    │  (KV cache)      │    │  (fetch-emails)   │    │  Server  │
└─────────────┘    └──────────────────┘    └───────────────────┘    └──────────┘
                          │                          │
                          ▼                          ▼
                   ┌─────────────┐         ┌──────────────────┐
                   │ CF KV Store │         │ Supabase Postgres│
                   │ (hot cache) │         │ (cached_emails)  │
                   └─────────────┘         └──────────────────┘
```

---

## 🚀 Local Development

```bash
npm install
npm run dev
```

**Required `.env`:**
```
VITE_SUPABASE_URL=https://YOUR_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=eyJhbGci...
VITE_SUPABASE_PROJECT_ID=YOUR_REF
```

App runs at `http://localhost:8080`.

---

## 🗄️ Part 1 — Supabase Setup

### 1. Edge Functions (auto-deployed via Lovable)

| Function | Purpose |
|---|---|
| `fetch-emails` | IMAP sync + email retrieval |
| `manage-app` | User/admin/session management |
| `email-html` | Serves sanitized HTML bodies |
| `notifications-list` | Push notifications feed |
| `crypto-handshake` | E2E session key exchange |
| `worker-bootstrap` | Cloudflare Worker config sync |

### 2. Required Secrets

Go to **Supabase Dashboard → Project Settings → Edge Functions → Secrets** and add:

#### Core (mandatory)
| Secret | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://YOUR_REF.supabase.co` | Auto-set |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Auto-set — bypasses RLS |
| `SUPABASE_ANON_KEY` | `eyJ...` | Auto-set |
| `SESSION_SIGNING_SECRET` | random 64-char hex | HMAC for session tokens |
| `CRON_SHARED_SECRET` | random 32-char hex | Protects cron endpoints |
| `WORKER_BOOTSTRAP_SECRET` | random 32-char hex | For Cloudflare bootstrap |

Generate randoms:
```bash
openssl rand -hex 32
```

#### IMAP (fallback account — per-account creds live in DB)
| Secret | Example |
|---|---|
| `IMAP_HOST` | `imap.gmail.com` |
| `IMAP_PORT` | `993` |
| `IMAP_USER` | `you@gmail.com` |
| `IMAP_PASSWORD` | Gmail **App Password** (16 chars) |

> 🔒 Gmail: enable 2FA → https://myaccount.google.com/apppasswords → generate → paste.

#### Telegram (login notifications)
| Secret | Where to get |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` |
| `TELEGRAM_CHAT_ID` | Message your bot → `https://api.telegram.org/bot<TOKEN>/getUpdates` |

### 3. Bootstrap First Admin

```bash
curl -X POST \
  https://YOUR_REF.supabase.co/functions/v1/manage-app \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"create","username":"admin","password":"StrongPass123!","name":"Admin","role":"admin"}'
```

### 4. Enable Cron for Auto-Sync

Inside app: **Admin Panel → Cron Settings** → toggle ON → pick interval (3 min recommended). Uses `pg_cron` + `pg_net` extensions (already enabled).

---

## ☁️ Part 2 — Cloudflare Worker Deploy

Worker source lives in [`/cloudflare-worker/worker.js`](./cloudflare-worker/worker.js).

**Zero runtime secrets required** — Supabase URL + anon key are baked into `worker.js` as defaults. The deploy script creates/fetches the KV namespace in the current Cloudflare account, injects the correct namespace ID into a temporary Wrangler config, then deploys with `EMAIL_CACHE` bound.

> 🪄 **Important fix:** Cloudflare KV bindings are account-specific. A `wrangler.toml` with only `binding = "EMAIL_CACHE"` is not enough on every account because KV needs an account-local namespace ID. [`cloudflare-worker/deploy.mjs`](./cloudflare-worker/deploy.mjs) now handles that automatically.

### 🎯 One-Time Setup

Open **Cloudflare Dashboard → Workers & Pages → Create → Import a repository** and choose **Workers** (not Pages).

#### Step 1 — Connect Git

| Field | Value |
|---|---|
| Repository | `inbox-debugger` (your GitHub repo) |
| Production branch | `main` |
| **Root directory** | `/cloudflare-worker` ← **REQUIRED** |

> ⚠️ Root directory **must** be `/cloudflare-worker`. If you leave it blank, Cloudflare detects the React frontend at repo root and runs `vite build` instead of the worker deploy.

#### Step 2 — Build & Deploy

| Field | Value |
|---|---|
| **Build command** | *(leave EMPTY — if Cloudflare auto-fills `npm run build`/`bun run build`, it still runs `node deploy.mjs`)* |
| **Deploy command** | `npm run deploy` ← **REQUIRED / safest** |
| Build variables | *(none)* |
| Build secrets | *(none)* |

> ✅ Recommended: `Root directory=/cloudflare-worker`, Build empty, Deploy `npm run deploy`. If Cloudflare auto-fills Build as `npm run build` or `bun run build`, it is still safe because both scripts run the same Worker deploy + KV binding step.

> ⚠️ Cloudflare Workers Builds has **two separate steps**: Build command and Deploy command. Build command alone is not reliable for production deploy. Keep Deploy command as `npm run deploy` so the KV bootstrap always runs.

#### Step 3 — Non-Production Branches

| Field | Value |
|---|---|
| Build for non-production branches | ☐ **UNCHECKED** |
| Non-prod branch command | *(empty — disabled)* |

> 💡 Untick → prevents wasteful builds on every PR/feature branch.

#### Step 4 — API Token

| Field | Value |
|---|---|
| API Token | **Create new token / Use default token with KV access** |

> ✅ The token must have **Account Settings: Read**, **Workers Scripts: Edit**, **Workers KV Storage: Edit**, **User Details: Read**, and **Memberships: Read**. If one Cloudflare account fails to create/bind KV, create a fresh token for that account instead of reusing an old restricted token.

### 📋 Copy-Paste Summary

```
Repository:           your-github-org/inbox-debugger
Production branch:    main
Root directory:       /cloudflare-worker      ← REQUIRED
Build command:        (empty)                 ← if auto-filled npm/bun build, still OK
Deploy command:       npm run deploy          ← REQUIRED / safest
Non-prod branches:    ☐ unchecked
Non-prod command:     (empty)
API Token:            Create new token / default with KV edit access
```


### 🔗 After First Deploy

1. Cloudflare gives URL: `https://netflix.<your-subdomain>.workers.dev`
   *(worker name comes from `wrangler.toml` → currently `netflix`; rename in that file if needed)*
2. Copy that URL
3. Confirm binding exists: Worker → **Settings → Bindings** → `EMAIL_CACHE` should be visible
4. In app: **Admin Panel → Infrastructure → Primary Cloudflare Worker URLs** → paste → Save

Done. Every **new push to `main`** auto-deploys.

### 🚨 Why it did not start after 5–10 minutes

Cloudflare does **not** keep polling an old commit after you connect an existing Worker. It triggers when:

1. you click **Save and Deploy** during initial Git import, or
2. a **new commit** is pushed to the selected production branch, or
3. you open **Deployments → Build history** and manually retry/start a build.

If Build history says **“No builds exist yet”**, GitHub Builds has not run. Push any small commit after connecting, or open Worker → **Settings → Builds → Retry/Start build**.

If logs show `KV namespace id missing`, `unauthorized`, or `permission`, the account token does not have **Workers KV Storage: Edit**. Recreate/select the token in that Cloudflare account.

---

## 🌐 Multi-Account Cloudflare Setup

Each Cloudflare account is fully isolated — deploying to one **never** touches another.

For **every Cloudflare account**, repeat these account-level steps:

1. Login to that exact Cloudflare account.
2. Workers & Pages → Create → Import repository.
3. Authorize GitHub access to this repo for that account.
4. Set `Root directory = /cloudflare-worker`.
5. Use/create an API token with **Workers Scripts: Edit** + **Workers KV Storage: Edit**.
6. Click **Save and Deploy**.
7. Check Build logs for: `Creating KV namespace EMAIL_CACHE` or `Found existing KV namespace EMAIL_CACHE`.
8. Check Worker → Settings → Bindings: `EMAIL_CACHE` must appear.
9. Copy that account's `workers.dev` URL into Admin Panel → Infrastructure.

No runtime env insertion is required for this app. `SUPABASE_URL` and anon key are built into `worker.js`; KV is a **binding**, not an env variable. Optional overrides only go in Worker → Settings → Variables & Secrets if you fork to another Supabase project.

| Option | How |
|---|---|
| **A. Separate branches** | `main-acc1`, `main-acc2` — connect each account to its own branch |
| **B. Override name** | Change deploy command to `npx wrangler deploy --name netflix-acc2` |
| **C. Manual** | Only one account Git-connected; others via local `wrangler deploy` |

### If you insist on repo-root build command

Cloudflare should ideally use `/cloudflare-worker`. If you leave root blank and set `npm run build` / `bun run build` at repo root, add this **Build variable** so the root script knows this is a Worker deploy, not a frontend Vite build:

```txt
CLOUDFLARE_WORKER_BUILD=1
```

Then `npm run build`, `bun run build`, `npm run build:worker`, or `npm run deploy:worker` will call `cloudflare-worker/deploy.mjs`. For `/cloudflare-worker` root, `npm run build`, `bun run build`, `npm run deploy`, `bun run deploy`, and `npm start` all call the same deploy script.

Add multiple worker URLs in Admin Panel → they load-balance randomly, fall back to Supabase if all workers fail.

---

## 🔄 Redeploy

| Method | How |
|---|---|
| Auto | `git push origin main` |
| Manual | Cloudflare → your worker → **Deployments** tab → **Retry** |

---

## 📊 When KV Storage Fills Up

Cloudflare free plan: 1 GB KV. When full:

```bash
cd cloudflare-worker
npx wrangler kv namespace create EMAIL_CACHE_V2
```

Add to `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "EMAIL_CACHE_V2"
id = "NEW_NAMESPACE_ID"
```

Push. Worker automatically writes to V2, falls back to V1 on failure.

---

## 🌍 Frontend Deploy (Vercel / Netlify / Lovable)

```bash
npm run build
# deploy `dist/` folder
```

Set these env vars in your host:
```
VITE_SUPABASE_URL=https://YOUR_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=eyJ...
```

SPA fallback is already configured (`public/_redirects`, `netlify.toml`, `vercel.json`).

---

## 🐛 Troubleshooting

| Problem | Fix |
|---|---|
| "No builds exist yet" in Cloudflare | Git Builds has not run yet. Use **Save and Deploy**, or push a new commit after connecting. |
| `npm run build` runs but worker never deploys | Root directory is wrong. Set it to `/cloudflare-worker` — the hijacked build script lives there. |
| Cloudflare runs `vite build` instead of wrangler | Same fix — Root directory must be `/cloudflare-worker`, not blank. |
| Cloudflare build fails: `wrangler.toml missing name` | Check `wrangler.toml` has `name = "netflix"` (or your chosen name) |
| Build fails: `you need to provide a name` in deploy | Same as above — name field required |
| Worker deployed but app shows no emails | Paste worker URL in Admin Panel → Infrastructure |
| KV full | Create `EMAIL_CACHE_V2` (see above) |
| Emails stuck / not syncing | Admin Panel → Email Accounts → verify IMAP creds; check `fetch-emails` logs |
| Session expired loops | Rotate `SESSION_SIGNING_SECRET` — all users forced to re-login |
| Telegram alerts missing | Verify `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in Supabase secrets |

---

## 📦 Tech Stack

- **Frontend:** React 18 + Vite 5 + TypeScript + Tailwind CSS v3
- **UI:** shadcn/ui + Radix primitives
- **Backend:** Supabase (Postgres + Edge Functions + Realtime + Auth)
- **Edge Cache:** Cloudflare Workers + KV
- **Email:** IMAP (Deno + `imapflow`) inside edge functions
- **Notifications:** Telegram Bot API
- **Scheduling:** `pg_cron` + `pg_net`

## 📄 Additional Docs

- Full deployment reference → [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- How it works → [`docs/how-it-works.md`](./docs/how-it-works.md)
- Security policy → [`SECURITY_MEMORY.md`](./SECURITY_MEMORY.md)
