## Fixes

### 1. Live countdown timer + friendlier toast (session timeout)

Currently `useSessionTimeoutGuard` only schedules a silent `setTimeout` and shows a plain error toast on expiry. Nothing visible during the session.

**Changes in `src/App.tsx`:**
- Create a new `SessionCountdown` component that reads `session_started_at` + timeout minutes from `app_settings` and renders a small fixed pill (bottom-right on desktop, top-right on mobile) showing `mm:ss` remaining.
  - Green when > 2 min, amber when 60–120s, red + pulse when < 60s.
  - Auto-hides when timeout is disabled (0 min) or admin session.
- Warning toast at 60s left: `"⏰ Session ending in 1 minute — save your work"` (only once per session).
- On expiry, replace current toast with a nicer one:
  ```
  toast("🔒 Session timed out", {
    description: `You've been signed out after ${minutes} min of activity. Tap your profile to sign back in.`,
    duration: 6000,
  });
  ```
- Mount `<SessionCountdown />` inside `ProtectedRoute` right next to `useSessionTimeoutGuard(role)` so it appears on every authenticated page.

### 2. Show cached emails instantly on login (no blank screen)

Root cause in `EmailViewer` (line 2446): the load `useEffect` early-returns when `resolvedWorkerUrls.length === 0`, so on first mount — before worker URLs finish loading from `app_settings` — nothing calls `loadCachedEmails`. Cached emails only appear after the 30s poll or a manual refresh.

**Changes in `src/App.tsx` → `EmailViewer`:**
- Kick off `loadCachedEmails()` **immediately on mount**, independent of worker URL discovery. `loadCachedEmails` already falls back to direct Supabase when workers are unavailable, so it works day-one.
- Cache emails in `localStorage` under `cached_emails_v1` (keyed by user id) whenever `setEmails` runs. On mount, hydrate `emails` state from that cache **synchronously** via `useState(() => …)` → user sees their previous inbox in < 50 ms, before any network.
- Keep the worker-URL effect for later syncs, but remove the `resolvedWorkerUrls.length === 0` early return that blocks the load.
- Drop the initial `setLoading(true)` full-screen spinner when hydrated cache is present — show emails immediately with a subtle "Refreshing…" indicator in the header instead.

### 3. Fast refresh — "click and emails are there"

Current `fetchEmails` awaits full IMAP sync before showing anything, so refresh button feels slow (5–15 s).

**Changes in `src/App.tsx` → `EmailViewer.fetchEmails`:**
- Change flow to: (a) call `loadCachedEmails()` first (returns in ~200 ms), (b) *then* fire `syncViaWorker()` in the background without blocking UI, (c) when sync resolves, run `loadCachedEmails()` again to pull in newly synced messages.
- Toast changes:
  - Immediate success on cache load: quietly update `lastUpdated`.
  - Background sync: show a tiny inline "Checking for new…" spinner in the header (not a blocking toast).
  - When sync finishes: `toast.success("N new emails")` if count grew, else silent.
- Add optimistic update: keep old email list visible during sync (never clear before new data arrives).
- Reduce poll interval from 30 s → 15 s for cached refresh (cheap; hits worker/Supabase cache endpoint only).

### Technical notes

- `session_config` shape in `app_settings`: `{ timeoutMinutes: number }` — already in place.
- localStorage cache key must be namespaced per user so switching profiles doesn't leak emails: `cached_emails_v1:${user.id}`.
- Countdown ticker uses `setInterval(1000)` inside the `SessionCountdown` component; cleaned up on unmount.
- No DB migrations. No new secrets. No edge function changes.

### Files touched
- `src/App.tsx` (only)
