

# Fix: Worker URL Routing Logic

## Problem

The app merges ALL worker URLs (primary + per-account) into a single flat list. When `apiCall` makes a request (e.g., `manage-app`), it randomly picks from this combined list. So the broken account-specific worker (`netflix.testbyop.workers.dev`) gets tried for general API calls, causing 502 errors and slowness.

The `netflix.testbyop.workers.dev` worker returns `"Invalid URL: undefined/functions/v1/manage-app"` even though its `/api/debug` shows `has_supabase_url: true`. This suggests the deployed worker code on that instance is outdated or corrupted.

## Solution

Separate worker URL routing so that:
- **General API calls** (`apiCall`) only use PRIMARY worker URLs
- **Email fetch/sync calls** use account-specific URLs when available, falling back to primary
- Account-specific URLs are NOT mixed into the general pool

## Changes

### 1. Fix `apiCall` to use only primary URLs (src/App.tsx)

Modify `getStoredWorkerUrls()` to store primary and account URLs separately. `apiCall` should only read primary URLs.

### 2. Fix the URL merge logic (lines 2014-2033)

Instead of building a flat list of all URLs, store them separately:
- `localStorage` key `cloudflare_worker_urls` = primary URLs only
- Account-specific URLs stay in the `workerUrlMap` state, used only by `fetchFromWorkers` for email operations

### 3. Fix initial localStorage seeding (line 1979)

Line 1979 starts with `const primaryUrls = [...getStoredWorkerUrls()]` which includes stale/old URLs. After fetching fresh settings, it should REPLACE rather than merge with old cached URLs.

### 4. Clean stale URLs on save

When admin saves new `primary_cloudflare_urls`, the stored URLs should be replaced entirely (already done at line 975, but the email viewer's useEffect re-adds account URLs on next load).

## Expected Result

- `manage-app` and other general calls go ONLY to primary worker (`netflixfetch.opgohils.workers.dev`)
- Email fetch goes to account-specific worker when configured
- No more random 502 errors from broken account workers being used for admin operations
- Faster page loads since no wasted requests to broken workers

