

# Fix: Instant Email Fetch on Refresh + Cleanup + DB Schema Guide

## Issues to Fix

1. **Runtime crash**: Import path `@/src/integrations/supabase/client` is wrong -- should be `@/integrations/supabase/client`. This causes the `useEffect` null error that breaks the entire app.

2. **Refresh button always spinning + "Syncing..." text**: The Refresh button calls `syncFromImap()` which does a full IMAP sync (slow, often fails with TLS drops). User wants instant results. On Refresh, we should just trigger the edge function sync and immediately reload cached emails, showing a toast instead of inline "Syncing..." text.

3. **Cron not needed**: User wants to remove cron dependency. Instead, Refresh button triggers IMAP sync + cache reload. Realtime subscription handles instant display when new emails arrive in DB.

4. **Unwanted UI elements**: "Syncing..." text, stale banner, Cloudflare KV instructions, always-rotating refresh icon.

5. **User wants DB schema documentation** for setting up on another Supabase project.

---

## Plan

### Step 1: Fix the import crash (critical)

**File:** `src/App.tsx` line 7

Change `@/src/integrations/supabase/client` to `@/integrations/supabase/client`.

### Step 2: Rewrite Refresh button behavior

**File:** `src/App.tsx`

- On Refresh click: call `syncFromImap()` in background + immediately `loadCachedEmails()` to show current data
- Show `toast.loading("Fetching latest emails...")` instead of inline "Syncing..." text
- When sync completes, show `toast.success("Emails updated!")` or `toast.error(...)` 
- Remove the `syncing` state from disabling the button (just show a brief animation)
- Remove the "Syncing..." text from the inbox header (line 2111)
- Remove the `stale` banner (lines 2114-2118)
- Stop the refresh icon from continuously spinning -- just a brief spin on click

### Step 3: Remove cron dependency from viewer

**File:** `src/App.tsx`

- Keep Realtime subscription (it works when emails are inserted by any source)
- Keep fallback polling every 30s (lightweight cache read)
- Remove `SYNC_THROTTLE_MS` and related throttle logic
- Remove `syncing` inline indicator

### Step 4: Clean up Admin Panel

**File:** `src/App.tsx`

- Remove "Cloudflare KV Setup" section (lines 1580-1603) -- irrelevant instructions
- Keep CronManagerSection in admin as optional tool (admin can still toggle cron if they want background sync)

### Step 5: Generate DB schema documentation

Create a markdown file at `/mnt/documents/database-schema.md` with:
- All table definitions (app_users, app_otps, app_settings, audit_logs, cached_emails)
- RLS policies
- Database functions (schedule_email_sync, unschedule_email_sync, get_cron_status)
- Edge function secrets needed (IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
- Step-by-step setup guide for a new Supabase project

---

## Summary

| Change | Why |
|--------|-----|
| Fix import path | App crashes with `useEffect` null error |
| Toast instead of "Syncing..." | Cleaner UX, no inline status text |
| Instant cache load on Refresh | Show existing emails immediately, sync in background |
| Remove KV instructions | Irrelevant to current architecture |
| DB schema doc | User can replicate on another Supabase project |

