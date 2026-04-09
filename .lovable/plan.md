

# Remove ALL Supabase Egress from Frontend

## Current Supabase egress points (frontend → Supabase directly)

1. **`apiCall("manage-app", ...)`** — ALL login, settings, user management calls go through `supabase.co/functions/v1/manage-app`. This is the BIGGEST egress consumer. Every page load makes 5-8 calls.
2. **`rest/v1/cached_emails?select=id`** (line 734) — direct REST API call for email stats count.
3. **Realtime subscription** (line 1785) — WebSocket to `supabaseClient.channel()`.
4. **EmailViewer `useEffect`** (line 1670) — calls `apiCall("manage-app")` to load worker URLs before it can even start fetching from Cloudflare.

## Target Architecture

```text
Frontend
   ↓ (ALL calls)
Cloudflare Worker (multiple URLs + KV cache)
   ↓
For emails: IMAP fetch → insert to Supabase DB via REST (ingress only)
For manage-app: proxy to Supabase edge function (server-to-server)
   ↓
Frontend NEVER talks to supabase.co directly
```

## Plan

### Step 1: Add manage-app proxy route to Cloudflare Worker

**File:** `cloudflare-worker/worker.js`

Add a new route `/api/manage-app` that proxies requests to `SUPABASE_URL/functions/v1/manage-app`. This moves all manage-app traffic through the Cloudflare Worker instead of the frontend calling Supabase directly.

```text
POST /api/manage-app → proxy to SUPABASE_URL/functions/v1/manage-app
```

The worker forwards the request body, session token, and auth headers. Response is passed back to the frontend.

### Step 2: Replace `apiCall()` with Cloudflare Worker calls

**File:** `src/App.tsx`

Change `apiCall()` to route through Cloudflare Workers instead of calling `getApiBase()/functions/v1/...` directly:

- Remove `getApiBase()` and `getApiKey()` functions (no more direct Supabase calls)
- `apiCall()` now calls `fetchFromWorkers("/api/manage-app", "POST", body)` instead of `fetch(supabase.co/functions/v1/manage-app)`
- This requires the worker URLs to be known before any API call. Store worker URLs in `localStorage` so they're available on app load (before settings are fetched).

### Step 3: Remove direct Supabase REST call for stats

**File:** `src/App.tsx` (line 733-741)

Remove the `fetch(getApiBase()/rest/v1/cached_emails?select=id...)` call. Instead, get the email count from the Cloudflare Worker response (which already returns all emails).

### Step 4: Remove Supabase Realtime subscription

**File:** `src/App.tsx` (lines 1783-1816)

Remove the `supabaseClient.channel()` Realtime subscription entirely. Replace with polling from Cloudflare Workers (already polling every 30s at line 1818). The polling via workers is sufficient.

### Step 5: Remove Supabase client import

**File:** `src/App.tsx`

Remove `import { supabase as supabaseClient } from "@/src/integrations/supabase/client"` — no longer needed since we don't use Realtime or REST directly.

### Step 6: Worker URL bootstrap from localStorage

**File:** `src/App.tsx`

Since `apiCall()` now needs Cloudflare Worker URLs, but worker URLs are stored in settings (which require `apiCall()`), we need a bootstrap mechanism:

- On first setup (admin adds worker URLs), save them to `localStorage` as well as to the backend
- On subsequent loads, read worker URLs from `localStorage` first, then verify against backend
- Admin Settings page: when saving Cloudflare URLs, also persist to `localStorage`
- Login page: after successful login, store the worker URLs returned in the login response

### Step 7: Update worker.js to return worker URLs in login response

**File:** `cloudflare-worker/worker.js`

When the `/api/manage-app` proxy handles a `login` action response, optionally include the `primary_cloudflare_urls` and `email_accounts` cloudflare URLs in the response so the frontend can bootstrap itself.

---

## What changes

| Before (Supabase egress) | After (Cloudflare only) |
|---|---|
| Frontend → supabase.co/functions/v1/manage-app | Frontend → Cloudflare Worker → supabase.co (server-side) |
| Frontend → supabase.co/rest/v1/cached_emails | Removed, use worker data |
| Frontend → supabase.co Realtime WebSocket | Removed, polling via worker |
| `import supabaseClient` in App.tsx | Removed entirely |

After this change, the frontend will have ZERO direct calls to `supabase.co`. All traffic goes through your Cloudflare Workers. Supabase is only accessed server-to-server from the worker.

