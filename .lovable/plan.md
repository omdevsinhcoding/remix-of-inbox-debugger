

# Add Supabase Cron for Automatic Email Sync

## Current State
- Sync works correctly when triggered manually
- No server-side scheduler exists — emails only arrive on user refresh or Cloudflare cron (which isn't deployed)
- `pg_cron` and `pg_net` extensions are available but not enabled
- Admin panel already has a "Scheduled Sync (Cron)" section with manual instructions only

## Plan

### Step 1: Enable pg_cron and pg_net extensions + create cron job

**Database migration** to:
1. Enable `pg_cron` and `pg_net` extensions
2. Create a cron job that calls `fetch-emails` edge function with `{"mode":"sync"}` every 3 minutes using `net.http_post()`

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
  'sync-emails-every-3min',
  '*/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/fetch-emails',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <ANON_KEY>"}'::jsonb,
    body := '{"mode":"sync"}'::jsonb
  ) AS request_id;
  $$
);
```

### Step 2: Add admin panel UI for cron management

**File:** `src/App.tsx`

Replace the static "Scheduled Sync (Cron)" section (lines 1423-1459) with an interactive panel that:
- Shows current cron status (active/inactive) by querying a new edge function endpoint
- Has an **Enable/Disable** toggle button that calls the edge function to manage the cron job
- Shows interval selector (1, 3, 5, 10 minutes)
- Keeps the manual setup instructions (Cloudflare, curl) as collapsible "Advanced" section
- Shows last sync time from `cached_emails` table

### Step 3: Add cron management to edge function

**File:** `supabase/functions/fetch-emails/index.ts`

Add two new modes:
- `mode: "cron_status"` — returns whether the cron job exists and its schedule
- `mode: "cron_toggle"` — enables/disables the cron job (admin only, requires service role)

These modes use `supabase.rpc()` or direct SQL to query/manage `cron.job` table.

### Step 4: Add logging for cron-triggered syncs

**File:** `supabase/functions/fetch-emails/index.ts`

Add a `source` field to sync logs:
```
[sync] Triggered by: cron | manual | worker
```

Log start, completion, and errors with timestamps.

### Step 5: Keep Cloudflare cron as secondary

No code changes needed. The `wrangler.toml` already has cron config commented out. Admin panel will show instructions for enabling it as backup.

---

## Files Changed

| File | Change |
|------|--------|
| DB migration | Enable pg_cron + pg_net, create scheduled job |
| `supabase/functions/fetch-emails/index.ts` | Add `cron_status` and `cron_toggle` modes |
| `src/App.tsx` | Replace static cron section with interactive enable/disable UI + interval selector |

## What This Achieves
- Emails sync automatically every 3 minutes via Supabase pg_cron — no frontend or Cloudflare needed
- Admin can enable/disable and change interval from the UI
- Manual instructions preserved for advanced users
- Cloudflare cron remains as optional backup

