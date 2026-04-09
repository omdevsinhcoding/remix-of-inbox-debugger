

# Fix: New Emails Not Arriving — Root Cause & Plan

## Root Cause (Confirmed)

**The IMAP fetch is hardcoded to only fetch emails from `info@account.netflix.com`.**

- `supabase/functions/fetch-emails/index.ts`, line 84: `client.search({ from: "info@account.netflix.com", since })`
- Line 95 fallback: also checks `fromAddr === "info@account.netflix.com"`
- Database confirms: all 60 cached emails are from `"Netflix" <info@account.netflix.com>` — zero emails from any other sender

This is the **single biggest reason** new emails are not appearing. Everything else (worker, cache, frontend) is secondary.

## Additional Issues Found

1. **Frontend refresh fires cache load first, sync in background** — user sees stale data immediately on refresh click
2. **No cron/scheduled sync exists** — emails only arrive on manual refresh
3. **Frontend `fetchEmails` doesn't await sync before showing results** (line 1851-1854)

---

## Plan

### Step 1: Remove hardcoded sender filter in Edge Function

**File:** `supabase/functions/fetch-emails/index.ts`

Replace the Netflix-only IMAP search (lines 82-98) with a general search that fetches all emails from the last 30 days:

```typescript
// BEFORE (broken):
const searchResults = await client.search({ from: "info@account.netflix.com", since }, { uid: true });

// AFTER (fixed):
const searchResults = await client.search({ since }, { uid: true });
```

Remove the fallback block that also filters by `info@account.netflix.com`. Replace it with a generic sequence-based fallback that doesn't filter by sender.

Rename `netflixUids` → `allUids` throughout the function.

### Step 2: Fix frontend refresh to sync-then-load

**File:** `src/App.tsx`

Change `fetchEmails` (line 1848) so clicking Refresh does:
1. Set syncing state
2. **Await** `syncFromImap()` (not fire-and-forget)
3. Then load cached emails
4. Show clear status: syncing → success/failed

```typescript
const fetchEmails = async () => {
  setRefreshing(true);
  setSyncing(true);
  try {
    await syncFromImap();
    await loadCachedEmails({ direct: true });
  } finally {
    setRefreshing(false);
  }
};
```

Also fix `syncFromImap` to not call `loadCachedEmails` internally (it currently does on line 1832), to avoid double-fetch.

### Step 3: Improve auto-refresh cycle

Keep the 5-second cache polling for fast UI updates. Keep the 20-second throttled background sync. No changes needed here — the existing logic is sound once the IMAP filter is removed.

### Step 4: Add structured logging to sync

Add clear log messages in the edge function:
- `[sync] Started for N accounts`
- `[sync] Account X: fetched Y, skipped Z`
- `[sync] Complete: N new, M skipped, K upserted`

(Most of this logging already exists — just rename Netflix references.)

### Step 5: Document cron setup (no code change needed)

The `wrangler.toml` already has cron config commented out. The admin panel already shows cron setup instructions. No code change needed — just ensure the user enables it:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

Then `npx wrangler deploy`.

---

## Files Changed

| File | Change |
|------|--------|
| `supabase/functions/fetch-emails/index.ts` | Remove Netflix sender filter, fetch all emails |
| `src/App.tsx` | Fix refresh to await sync before showing results |

## What This Fixes

- New emails from **all senders** will now be fetched (not just Netflix)
- Refresh button will show fresh data after sync completes
- Existing cache, worker, KV logic remains unchanged (it works correctly)

