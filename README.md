<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

# 📬 Inbox Debugger

**Netflix-style email inbox** — syncs from IMAP → caches in Supabase → served fast via Cloudflare Workers + KV

</div>

---

## 🚀 Quick Start (Local)

```bash
npm install
npm run dev
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local`.

---

## ☁️ Cloudflare Worker — GitHub Auto-Deploy Guide

The worker lives in [`/cloudflare-worker`](./cloudflare-worker) and auto-deploys on every push to `main`.

### 🎯 One-time Setup (5 minutes)

Open **Cloudflare Dashboard → Workers & Pages → your worker → Settings → Builds → Connect**

#### 1️⃣ Repository

| Field | Value |
|---|---|
| Repository | `inbox-debugger` (this repo) |
| Production branch | `main` |
| Root directory | `/cloudflare-worker` |

#### 2️⃣ Build & Deploy commands

| Field | Value |
|---|---|
| **Build command** | *(leave EMPTY)* |
| **Deploy command** | `npx wrangler deploy` |
| Build variables | *(none)* |
| Build secrets | *(none)* |

> ⚠️ Do **NOT** put `bash setup.sh` in Build command — Cloudflare's build step doesn't pass secrets to deploy.

#### 3️⃣ Non-production branches

| Field | Value |
|---|---|
| Build for non-production branches | ☐ **UNCHECKED** |
| Non-prod branch command | *(empty)* |

> 💡 Untick this or every PR/feature branch will trigger a deploy and waste credits.

#### 4️⃣ API Token

| Field | Value |
|---|---|
| API Token | **Use default** (auto-generated) |

> ✅ Cloudflare's default token already has `Workers Scripts: Edit` + `Workers KV Storage: Edit` + `Account Settings: Read`. Custom token **not needed**.

---

### 📋 Copy-Paste Summary

```
Root directory:       /cloudflare-worker
Production branch:    main
Build command:        (empty)
Deploy command:       npx wrangler deploy
Non-prod branches:    ☐ unchecked
Non-prod command:     (empty)
API Token:            Use default
```

---

### 🔗 After First Deploy

1. Cloudflare gives you a URL like `https://feeedda.YOURNAME.workers.dev`
2. Copy that URL
3. In the app: **Admin Panel → Infrastructure → Primary Cloudflare Worker URLs** → paste → Save

Done. Every future push to `main` auto-deploys.

---

### 🌐 Multiple Cloudflare Accounts?

Each Cloudflare account is **fully isolated** — deploying to one **never touches** another.

| Option | How |
|---|---|
| **A. Separate branches** | Create `main-acc1`, `main-acc2`, etc. Connect each account to its own branch. |
| **B. Override name** | In Cloudflare Deploy command: `npx wrangler deploy --name feeedda-acc2` |
| **C. Manual deploys** | Only one account Git-connected; others: `cd cloudflare-worker && npx wrangler deploy` locally |

You can add **multiple worker URLs** in the admin panel — they load-balance automatically and fall back to Supabase if all workers are down.

---

### 🔄 How to Redeploy

- **Auto:** Push any commit to `main`
- **Manual:** Cloudflare Dashboard → your worker → **Deployments** tab → **Retry**

---

### 🐛 Troubleshooting

| Problem | Fix |
|---|---|
| "No builds exist yet" | Git not connected. Go to Settings → Builds → **Connect** |
| Build fails: "you need to provide a name" | `wrangler.toml` missing `name` field — already fixed in this repo |
| Deploy succeeds but app can't reach worker | Paste worker URL in Admin Panel → Infrastructure |
| KV full | `npx wrangler kv namespace create EMAIL_CACHE_V2`, add to `wrangler.toml`, redeploy |

Full deployment reference: [`DEPLOYMENT.md`](./DEPLOYMENT.md)

---

## 🏗️ Architecture

```
Browser → Cloudflare Worker (KV cache) → Supabase Edge Function → IMAP
              ↓                                    ↓
        Cloudflare KV                    Supabase DB (cached_emails)
```

## 📦 Tech Stack

- **Frontend:** React 18 + Vite + TypeScript + Tailwind
- **Backend:** Supabase (Postgres + Edge Functions + Auth)
- **Edge Cache:** Cloudflare Workers + KV
- **Email:** IMAP sync via Deno edge functions
- **Notifications:** Telegram Bot API
