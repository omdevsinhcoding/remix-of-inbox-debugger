
Understood. Here is the exact fix plan.

Goal
1. Root `/` should always show user profiles, not the “Connect to Server” page.
2. Clicking Refresh in `/viewer` should fetch new emails right then, not wait for auto-sync.
3. I’ll also prepare the project with a clean schema/RLS/cron setup path so you can copy it to another Supabase project/account manually.

What I found
- The homepage problem is a bootstrap deadlock: `apiCall()` refuses to run unless a worker URL already exists in that browser’s localStorage. So a fresh user device cannot load profiles even if the admin already saved worker URLs in the admin panel.
- The refresh button is still not “instant” because `fetchEmails()` loads cached emails first and starts sync in the background. The spinner stops early, so the user does not see the newest mail on click.
- In `fetch-emails`, IMAP sync is limited to `FULL_SYNC_MAX_UIDS = 5`. I checked the network snapshot and the sync response was `fetched: 0, skipped: 5`, which matches your complaint: the app is only re-checking a tiny window and missing the newest email during manual refresh.
- `manage-app` still exposes settings too broadly through the edge function, even though the DB tables themselves are now locked down. That should be tightened while fixing bootstrap.

Implementation plan

1. Fix the index page bootstrap
- Keep `/` as the profile page.
- Remove the user-facing dependency on localStorage worker URL for the homepage.
- Add a safe public bootstrap path in `manage-app` (for example `bootstrap_public`) that returns only:
  - user profile cards for login
  - public reCAPTCHA config if enabled
  - worker URLs saved by admin
- Call that bootstrap action directly via Supabase Edge Function URL using `VITE_SUPABASE_URL` + publishable key, so fresh browsers can load profiles before any worker URL is stored locally.
- When bootstrap returns worker URLs, store them locally for the rest of the session.
- Result: users will directly see profile cards on `/`; no manual worker URL page.

2. Remove the wrong user flow
- Delete the “Connect to Server” screen from the normal user flow.
- Keep a setup/fallback message only for admin/bootstrap cases where there are truly no worker URLs configured in admin settings at all.
- Make the UI message admin-focused, not user-facing.

3. Make Refresh truly manual and immediate
- Change the Refresh button flow in `EmailViewer` to:
  1. start spinner
  2. call sync immediately
  3. wait for sync to finish
  4. reload the latest emails
  5. stop spinner
- No more background-only sync for manual refresh.
- Auto-poll can stay, but manual refresh must be the primary “show new mail now” path.

4. Fix the IMAP sync window
- Replace the current “check only last 5 matching UIDs” logic.
- For manual refresh, expand the fetch window substantially (for example 20–50 recent matching messages) or make it incremental from latest cached `date/message_id`.
- Keep dedupe robust using `message_id` when available, with fallback to UID/account label.
- This is the main backend fix for your “new mail still not showing on refresh” issue.

5. Make worker cache behave correctly after manual sync
- After sync completes, force a fresh cache reload instead of relying on stale/background behavior.
- If needed, bypass stale worker cache on manual refresh or refresh KV synchronously before the final UI reload.
- Result: if a new email exists, it appears right after the user clicks Refresh.

6. Tighten edge-function exposure while doing this
- Restrict `manage-app` so public callers cannot read arbitrary settings keys.
- Safe public access should only expose the bootstrap data needed for login.
- Sensitive keys such as `config`, `email_accounts`, Telegram config, IMAP config, cron config should require admin/session access.

What I will deliver in code
- Updated `src/App.tsx`
  - dynamic homepage bootstrap
  - no user-facing worker input screen
  - synchronous manual refresh flow
- Updated `supabase/functions/manage-app/index.ts`
  - safe bootstrap/public action
  - restricted settings access
- Updated `supabase/functions/fetch-emails/index.ts`
  - larger/manual refresh scan window
  - better dedupe / fresh sync handling
- If needed, a small migration/doc cleanup for cron/setup consistency

Current database schema + RLS
- `app_users`
  - columns: `id, username, password, name, role, totp_secret, created_at, must_change_password, assigned_accounts`
  - RLS: service_role only
- `app_settings`
  - columns: `key, value`
  - RLS: service_role only
- `app_otps`
  - columns: `id, user_id, otp, created_at, expires_at`
  - RLS: service_role only
- `cached_emails`
  - columns: `id, subject, from_address, to_address, date, otp, preview, html, cached_at, account_label, message_id`
  - RLS: service_role only
- `audit_logs`
  - columns: `id, action, actor_id, target_id, details, ip, created_at`
  - RLS: service_role only

Manual setup in another Supabase project
1. Create a new Supabase project.
2. Enable extensions:
```sql
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
```
3. Create the tables above.
4. Enable RLS on all 5 tables.
5. Add service-role-only policies for all of them.
6. Add these database functions:
   - `schedule_email_sync(cron_expr, function_url, auth_key)`
   - `unschedule_email_sync()`
   - `get_cron_status()`
7. Deploy edge functions:
   - `manage-app`
   - `fetch-emails`
   - `send-login-notification`
   - `send-telegram-otp`
8. Add secrets in Supabase:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `IMAP_HOST`
   - `IMAP_PORT`
   - `IMAP_USER`
   - `IMAP_PASSWORD`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
9. Create cron manually with the new project URL and anon key:
```sql
select cron.schedule(
  'sync-netflix-emails',
  '*/3 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/fetch-emails',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer YOUR_ANON_KEY'
    ),
    body := '{"mode":"sync","source":"cron"}'::jsonb
  );
  $$
);
```

Moving this project to a second Supabase account
- This project is already connected to an external Supabase project, so moving it means reconnecting Lovable to a new Supabase project after you recreate the backend there.
- Safe transfer order:
  1. create new Supabase project in second account
  2. run schema + RLS + functions
  3. set secrets
  4. deploy edge functions
  5. reconnect this Lovable project to the new Supabase project
  6. re-enter IMAP credentials and worker URLs
  7. test login, homepage profiles, refresh, cron

Important transfer caveat
- `email_accounts.password` values are encrypted using the old project’s service-role-based secret logic. Those encrypted values will not decrypt in a different Supabase project.
- So after transfer, IMAP passwords must be re-entered manually or explicitly re-encrypted for the new project.
- Also do not reuse the old hardcoded cron migration as-is, because it contains the old project URL/key.

Technical notes
- Root route already points to `ProfileSelectPage`; it is just being blocked by worker bootstrap logic.
- The refresh bug is both frontend and backend:
  - frontend: manual refresh does not wait for sync
  - backend: sync only checks a last-5 window
- I also found config drift that should be cleaned up in docs/setup so future manual migrations are predictable.

Execution order I recommend
1. dynamic homepage bootstrap
2. manual refresh rewrite
3. IMAP last-5 fix
4. secure public/admin settings separation
5. docs/setup cleanup for second Supabase project
