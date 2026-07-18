# Netflix Auto-Login Test Service (isolated)

Temporary scaffold to test automated Netflix login using accounts already configured in the admin panel (`app_settings.email_accounts` + `IMAP_USER` primary).

**Isolation note:** nothing here is imported by the main app. Removing this folder + the `netflix-auto-login` edge function + the `/admin/netflix-test` route leaves the production app untouched.

## Runtime

Headless Playwright (Chromium) — **no visible browser window opens**. This is a Node.js/Express service you run outside Supabase (Supabase Edge = Deno, no browser binary).

Run locally, on a VPS, Render, Railway, or a small VM. All it needs is HTTPS reachability from your Supabase edge function.

## Flow

```
[Admin UI]  → edge fn `netflix-auto-login` action=trigger
              ↓  (POST /login with email)
[This service]  → Playwright opens netflix.com/login (headless)
                  → fills email, clicks Continue
                  → polls edge fn action=get_otp (reads cached_emails)
                  → enters OTP digits
                  → dumps cookies
              ↓  (POST edge fn action=store_cookies)
[netflix_sessions table]  ← cookies_json saved, status=success
[Admin UI]  ← polls action=get_logs for live progress
```

## Setup

```bash
cd netflix-automation
npm install
npx playwright install chromium
cp .env.example .env
# fill SUPABASE_URL, SERVICE_ROLE_KEY, NETFLIX_AUTOMATION_SECRET
npm start
```

Then in Supabase secrets add:
- `NETFLIX_AUTOMATION_URL` = `https://your-host:3000`
- `NETFLIX_AUTOMATION_SECRET` = same as `.env`

## Endpoints

- `GET  /health` → `{ ok: true }`
- `POST /login` body: `{ email, accountLabel }` header: `x-secret: <NETFLIX_AUTOMATION_SECRET>` → returns `{ success, cookies?, error? }`

## Kill switch

To disable end-to-end without deleting anything:
```sql
DELETE FROM app_settings WHERE key IN ('netflix_automation_enabled');
```
Or simply unset `NETFLIX_AUTOMATION_URL`. Edge fn will return `disabled`.
