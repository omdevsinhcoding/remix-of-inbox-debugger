
What I found

- This is not one single bug. It is a mix of refresh logic, filtering, and a broken worker/backend path.
- The backend cache already has emails and they are recent, so the inbox is not truly empty.
- Right now `showSignInCodes` is off, and a large chunk of cached emails match that hidden filter. So some “new emails” are already present but not shown.
- In `src/App.tsx`, the 10-second auto-refresh only reloads cached rows. It does not trigger a fresh IMAP sync. That means new emails will not keep arriving automatically unless a manual sync happens.
- The Refresh button starts the slow IMAP sync path and keeps the icon spinning for the whole request, with a 50s timeout window.
- The screenshot pattern (`404` error banner while old emails are still visible) matches the current UI behavior: failed requests set `error`, but old email state stays on screen, so it looks half-working.
- The viewer still depends on worker URL resolution that can fall back to stale external config. I also found no recent logs for the connected backend function on the failing live path, which strongly suggests the external deployment is still hitting an outdated worker/backend route.

Implementation plan

1. Fix the refresh model in `src/App.tsx`
- Separate “cache load” from “server sync”.
- Keep fast cache polling for the UI.
- Add throttled background syncs so new IMAP emails actually enter the cache without requiring repeated manual refreshes.
- Prevent overlapping sync requests.

2. Fix the long rotating refresh behavior
- Make Refresh do an immediate cache reload first.
- Run the slower IMAP sync as a background action with clear status text.
- Stop using one long blocking spinner for the full sync lifecycle.

3. Make errors and stale data behave correctly
- If the latest request fails, keep old emails visible but mark them as stale instead of showing a confusing mixed state.
- Track and show:
  - last successful cache load
  - sync in progress
  - last sync failure
- Clear error state only when a real successful fetch happens.

4. Fix worker resolution and fallback
- Normalize resolution order to:
  assigned account worker -> primary worker setting -> env fallback.
- If the worker returns `404/405/502`, retry the direct backend path once.
- Add a small diagnostic indicator so the app shows which worker/backend path is actually being used.

5. Fix hidden-email confusion
- Show an active filter banner when sign-in codes or password resets are hidden.
- Include a hidden-count message so it is obvious when fresh emails exist but are filtered out.
- If desired, switch sign-in code visibility back on as part of the fix.

Technical details
```text
Current:
10s timer -> cache only
manual refresh -> slow IMAP sync
worker 404 -> error banner + stale old list
sign-in filter off -> fresh sign-in emails hidden

Target:
10s timer -> quick cache refresh
background sync -> actually pulls new mail
refresh button -> fast feedback, no misleading long spin
worker failure -> direct backend fallback
filters -> visible, not silently hiding fresh mail
```

Files in scope
- `src/App.tsx`
- `cloudflare-worker/worker.js`
- `supabase/functions/fetch-emails/index.ts`
- `supabase/functions/manage-app/index.ts` only if I centralize worker source/diagnostics

Database
- No schema migration needed.
- No new tables needed.
