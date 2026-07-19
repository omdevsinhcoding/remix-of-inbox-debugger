# Netflix Login Test + Selenium VPS worker

**Scope:** temporary testing folder. Not production. Not shipped in build.

Mirrors the uploaded Python script's simple behavior: load Netflix login,
submit only the email, wait briefly, then detect whether Netflix showed OTP,
password, blocked, or unknown state. Every step prints a log line prefixed
with `[ISO-time]` so you can see exactly where the flow is.

The admin panel's **Start Test** button calls the Supabase edge function
`netflix-test-login`, which proxies to the VPS Selenium worker.

Important: Netflix commonly blocks cloud/VPS IPs. If the live log says
`netflix_security_block`, the selector/password logic is not broken — Netflix
rejected the VPS IP/browser fingerprint. Use a clean residential/mobile IP or
set a proxy on the VPS worker with `NF_PROXY_URL`.

## Flow

1. Load the assigned Netflix account for a profile (from `email_accounts`).
2. Pick the address to type into Netflix:
   - Recipient filter (e.g. `omdevsinhgohil538+freenf@gmail.com`) if set,
   - Otherwise the IMAP username.
3. `GET https://www.netflix.com/login` — grab cookies + `authURL`.
4. Submit the email only, with empty password, matching the uploaded script.
5. If Netflix asks for password or risk/reCAPTCHA, stop and log that state.
6. If OTP is triggered, poll our own `cached_emails` table for the freshest Netflix sign-in-code
   mail addressed to that account (newer than the trigger timestamp).
7. Extract the digit code from the subject/preview.
8. `POST` the code back to Netflix, capture the session cookies.
9. Save the cookies into `netflix_sessions` (upsert on `email`).

## Run locally

```bash
node netflix-test/netflix-login.mjs \
  --email omdevsinhgohil538+freenf@gmail.com \
  --account-label "Primary"
```

Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` env vars for the
OTP-poll step to read `cached_emails`.

## VPS Selenium worker

Reference worker code is in `netflix-test/selenium-worker.py`.

It supports these environment variables:

- `NF_WORKER_TOKEN` — shared token used by the edge function.
- `PORT` — default `8787`.
- `CHROMEDRIVER` — default `/usr/bin/chromedriver`.
- `CHROME_BIN` — default `/usr/bin/google-chrome`.
- `NF_ARTIFACT_DIR` — screenshots/html captures for failed Netflix states.
- `NF_PROXY_URL` — optional proxy URL passed to Chrome via `--proxy-server`.

Working success condition:

1. Selenium signs in on Netflix.
2. Worker returns cookies containing `NetflixId` and `SecureNetflixId`.
3. Edge function saves cookies/logs/date into `netflix_sessions`.

Failure condition:

- Cookies are **not saved** unless Netflix is actually signed in.
- `netflix_security_block` means change the VPS IP/proxy, then retry.
