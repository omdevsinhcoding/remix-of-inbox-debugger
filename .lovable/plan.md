

# Fix: New Netflix Emails Not Arriving

## Root Cause (Confirmed by Testing)

The sync **times out** before it can fetch new emails. I verified this by calling the edge function directly — it started the IMAP sync but the Supabase edge function timed out before completing.

**Why it times out:** A deduplication bug causes every sync to re-fetch ALL emails instead of skipping already-cached ones.

### The Dedup Bug (Critical)

In `fetchFromAccount` (line 106):
```typescript
const emailId = `${accountLabel}:${uid}`;  // e.g. "Primary:95293"
if (cachedIds.has(emailId) || cachedIds.has(String(uid))) { skip }
```

But when storing (line 121):
```typescript
const stableId = messageId.startsWith("<") ? `${accountLabel}:${messageId}` : emailId;
// Stores as "Primary:<abc@netflix.com>" instead of "Primary:95293"
```

The existing 60 cached emails have plain UID IDs (like `95293`), so `cachedIds.has(String(uid))` matches and they get skipped. But any email stored after the Message-ID logic was added gets stored as `Primary:<message-id>` — which **never matches** the dedup check. Those emails get re-fetched every sync, wasting the entire 20-second timeout window, leaving no time for truly new emails.

### Secondary Issue: Frontend Refresh

`fetchEmails` (line 1853) fires sync as fire-and-forget:
```typescript
void syncFromImap();  // doesn't wait for result
```
So even if sync eventually succeeds, the UI already finished refreshing with old cache data.

---

## Plan

### Step 1: Fix dedup in Edge Function

**File:** `supabase/functions/fetch-emails/index.ts`

Change the dedup check to also check the Message-ID-based stableId format. The simplest fix: compute the stableId **before** the skip check, or store the email using the same `emailId` format consistently.

**Approach:** Always use `accountLabel:uid` as the stored ID (remove the Message-ID-based stableId). This keeps dedup fast and consistent:

```typescript
// Line 119-121: Remove Message-ID logic, always use accountLabel:uid
const stableId = emailId;  // always "Primary:95293"
```

This is safe because UIDs are stable per-mailbox and the `accountLabel` prefix already handles multi-account dedup.

### Step 2: Fix frontend refresh to await sync

**File:** `src/App.tsx`

Change `fetchEmails` so Refresh button awaits the sync before showing results:

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

Also remove the duplicate `loadCachedEmails` call inside `syncFromImap` (line 1832) since the caller now handles it.

### Step 3: Migrate existing cached email IDs

Add a one-time cleanup in the sync function to normalize any `Primary:<message-id>` format IDs back to `accountLabel:uid` format. Or simply: on next sync, old plain-UID entries will be matched and skipped, while new emails will be stored with the consistent `accountLabel:uid` format.

No migration needed — the existing plain UID entries (`95293`) will still be matched by `cachedIds.has(String(uid))`. New entries will use `Primary:uid` format consistently.

---

## Files Changed

| File | Change |
|------|--------|
| `supabase/functions/fetch-emails/index.ts` | Fix dedup: always use `accountLabel:uid` as email ID |
| `src/App.tsx` | Fix refresh to await sync, remove duplicate cache load from syncFromImap |

## What This Fixes

- Sync no longer wastes time re-fetching already-cached emails → completes within timeout
- New Netflix emails are actually fetched and stored
- Refresh button shows fresh data after sync completes
- Netflix-only filter preserved (intentional)

## Cron Setup (No Code Change)

Cron is already configured but commented out in `wrangler.toml`. To enable automatic background sync:
```toml
[triggers]
crons = ["*/5 * * * *"]
```
Then deploy: `npx wrangler deploy`

