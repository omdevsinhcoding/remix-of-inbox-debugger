

# Fix: Eye Icons, Multiple Cloudflare URLs, Remove Supabase Edge Function Completely

## Plan

### Step 1: Fix import crash
**File:** `src/App.tsx` line 7 — change `@/src/integrations/supabase/client` to `@/integrations/supabase/client`.

### Step 2: Add eye toggle icons to all password/secret fields
**File:** `src/App.tsx`

Add `EyeOff` import. Add show/hide toggle button (Eye/EyeOff) to every sensitive input:
- Login password
- Bot Token, App Password in Admin Settings
- App Password in Add Account form
- Password in expanded account cards
- Change Password modal (current, new, confirm)

### Step 3: Multiple Cloudflare URLs per email account
**File:** `src/App.tsx`

Change account schema from `cloudflareUrl: string` to `cloudflareUrls: string[]`. Add UI to add/remove multiple URLs per account. Auto-migrate old `cloudflareUrl` → `cloudflareUrls: [cloudflareUrl]`.

### Step 4: Remove ALL Supabase edge function calls for email fetching

**File:** `src/App.tsx`

- Remove `syncFromImap()` function (it calls Supabase edge function)
- Remove `fetchWithFallback` Supabase fallback branch — Cloudflare Workers only
- `loadCachedEmails`: fetch from Cloudflare Worker URLs only (no Supabase edge function call)
- Refresh button: calls Cloudflare Worker to sync + fetch, no Supabase edge function involved
- Keep Supabase Realtime subscription (it's a websocket to the DB, not an edge function)
- Keep Supabase DB reads via `supabase.from("cached_emails")` (direct DB query, not edge function)
- Remove cron toggle that calls Supabase edge function

### Step 5: Update Infrastructure tab
- Remove "Cloudflare Worker URLs" as a separate global section — URLs now live on each account
- Remove any references to Supabase edge function sync
- Keep the Cloudflare Worker deployment instructions (worker.js)

---

## What stays vs what goes

| Stays | Goes |
|-------|------|
| Supabase DB for storage (cached_emails, app_settings, etc.) | Supabase edge function calls (`/functions/v1/fetch-emails`) |
| Supabase Realtime subscription | `syncFromImap()` function |
| Cloudflare Workers for IMAP fetch + cache | Cron toggle (edge function based) |
| Direct DB reads via supabase client | `fetchWithFallback` Supabase fallback |

