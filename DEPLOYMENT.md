# Deployment & Setup Guide

## Quick Summary

This is a Netflix-style email inbox that syncs from IMAP servers, caches in Supabase, and optionally uses Cloudflare Workers + KV for fast edge caching.

---

## Architecture

```
User Browser → Cloudflare Worker (optional cache) → Supabase Edge Function → IMAP Server
                        ↓                                    ↓
               Cloudflare KV (cache)              Supabase DB (cached_emails)
```

---

## 1. Supabase Setup

### Required Secrets (set in Supabase Dashboard → Edge Functions → Secrets)
```
SUPABASE_URL          = https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY = your-service-role-key
IMAP_HOST             = imap.gmail.com
IMAP_PORT             = 993
IMAP_USER             = your-email@gmail.com
IMAP_PASSWORD         = your-16-digit-app-password
TELEGRAM_BOT_TOKEN    = your-telegram-bot-token
TELEGRAM_CHAT_ID      = your-chat-id
```

### Deploy Edge Functions
```bash
npx supabase functions deploy fetch-emails --project-ref YOUR_PROJECT_REF
npx supabase functions deploy manage-app --project-ref YOUR_PROJECT_REF
npx supabase functions deploy send-login-notification --project-ref YOUR_PROJECT_REF
npx supabase functions deploy send-telegram-otp --project-ref YOUR_PROJECT_REF
```

### Bootstrap First Admin
```bash
curl -X POST \
  https://YOUR_PROJECT.supabase.co/functions/v1/manage-app \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"create","username":"admin","password":"YourSecurePass","name":"Admin","role":"admin"}'
```

---

## 2. Cloudflare Worker Setup

### Create KV Namespace
```bash
cd cloudflare-worker
npx wrangler kv namespace create EMAIL_CACHE
```
Copy the namespace ID into `wrangler.toml`.

### Set Secrets
```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY     # Use anon key
npx wrangler secret put SESSION_SECRET   # Same as SUPABASE_SERVICE_ROLE_KEY
```

### Deploy
```bash
npx wrangler deploy
```

This deploys the worker named `feeedda` from `wrangler.toml`.

### Worker URL
After deployment, your worker URL will be something like:
```
https://feeedda.YOUR_ACCOUNT.workers.dev
```
Add this URL in Admin Panel → Infrastructure → Worker URLs.

---

## 3. When KV is Full

When Cloudflare KV storage limit is reached:

### Step 1: Create new namespace
```bash
npx wrangler kv namespace create EMAIL_CACHE_V2
```

### Step 2: Add to wrangler.toml
```toml
[[kv_namespaces]]
binding = "EMAIL_CACHE"
id = "OLD_KV_ID"

[[kv_namespaces]]
binding = "EMAIL_CACHE_V2"
id = "NEW_KV_ID"
```

### Step 3: Redeploy
```bash
npx wrangler deploy
```

The worker automatically uses V2 first, falls back to V1. If V2 write fails, it tries V1.

---

## 4. Multiple Worker URLs

You can configure multiple worker endpoints in Admin Panel → Infrastructure.
The app tries each URL in order until one responds successfully.
If all worker URLs fail, it falls back to direct Supabase backend calls.

---

## 5. Scheduled Sync (Cron)

### Option A: Cloudflare Worker Cron
Edit `wrangler.toml`:
```toml
[triggers]
crons = ["*/5 * * * *"]   # Every 5 minutes
```
Then `npx wrangler deploy`.

### Option B: External Cron
Call the sync endpoint periodically:
```bash
# Via worker
curl -X POST https://YOUR_WORKER/api/emails/sync \
  -H "X-Session-Token: YOUR_ADMIN_TOKEN"

# Or directly via Supabase
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/fetch-emails \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"sync"}'
```

Use cron-job.org, GitHub Actions, or any scheduler to run every 5 minutes.

### Option C: GitHub Actions
Create `.github/workflows/sync.yml`:
```yaml
name: Email Sync
on:
  schedule:
    - cron: '*/5 * * * *'
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST ${{ secrets.SUPABASE_URL }}/functions/v1/fetch-emails \
            -H "Authorization: Bearer ${{ secrets.SUPABASE_ANON_KEY }}" \
            -H "apikey: ${{ secrets.SUPABASE_ANON_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{"mode":"sync"}'
```

---

## 6. Frontend Deployment

Set environment variables:
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key
```

Build and deploy to Vercel, Netlify, or any static host:
```bash
npm run build
# Deploy the `dist/` folder
```

---

## 7. Environment Variables Reference

| Variable | Where | Required | Description |
|----------|-------|----------|-------------|
| `VITE_SUPABASE_URL` | Frontend (.env) | Yes | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Frontend (.env) | Yes | Supabase anon key |
| `VITE_CLOUDFLARE_WORKER_URL` | Frontend (.env) | No | Fallback worker URL |
| `SUPABASE_URL` | Worker secrets | Yes | Same as above |
| `SUPABASE_KEY` | Worker secrets | Yes | Supabase anon key |
| `SESSION_SECRET` | Worker secrets | Yes | Service role key |

---

## 8. Troubleshooting

### "No emails showing"
1. Check Admin → Email Accounts → verify IMAP credentials
2. Check Admin → Security → Email Filters (sign-in codes may be hidden)
3. Try manual sync: click Refresh in the viewer
4. Check edge function logs in Supabase dashboard

### "Sync takes too long"
- Each IMAP account has a 20-second timeout
- The system syncs accounts in parallel
- Stale emails (>60 days) are automatically cleaned up

### "Rate limit / KV full"
- Create a new KV namespace (see section 3)
- The worker handles KV write failures gracefully

### "Worker returning 404"
- Ensure worker is deployed with latest code
- Check worker URL is correct in Admin → Infrastructure
- The app automatically falls back to direct backend on 404/405/502

---

## 9. Sync Response Format

The sync endpoint returns structured stats:
```json
{
  "success": true,
  "emails": [...],
  "stats": {
    "Primary": { "fetched": 5, "skipped": 45 }
  },
  "totalFetched": 5,
  "inserted": 5,
  "duplicatesSkipped": 45
}
```
