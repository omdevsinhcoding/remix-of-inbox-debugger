

# Fix: Remove Setup Screen for Users, Bootstrap Worker URLs from Login

## Problems

1. **"Setup Required" screen shows to ALL users** — including regular users who should never see it. Only admin should configure this, and it's already configured in admin panel.

2. **Circular dependency** — EmailViewer calls `apiCall("manage-app", { action: "get_settings" })` to get worker URLs, but `apiCall()` itself needs worker URLs from localStorage to work. If localStorage is empty (new browser/device), everything breaks.

3. **"No Cloudflare Worker responded" error** — Even though admin saved URLs in settings, the EmailViewer's `resolvedWorkerUrls` might be empty because the bootstrap `apiCall` failed (due to the circular dependency above).

## How it should work

The admin already added worker URLs in the admin panel. When any user (admin or regular) logs in, the login response should include the worker URLs. The frontend stores them in localStorage. No "Setup Required" screen needed.

## Plan

### Step 1: Remove WorkerUrlSetup screen entirely

Remove the `WorkerUrlSetup` component and the check at line 2110 that blocks the entire app. Users should never configure worker URLs — that's admin's job.

### Step 2: Make apiCall work without localStorage on first call

Change `apiCall()` to accept an optional `workerUrl` parameter override. For the very first login call, the frontend needs ONE hardcoded or user-provided worker URL. Two approaches:

**Approach: Store initial worker URL in environment variable**

Add `VITE_WORKER_URL` env var. `apiCall()` falls back to this when localStorage is empty. This way:
- First login call uses `VITE_WORKER_URL`
- Login response includes all worker URLs from settings
- Frontend stores them in localStorage
- All subsequent calls use localStorage URLs

### Step 3: Return worker URLs in login response

**File:** `supabase/functions/manage-app/index.ts`

In the `login` action handler, after successful auth, also fetch `primary_cloudflare_urls` and `email_accounts` from settings and include them in the response.

### Step 4: Store worker URLs on login

**File:** `src/App.tsx`

In both `ProfileSelectPage.executeLogin()` and `AdminLoginPage.executeLogin()`, after successful login, extract worker URLs from response data and call `storeWorkerUrls()`.

### Step 5: Also store worker URLs when admin saves settings

**File:** `src/App.tsx`

When admin saves Primary IMAP Cloudflare URLs or email account URLs in settings, also update localStorage via `storeWorkerUrls()` so the current browser session stays in sync.

---

## Summary

| Before | After |
|--------|-------|
| "Setup Required" screen blocks all users | Removed entirely |
| apiCall needs localStorage to work | Falls back to `VITE_WORKER_URL` env var |
| Worker URLs not returned on login | Login response includes all worker URLs |
| Users must manually enter worker URL | Automatic — admin configures once, all users get URLs on login |

