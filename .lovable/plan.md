

# Worker URL Routing & Load Balancing

## What's changing

Currently all worker URLs are pooled into one flat list and used as failover-only proxies to the same Supabase backend. Every worker fetches ALL IMAP accounts regardless of which account it's assigned to.

This plan makes two changes:
1. **Per-account worker routing**: When a worker URL is assigned to a specific email account, email fetching for that account goes through that specific worker.
2. **Random load balancing**: When multiple worker URLs exist (primary or per-account), they are shuffled randomly instead of always trying the first one.

## Architecture

```text
Current:
  Worker1 → Supabase → ALL IMAP accounts
  Worker2 → (failover only)

New:
  Primary Workers (shuffled) → Supabase → ALL accounts
  Account-specific Worker → Supabase → Only that account's emails
```

## Implementation

### 1. Cloudflare Worker — accept `accountLabels` filter in sync

**File**: `cloudflare-worker/worker.js`

In `handleSync()`, pass through the request body (which already contains `mode: "sync"`) to the Supabase function. Add support for an `accountLabels` field so the worker can request sync for specific accounts only.

No major changes needed here — the worker already passes the body through. The filtering happens in `fetch-emails`.

### 2. `fetch-emails` — support `accountLabels` filter in sync mode

**File**: `supabase/functions/fetch-emails/index.ts`

In the SYNC section (around line 345), read `body.accountLabels`. If present, filter the `accounts` array to only sync those specific labels. This way, when a per-account worker triggers sync, only that account is synced.

```typescript
// After building accounts array (~line 397)
if (body.accountLabels && Array.isArray(body.accountLabels)) {
  accounts = accounts.filter(a => body.accountLabels.includes(a.label));
}
```

### 3. Frontend — separate per-account vs primary worker URLs

**File**: `src/App.tsx`

Changes to `EmailViewer`:

**a) Resolve worker URLs with account mapping**

Instead of merging all URLs into one flat `resolvedWorkerUrls` array, build a structured map:

```typescript
type WorkerUrlMap = {
  primary: string[];                    // shared/global workers
  byAccount: Record<string, string[]>; // account label → its specific workers
};
```

**b) Shuffle for load balancing**

Add a simple shuffle utility. When making requests, shuffle the URL list so traffic distributes randomly across workers.

```typescript
function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
```

**c) `fetchFromWorkers` — use shuffled URLs**

Modify `fetchFromWorkers` to accept an optional URL list override. Default to shuffled primary URLs. For account-specific requests, pass account-specific URLs.

**d) `syncViaWorker` — sync each account group separately**

When syncing:
- For accounts with dedicated workers: call sync through their specific worker with `accountLabels: [label]`
- For accounts without dedicated workers: call sync through primary workers (all remaining accounts)
- Run all sync calls in parallel

**e) `loadCachedEmails` — unchanged**

Cache loading always goes through primary workers (or any available worker) since it reads from the shared Supabase DB, not IMAP directly.

### 4. No backend migration needed

All changes are frontend routing logic + a small filter addition in `fetch-emails`.

## Files to modify

| File | Change |
|------|--------|
| `src/App.tsx` | Structured worker URL map, shuffle, per-account sync routing |
| `supabase/functions/fetch-emails/index.ts` | Accept `accountLabels` filter in sync mode |
| `cloudflare-worker/worker.js` | No changes needed (already passes body through) |

## Result

- If you add 10 worker URLs as primary → they are randomly load-balanced
- If you assign a worker URL to a specific email account → sync for that account goes through that worker only
- If a per-account worker fails → falls back to primary workers
- Cache reads (loading emails to display) always use primary workers

