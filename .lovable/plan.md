

# Fix: New Emails Not Arriving + Near-Real-Time Display

## Issues Found

### 1. Cron job has WRONG auth key (critical)
The pg_cron job is using `sb_publishable_UVau5jxvUHy9EfSvRTVZ-w_pFefVCI6` as the Bearer token — this is NOT the real Supabase anon key. The real key is the JWT starting with `eyJhbGci...`. Every cron-triggered sync fails silently with a 401 auth error.

### 2. IMAP search returns 0 Netflix emails
Logs show `[sync] Complete: 0 new, 0 skipped` — meaning the IMAP search `{ from: "@netflix.com" }` returns empty results. This partial-domain search may not work reliably on all IMAP servers. Need to broaden the search and add fallback.

### 3. Frontend cache polling already works (5s interval)
`loadCachedEmails()` runs every 5 seconds via countdown timer. Once emails are in the DB, they show up within 5 seconds. The bottleneck is getting them INTO the DB.

---

## Plan

### Step 1: Fix cron job with correct auth key

**Database migration** to:
1. Unschedule the broken cron job
2. Re-schedule with the correct anon key (the JWT `eyJhbGci...`)

```sql
SELECT cron.unschedule('sync-netflix-emails');
SELECT cron.schedule(
  'sync-netflix-emails',
  '*/3 * * * *',
  $$ SELECT net.http_post(
    url := 'https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/fetch-emails',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA"}'::jsonb,
    body := '{"mode":"sync","source":"cron"}'::jsonb
  ) AS request_id; $$
);
```

### Step 2: Fix IMAP Netflix search in edge function

**File:** `supabase/functions/fetch-emails/index.ts`

The search `{ from: "@netflix.com" }` returns 0 results. Fix by:
- Try searching for `netflix.com` first (without `@`)
- If that returns 0, try broader search with just `netflix`
- Add detailed logging: log how many UIDs the search found
- In the fallback scanner, also check `to` address (in case Netflix sends from subdomains)

### Step 3: Fix cron_toggle to use correct anon key

**File:** `supabase/functions/fetch-emails/index.ts`

The `cron_toggle` mode reads `SUPABASE_ANON_KEY` env var, which resolved to the wrong value. Fix to use the hardcoded correct anon key, or read it from `app_settings` config.

### Step 4: Clean up UI — remove "cached" references

**File:** `src/App.tsx`

- Remove any "cached" text from the UI (the user doesn't want to see internal implementation details)
- Ensure the email list just shows emails without mentioning they're cached

---

## Summary

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| Cron not working | Wrong auth key in pg_cron job | Re-schedule with correct JWT anon key |
| 0 new emails from IMAP | `@netflix.com` search returns empty | Broaden search + add logging |
| cron_toggle sets wrong key | `SUPABASE_ANON_KEY` env has wrong value | Use correct key |
| "cached" text in UI | Internal detail shown to user | Remove it |

## Result
- Cron syncs every 3 minutes with correct auth
- New Netflix emails appear within ~5 seconds of being synced
- UI is clean, no "cached" or implementation details shown

