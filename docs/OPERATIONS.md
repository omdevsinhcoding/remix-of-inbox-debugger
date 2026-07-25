# Operations Runbook — Secrets, Cron, Cloudflare, GitHub

This is the single source of truth for the "moving parts" of this project:
what each secret is, who reads it, what breaks if it's wrong, and exactly how
to rotate it without breaking users. If something feels messy, it's almost
always because a secret exists in **two places** and only **one** got updated.
Follow this file and it stays clean.

---

## 1. The four systems

The app is intentionally split so no single provider can lock us in:

| System | Where it lives | What it does |
|---|---|---|
| **Supabase** (project `jsqchutnfdeljajkxmly`) | Postgres + Edge Functions + pg_cron | DB, auth sessions, `manage-app` API, scheduled jobs |
| **GitHub Actions** (repo `remix-of-inbox-debugger`) | `.github/workflows/tv-login.yml` | Headless Chromium runner that submits the 8-digit Netflix TV code |
| **Cloudflare Worker** (`cloudflare-worker/`) | Cloudflare edge | Proxies IMAP fetch for Gmail codes, keeps IP off Netflix |
| **Frontend** (Lovable-hosted React app) | `src/` | UI, calls `manage-app` only — never touches Cloudflare or GitHub directly |

Every "why did X stop working" question maps to exactly one of these four. If
you know which system owns the failure, you know which secret to rotate.

---

## 2. Every secret, in one table

Everything below is stored in **Supabase → Settings → Edge Functions →
Secrets** (managed in Lovable via `add_secret` / `update_secret`), unless the
"Also in" column says otherwise.

| Secret | Type | Read by | Also lives in | Rotate how |
|---|---|---|---|---|
| `SESSION_SIGNING_SECRET` | app-random, 64 chars | `manage-app` (signs session JWTs) | — | Auto-generate. **Logs everyone out.** |
| `CRON_SHARED_SECRET` | app-random, 64 chars | `fetch-emails` (validates cron caller) | pg_cron job body (SQL) | Auto-generate → re-run `schedule_email_sync` |
| `WORKER_BOOTSTRAP_SECRET` | app-random, 64 chars | `worker-bootstrap` (validates Cloudflare Worker) | Cloudflare Worker env | Auto-generate → `wrangler secret put` |
| `TV_REPORT_HMAC_KEY` | app-random, 64 chars | `manage-app` `tv_login_fetch_job` / `tv_login_report` | GitHub repo secret **same name** | Auto-generate → paste in GitHub repo secrets |
| `NF_WORKER_TOKEN` | app-random, 32 chars | `manage-app` when calling Worker | Cloudflare Worker env | Auto-generate → `wrangler secret put` |
| `NF_WORKER_URL` | config string | `manage-app` | — | `update_secret`, paste new Worker URL |
| `TV_FAST_RUNNER_URL` | config string | `manage-app` (optional fast runner) | — | `update_secret`, or delete if unused |
| `GITHUB_REPO` | config string (`owner/repo`) | `manage-app` `dispatchGithubTvRunner` | — | `update_secret` — must match linked repo |
| `GITHUB_DISPATCH_PAT` | 3rd-party token | `manage-app` (dispatch TV runs) | GitHub personal access token | Regenerate on GitHub → `update_secret` |
| `TELEGRAM_BOT_TOKEN` | 3rd-party token | `manage-app` (admin alerts) | Telegram BotFather | Regenerate → `update_secret` |
| `TELEGRAM_CHAT_ID` | config string | `manage-app` | — | `update_secret` |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` | config strings | `fetch-emails` (fallback), Worker | Cloudflare Worker env | `update_secret` + Worker |
| `IMAP_PASSWORD` | 3rd-party secret | `fetch-emails` (fallback), Worker | Cloudflare Worker env, Gmail App Password | Google → `update_secret` + `wrangler secret put` |
| `GOOGLE_SEARCH_CONSOLE_API_KEY` | 3rd-party | admin analytics | Google Cloud console | Regenerate → `update_secret` |
| `LOVABLE_API_KEY` | Lovable-managed | AI Gateway calls | — | Use `rotate_lovable_api_key` tool only |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWKS`, `SUPABASE_DB_URL`, `SUPABASE_SECRET_KEYS`, `SUPABASE_PUBLISHABLE_KEYS` | Lovable/Supabase auto | Supabase runtime | — | **Never rotate manually** — Supabase manages these |

Rule of thumb:
- **App-random** → I can rotate with `generate_secret` in one call, zero user input.
- **Config string** → user opens `update_secret` form and pastes.
- **3rd-party token** → user regenerates upstream first, then `update_secret`.

---

## 3. Paired rotations — the ONLY reason it feels "messy"

Some secrets exist in two places because two independent systems need to agree
on the same string. If you rotate one side without the other, that feature
breaks silently until both sides match again. There are exactly **four**
paired secrets:

### 3.1 `CRON_SHARED_SECRET` ↔ pg_cron job body

The pg_cron entry `sync-netflix-emails` embeds the secret inline in the SQL it
runs. After rotating, re-schedule it:

```sql
-- Run in Supabase SQL editor
select public.unschedule_email_sync();
select public.schedule_email_sync(
  '*/3 * * * *',
  'https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/fetch-emails',
  '<NEW CRON_SHARED_SECRET VALUE>'   -- paste the new value once
);
```

Verify with `select public.get_cron_status();` — the `command` column should
show the new secret embedded.

### 3.2 `TV_REPORT_HMAC_KEY` ↔ GitHub repo secret

`scripts/tv-login-runner/tv-login.mjs` running on GitHub Actions signs its
callbacks with this key. After rotating in Supabase:

1. GitHub → `remix-of-inbox-debugger` → Settings → Secrets and variables →
   Actions → `TV_REPORT_HMAC_KEY` → **Update secret**.
2. Paste the same value.
3. Next TV login should succeed. If not, check `manage-app` logs for
   `hmac_mismatch`.

### 3.3 `NF_WORKER_TOKEN` + `WORKER_BOOTSTRAP_SECRET` + `IMAP_*` ↔ Cloudflare Worker env

The Worker (`cloudflare-worker/worker.js`) authenticates callers with
`NF_WORKER_TOKEN`, boots itself with `WORKER_BOOTSTRAP_SECRET`, and reads
Gmail via `IMAP_*`. After rotating any of these in Supabase:

```bash
cd cloudflare-worker
wrangler secret put NF_WORKER_TOKEN            # paste new value
wrangler secret put WORKER_BOOTSTRAP_SECRET    # paste new value
wrangler secret put IMAP_PASSWORD              # if rotated
wrangler deploy
```

Verify: hit `NF_WORKER_URL/health` — it should return `200 ok`. Then trigger
one Gmail workflow from the app.

### 3.4 `GITHUB_REPO` (not a rotation, but the same class of bug)

If the value points to the wrong repo, `dispatchGithubTvRunner` fires an event
in a repo where no workflow exists → runs never start → users see the button
spin forever. Must equal the repo that actually contains
`.github/workflows/tv-login.yml`. Today: `remix-of-inbox-debugger`.

---

## 4. Rotation playbooks

### 4.1 "Everything looks fine, I just want a scheduled clean rotation"

Do this every 90 days:

1. **App-random secrets** — from Lovable chat ask:
   > "Rotate `SESSION_SIGNING_SECRET`, `CRON_SHARED_SECRET`,
   > `WORKER_BOOTSTRAP_SECRET`, `TV_REPORT_HMAC_KEY`, `NF_WORKER_TOKEN`."

   The agent runs `generate_secret` for each. **Zero user typing.**
2. **Sync the paired sides** — sections 3.1 → 3.3 in order.
3. **Users**: `SESSION_SIGNING_SECRET` invalidates every logged-in session —
   expect a wave of forced re-logins. Do this outside peak hours.

### 4.2 "A specific value leaked" (single-secret rotate)

Only rotate the one that leaked, then only the paired side for that one.
Everything else stays untouched.

### 4.3 "3rd-party token expired / was revoked"

1. Regenerate on the provider (GitHub PAT page, BotFather, Google App
   Password, Gmail app password).
2. Lovable chat:
   > "Update the `GITHUB_DISPATCH_PAT` secret." — the agent opens
   > `update_secret` and you paste.
3. If the token also lives in Cloudflare (e.g. `IMAP_PASSWORD`), run the
   `wrangler secret put` step from 3.3.

### 4.4 "I want to change hosting / worker URL / repo"

Use `update_secret` for `NF_WORKER_URL`, `GITHUB_REPO`, or `TELEGRAM_CHAT_ID`.
No paired side — one place, one update.

### 4.5 `LOVABLE_API_KEY`

Never `update_secret` this. Use the `rotate_lovable_api_key` tool. If the AI
Gateway returns `unauthorized`, rotate once. If it still fails, contact
support — do not rotate again.

---

## 5. Cron jobs — what's scheduled and why

There are two pg_cron jobs, both managed by SQL functions in the DB (see
`get-db-functions`). Do not edit `cron.job` rows by hand — always go through
the wrapper functions so the secret embedding stays consistent.

| Job name | Schedule | Wrapper functions |
|---|---|---|
| `sync-netflix-emails` | every 3 min (configurable) | `schedule_email_sync(cron_expr, function_url, auth_key)`, `unschedule_email_sync()`, `get_cron_status()` |
| `email-cleanup` | daily at 3am (configurable) | `schedule_email_cleanup(days, hour)`, `unschedule_email_cleanup()`, `get_email_cleanup_status()` |

Change interval:

```sql
-- e.g. run every minute instead of every 3
select public.unschedule_email_sync();
select public.schedule_email_sync(
  '*/1 * * * *',
  'https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/fetch-emails',
  current_setting('app.cron_shared_secret', true)  -- or paste the value
);
```

The Admin panel → Sync Status card exposes both jobs; prefer that UI over raw
SQL.

---

## 6. Cloudflare Worker — deploy & config

Files: `cloudflare-worker/worker.js`, `cloudflare-worker/wrangler.toml`.

First-time deploy on a new machine:

```bash
cd cloudflare-worker
npm install
wrangler login
# Set every secret listed under section 3.3 (also IMAP_HOST, IMAP_PORT, IMAP_USER)
wrangler secret put NF_WORKER_TOKEN
wrangler secret put WORKER_BOOTSTRAP_SECRET
wrangler secret put IMAP_HOST
wrangler secret put IMAP_PORT
wrangler secret put IMAP_USER
wrangler secret put IMAP_PASSWORD
wrangler deploy
```

Copy the deployed URL, then in Lovable:
> "Update `NF_WORKER_URL` to `https://<new-worker>.workers.dev`."

Redeploy `manage-app` and `fetch-emails` after so they pick up the new URL.
This happens automatically in Lovable when the secret changes.

---

## 7. GitHub Actions — one workflow, one repo

- **Workflow file**: `.github/workflows/tv-login.yml`
- **Runner script**: `scripts/tv-login-runner/tv-login.mjs`
- **Repo**: whatever `GITHUB_REPO` points to (should be
  `remix-of-inbox-debugger`).
- **PAT scopes**: `repo` (contents:read) + `actions:write` — no more.

Concurrency: workflow has no `concurrency:` block on purpose. GitHub-hosted
runners execute up to ~20 jobs in parallel on standard plans, which is more
than enough — user A never blocks user B. Do not add `concurrency: tv-login`;
that would serialize everyone.

Test the dispatch path without touching Netflix:

```bash
gh api repos/<owner>/remix-of-inbox-debugger/dispatches \
  -f event_type=tv-login-test \
  -F 'client_payload[test_id]=manual-1'
```

Watch: repo → Actions → "TV Auto-Login" → the run title includes the
`test_id`. If nothing appears, the PAT is wrong or `GITHUB_REPO` is wrong.

---

## 8. What to do the moment something breaks

Symptom → owner → fix:

| Symptom | Owner | Fix |
|---|---|---|
| Every user logged out at once | `SESSION_SIGNING_SECRET` changed | Expected after rotate; no action |
| Gmail codes stop flowing | Cloudflare Worker OR `IMAP_PASSWORD` | Hit `NF_WORKER_URL/health`; check Worker logs |
| TV code stuck on "Signing you in…" | GitHub Actions | Check Actions tab; check `GITHUB_REPO`, `GITHUB_DISPATCH_PAT` |
| GitHub run finishes but app doesn't update | `TV_REPORT_HMAC_KEY` mismatch | Re-sync section 3.2 |
| pg_cron rows in `cron.job` but nothing fires | `CRON_SHARED_SECRET` mismatch or wrong URL | Re-run `schedule_email_sync` (3.1) |
| `manage-app` returns `unauthorized` on AI calls | `LOVABLE_API_KEY` | `rotate_lovable_api_key` once |
| Telegram admin alerts silent | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Verify bot is in the chat; `update_secret` |

---

## 9. TL;DR (for future you at 2am)

1. **Never rotate one side of a paired secret without the other.** The four
   pairs are in section 3.
2. **App-random secrets** are one chat message away — no forms, no typing.
3. **`GITHUB_REPO` must match the repo that owns the workflow file.**
4. **`SESSION_SIGNING_SECRET` rotation = mass logout.** Schedule it.
5. If a feature breaks after any change, section 8 tells you which secret is
   wrong in under 10 seconds.

---

## 10. TV Login runners — deployment truth table

There are two runners that submit the 8-digit Netflix TV code. Only one is
active at a time; which one is chosen from `app_settings.vps_config.mode`.

| Mode  | Runner                    | Source of truth                        | Deploy how |
|-------|---------------------------|----------------------------------------|-----------|
| `vps` | `tv-fast-runner` on the VPS | `scripts/tv-fast-runner/server.mjs`     | `sudo bash scripts/tv-fast-runner/redeploy.sh` on the VPS |
| `github` | GitHub Actions workflow  | `.github/workflows/tv-login.yml` + `scripts/tv-login-runner/tv-login.mjs` | Auto — every push to `main` is what Actions runs |

### 10.1 VPS is running stale code (drift detection)

Symptom: `/health` on the VPS omits `version`, returns `busy` instead of
`active_jobs`, or `max_ms` < the repo default (20000). Root cause: the
original `install-vps.sh` seeded `TV_LOGIN_MAX_MS=15000` and skipped the
env-file write on every subsequent run, and it never pulled fresh code.
That has been fixed — the current installer always writes today's
defaults (backing the old file up to `/etc/tv-fast-runner.env.bak`) and
`git pull --ff-only`s the repo before restart.

Redeploy any VPS in one command:

```bash
ssh root@<VPS_IP>
cd /path/to/repo && git pull
sudo bash scripts/tv-fast-runner/redeploy.sh
```

Verify:

```bash
curl -s http://127.0.0.1:8788/health | jq
# version must equal SERVER_VERSION in scripts/tv-fast-runner/server.mjs
# max_ms must be 20000
# active_jobs must be present
```

If `version` is missing or older than the repo, the VPS is still stale —
`redeploy.sh` failed or the checkout isn't a git worktree. Re-clone the
repo under a git checkout and re-run.

### 10.2 GitHub Actions "failed in ~24 seconds" with no report

Symptom: `tv_login_events` row stays `status='queued'` forever;
`github_run_url IS NULL`; the failed workflow email arrives but no
`tv_login_report` ever reaches `manage-app`.

Root cause identified: the workflow was running on `ubuntu-latest`
(Ubuntu 24.04) while the Playwright Chromium cache was captured on
22.04. Chromium's dynamic linker aborts at launch on the library
mismatch, so `tv-login.mjs` exits before the first HMAC-signed fetch —
nothing is reported and the event row is never updated.

Fixes applied:

1. `runs-on: ubuntu-22.04` (pinned).
2. Playwright + node_modules cache keys bumped so the 24.04 caches
   can't be restored on the pinned 22.04 runner.
3. A new `Report workflow failure to manage-app` step runs with
   `if: failure()` on every job — it re-computes the HMAC and POSTs
   `tv_login_report` with `result: workflow_failed`, listing which
   step's `outcome` was `failure`. Events can no longer stay `queued`
   silently.
4. A `Show dispatch context` step logs `event_name`, `EVENT_ID`,
   `TEST_ID`, and secret presence at the top of every run so
   inspecting a failed run is one glance.

Manual verification required (I cannot read GitHub Actions logs from
this environment): after this PR merges, dispatch a run and confirm
(a) `Show dispatch context` prints a non-empty `EVENT_ID`, and
(b) if you deliberately break something, the failure-report step still
runs and the DB event lands in `status='error'`, `result='workflow_failed'`.

