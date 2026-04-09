

# Fix: Latest Emails Not Appearing + Cleanup

## Root Cause

The IMAP connection drops (TLS `UnexpectedEof`) before any email body can be downloaded. The edge function finds 71 UIDs, but `fetchOne(uid, { source: true })` downloads the FULL raw email (~100KB+) which is too slow for the edge function's constrained environment. The connection dies mid-download, so 0 emails are fetched every sync cycle.

Additionally, there's an ID format mismatch: DB stores plain UIDs (`95367`) but new code generates `Primary:95367`, which would create duplicates if it ever succeeded.

## Plan

### Step 1: Fix IMAP fetch to use lightweight envelope-only approach

**File:** `supabase/functions/fetch-emails/index.ts`

Instead of downloading full email source (huge, slow, causes TLS drops), fetch only `{ envelope: true, bodyStructure: true }` for metadata, and use a targeted body part fetch for just the text content. Key changes:

- Reduce `FULL_SYNC_MAX_UIDS` from 30 to 5 (fetch fewer emails per cycle)
- Reduce `PER_ACCOUNT_TIMEOUT_MS` from 15000 to 12000
- Add `socketTimeout: 10000` to ImapFlow config
- Wrap each `fetchOne` in its own try/catch with a per-message timeout
- Use plain UID (not `accountLabel:uid`) as the `id` to match existing DB format
- Add a retry: if 0 emails fetched but uncached UIDs exist, retry once with a fresh connection fetching only 3 UIDs

### Step 2: Add Supabase Realtime for instant email display

**Database migration:** Enable realtime on `cached_emails` table:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE cached_emails;
```

**File:** `src/App.tsx`
- Add a Supabase Realtime subscription on `cached_emails` table for `INSERT` events
- When a new row is inserted, immediately add it to the email list (no polling needed)
- Remove the countdown timer and "Next sync" display
- Keep the 5-second polling as a fallback, but remove the visible countdown
- Remove `syncFromImap()` calls from the polling loop (cron handles sync)

### Step 3: Clean up UI

**File:** `src/App.tsx`
- Remove countdown state and display
- Remove any "cached", "stale", or "next sync" text
- Remove the `syncFromImap` auto-calls from the interval (let cron handle it)
- Keep manual Refresh button that triggers sync + reload
- Remove `console.error("[loadCached]"` log labels

### Step 4: Deploy edge function

Deploy updated `fetch-emails` function.

---

## Summary

| Change | Why |
|--------|-----|
| Fetch only 5 emails, add socket timeout, retry logic | Prevent TLS drops |
| Use plain UID as ID | Match existing DB format, prevent duplicates |
| Add Supabase Realtime subscription | Instant email display when cron inserts new emails |
| Remove countdown/next sync UI | User doesn't want to see internals |
| Keep cron + manual refresh | Reliable background sync |

## Result
- Cron syncs every 3 min, successfully downloads new emails (fewer per cycle = no TLS drop)
- New emails appear instantly via Realtime subscription (no waiting for poll)
- UI is clean with no implementation details

