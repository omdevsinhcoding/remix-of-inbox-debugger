

# Fix Plan: New Emails Not Arriving + Filter Banner Removal

## Issues Found

1. **Sync times out**: Edge function hits the ~25s Supabase timeout. IMAP connect + search + fetch 150 UIDs is too slow. Logs confirm: sync starts, connects, but never completes.

2. **Dedup IDs are inconsistent**: Cached IDs are plain UIDs (`95367`) but dedup checks both `Primary:95367` and `95367`. The `String(uid)` check works for existing data, but new emails stored as `Primary:uid` won't match next time via `cachedIds.has(String(uid))` — they'd need `cachedIds.has("Primary:uid")` which does work. So dedup is actually fine for the current code. The real problem is the timeout.

3. **Filter banner showing unwanted**: `hiddenCount` is set to `-1` when any filter is active, showing "Some emails hidden by filters" banner. User does not want this banner.

4. **Admin toggle behavior broken**: Settings show `showPasswordResets: false, showSignInCodes: true`. The filter logic in the edge function:
   - `filterSignInCodes` = true when `showSignInCodes === false` → currently `showSignInCodes: true` → `filterSignInCodes = false` → sign-in codes ARE shown ✓
   - `filterPasswordResets` = true when `showPasswordResets !== true` → currently `showPasswordResets: false` → `filterPasswordResets = true` → password resets ARE hidden ✓
   - But toggling these on/off doesn't trigger a re-fetch of cached emails. The user needs to refresh to see the change.

## Root Cause of No New Emails

The IMAP sync consistently times out. The edge function has a ~25s wall-clock limit. The flow is:
1. Query cached_emails from DB (~1s)
2. Read account config from DB (~1s)  
3. Connect to IMAP (~3-5s)
4. Search for Netflix emails (~2-3s)
5. Fetch each new email one-by-one (~1-2s each)

With 60 cached emails and `FULL_SYNC_MAX_UIDS = 150`, it tries to process up to 150 UIDs. Even though dedup skips cached ones, the IMAP operations themselves are slow. The `PER_ACCOUNT_TIMEOUT_MS = 20000` (20s) is close to the edge function limit.

**Fix**: Reduce `FULL_SYNC_MAX_UIDS` to 30, reduce `PER_ACCOUNT_TIMEOUT_MS` to 15s, and add `message_id` column for safer dedup.

---

## Changes

### File 1: `supabase/functions/fetch-emails/index.ts`

**Changes:**
- Reduce `FULL_SYNC_MAX_UIDS` from 150 → 30 (fetch fewer, finish faster)
- Reduce `PER_ACCOUNT_TIMEOUT_MS` from 20000 → 15000
- Add `message_id` to stored email data for future-proof dedup
- Broaden Netflix filter: match `netflix` in from OR subject (not just exact `info@account.netflix.com`)
- Add `message_id` column storage in upsert

### File 2: `src/App.tsx`

**Changes:**
- Remove the filter banner entirely (`hiddenCount` state and the banner UI)
- Remove `loadHiddenCount()` function and its call
- Ensure filter toggles in admin trigger immediate cache reload

### File 3: DB Migration

- Add `message_id` column to `cached_emails` table (nullable text, for future dedup safety)

---

## Summary

| Problem | Fix |
|---------|-----|
| Sync times out → no new emails | Reduce fetch limit to 30, reduce timeout to 15s |
| Filter banner showing unwanted | Remove the banner UI completely |
| Admin toggle doesn't reflect immediately | Already fixed — `loadCachedEmails` is called after toggle |
| Netflix filter too narrow | Broaden to match `netflix` in from/subject |

## Deployment

After code changes, the edge function will be auto-deployed. No manual steps needed. Cron setup remains optional via `wrangler.toml`.

