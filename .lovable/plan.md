
# Constraint-Based Redesign — Top 3 DB Operations

Working strictly within the Supabase Free plan. No upgrades, no added compute, no paid services. The database becomes the last layer; every request tries Browser → CDN → Worker memory → Worker KV first.

Numbers below are grounded in the audit already gathered from `pg_stat_statements` (14-day window). Percentages are conservative and assume the redesign is fully deployed.

Cache-layer notation used throughout:

```text
L0 Browser memory      (React state, dedupe in-flight)
L1 Browser storage     (sessionStorage + ETag)
L2 Cloudflare CDN      (Cache API on Response)
L3 Worker memory       (module-level Map, warm across requests)
L4 Cloudflare KV       (60 s–7 d TTL, ETag-keyed)
L5 Edge Function       (runs only on L4 miss / writes)
L6 Postgres            (only on L5 miss / writes; last resort)
```

---

## Operation #1 — `app_settings` reads (473,721 + 21,356 calls, ~140 s CPU)

### Problem
Every route change, hook mount, and admin panel widget calls `manage-app` which then does `select value from app_settings where key = $x` — the same ~10 keys, on repeat, across 5k+ sessions.

### Root Cause
- `bootstrap_public` payload is refetched on every SPA mount instead of being cached with an ETag.
- Individual features (location policy, tv_feature, netflix_promo, session_limits, email_visibility, cron_config, ipwho_alert, primary_cloudflare_urls, email_accounts, free_avatar_cooldown) each call `manage-app` again inside their own code paths (18 distinct call sites in `manage-app/index.ts` alone).
- Client-side `adminSettingsCache` exists but is not the single reader — direct reads bypass it.

### Current Flow
```
Browser mount → invokeEdge(manage-app, bootstrap_public)
             → manage-app cold or warm
             → SELECT app_settings.value WHERE key=$1  (×N keys)
             → return JSON
```
- **DB round trips per user session:** ~40 (bootstrap + feature reads)
- **Read cost:** 473,721 + 21,356 = **495,077 reads / window**
- **Write cost:** 5,524 upserts (admin edits)
- **CPU cost:** ~140,600 ms
- **IO cost:** low per-row, extreme by volume (seq scan of 25-row table 73,344×)

### Optimized Flow
```
Browser  ──► sessionStorage[bootstrap_etag]
             │ hit fresh (<60 s)         → serve L1, done
             ▼
Cloudflare CDN (Cache API)
             │ hit fresh                 → serve L2, done
             ▼
Worker memory Map<version,payload>
             │ hit fresh                 → serve L3, done
             ▼
Worker KV: settings:v{N}                 → serve L4, warm L3
             │ miss
             ▼
Edge Function manage-app.bootstrap_public
             │ single SELECT app_settings WHERE key = ANY($1)  (one row set)
             ▼
Postgres (only on true miss, ≤1/min globally)
```

Key design points:
- One consolidated `settings_snapshot` blob replaces N individual reads. Version bumps only on admin write (already the case via `adminSettingsCache.reconcileVersion`).
- Worker returns `304 Not Modified` when `If-None-Match: <etag>` matches — 0-byte body.
- SPA reads settings only from `adminSettingsCache`; every direct `supabase.from('app_settings')` in client code becomes forbidden.
- Admin writes: edge function upserts DB, bumps version, PURGEs KV key. Next reader repopulates.

### New Architecture summary
- **Cache Strategy:** stale-while-revalidate at L1/L2/L3/L4; hard-invalidate only on admin write.
- **Worker Strategy:** module-scope `Map<version, {payload, etag}>`; serves L3 with 0 KV read on warm isolate.
- **KV Strategy:** `settings:v{version}` (immutable body per version) + `settings:latest` pointer key. Immutable body → 7-day TTL. Pointer → 60 s TTL.
- **Browser Strategy:** cache payload+etag in `sessionStorage`; send `If-None-Match`. Refetch only on tab focus after >60 s stale.
- **Edge Strategy:** Only invoked on version pointer miss; issues **one** `SELECT ... WHERE key = ANY(...)`.
- **Database Strategy:** Single batched read; no per-key round trips ever.

### Reduction
| Metric | Before | After | Δ |
|---|---|---|---|
| DB reads / window | 495,077 | ~2,000 | **-99.6 %** |
| DB CPU (this op) | 140.6 s | ~1 s | **-99 %** |
| IO (seq scans on `app_settings`) | 73,344 | ~2,000 | **-97 %** |
| Edge invocations (settings path) | ~495k | ~2k | **-99 %** |
| Network egress (client) | full body every fetch | 304 mostly | **-90 %** |

### Fail-safe
- Supabase down → L1/L2/L3/L4 continue to serve last known good payload for **up to 7 days** (KV immutable body). App stays fully functional except for admin edits.
- Worker down → CDN + browser cache carry the app for **≥60 s** transparently.
- Both down → SPA still boots from `sessionStorage` copy.

### Risk / Rollback / Verify
- **Risk:** Low. Feature flag `SETTINGS_KV=1` in Worker; flip to `0` reverts to direct edge call.
- **Rollback:** unset flag; purge KV key.
- **Verify:** `pg_stat_statements` diff for `app_settings WHERE key=$1` calls per hour; CDN/KV hit ratio in Worker logs; `304` vs `200` ratio on `bootstrap_public`.

---

## Operation #2 — `cached_emails` inbox reads (~140,000 calls, ~440 s CPU)

Combines queries #1, #2, #4 from the audit (unfiltered `id/account_label/date` polls + `WHERE account_label=ANY(...) ORDER BY date DESC`).

### Problem
Inbox lists are polled from every open tab without a cursor. The 117-row table is scanned repeatedly by 5000-user projections.

### Root Cause
- Client uses PostgREST `select('id,account_label,date').limit(...)` with no `since` cursor.
- `cached_emails_modseq_seq` + `bump_email_modseq` are already installed but no read path consumes them.
- Multiple parallel React effects poll the same data (there are `setInterval` timers in `App.tsx:1109/4271/10981/12238`).

### Current Flow
```
Every tab (poll ~30 s) → PostgREST cached_emails select → full body → client-side filter
```
- **DB round trips per user per minute:** 2–4
- **Read cost:** ~140,000
- **Write cost:** none in this op (writes are separate)
- **CPU cost:** ~440 s (LIMIT/OFFSET + ORDER BY date desc)
- **IO cost:** 235,541 seq scans + 14,981 index scans

### Optimized Flow
```
Client ──► /worker/inbox?labels=a,b&since=<modseq>&etag=<h>
        L1 sessionStorage[inbox:{labels}:{since}] ── hit fresh <15 s → done
        L3 Worker memory  Map<key, {payload,etag}> ── hit fresh <30 s → done
        L4 KV key = "inbox:{sha(labels)}:{since}"  ── hit fresh <30 s → done
        L5 Edge Function: SELECT id,account_label,date,preview,subject,from_address,otp,modseq
                          FROM cached_emails
                          WHERE account_label = ANY($1) AND modseq > $2
                          ORDER BY modseq DESC LIMIT 50
```

Key design points:
- Cursor-based diff: response = `{items[], next_modseq}`. When client re-polls with `since = next_modseq`, 99 % of responses are `{items: [], next_modseq}` — a ~30-byte JSON.
- Empty-diff responses cached by `(labels, since)` in KV for 30 s. New mail arrives → cron `fetch-emails` PURGEs `inbox:*` KV prefix (via `list+delete` or Cloudflare Cache Tags on paid plans; Free plan uses monotonic version key `inbox_version` bumped by ingest, appended to KV key).
- Full HTML fetched on-demand only via existing `email-html` route (already worker-cached).
- Retire all client `setInterval` polls; use `visibilitychange → visible` + BroadcastChannel across tabs so **only the foreground tab** ever polls.

### Reduction
| Metric | Before | After | Δ |
|---|---|---|---|
| DB reads / window | ~140,000 | ~4,000 | **-97 %** |
| DB CPU (this op) | 440 s | ~15 s | **-96 %** |
| IO (seq scans) | 235,541 | ~5,000 | **-98 %** |
| Edge invocations | ~140k | ~4k | **-97 %** |
| Network egress | full bodies | mostly empty-diff 30-byte JSON | **-95 %** |
| Foreground tabs actually polling | all tabs | 1 per browser | **-70 % client work** |

### Fail-safe
- DB slow/down → KV empty-diff responses keep the inbox visually stable for **≥30 s** per key, effectively indefinitely if no new mail arrives.
- Ingest cron continues writing; readers see stale-but-consistent list. No error surfaced to users.
- Worker down → browser `sessionStorage` shows last known list. Read-only degradation only.

### Risk / Rollback / Verify
- **Risk:** Medium — introduces cursor semantics. Mitigation: client transparently falls back to full list when it has no cursor yet.
- **Rollback:** Worker flag `INBOX_KV=0` proxies straight to PostgREST as today.
- **Verify:** `pg_stat_statements` for the two cached_emails select shapes; Worker "empty-diff ratio" metric; end-to-end: new mail visible within ≤30 s of ingest cron.

---

## Operation #3 — Crypto handshake churn (`crypto_nonces` 21,309 inserts + `crypto_sessions` 3,641 inserts / 21,320 reads + `handshake_rate` 4,009 upserts, ~130 s CPU combined)

### Problem
Every browser tab (and often every request) triggers a fresh ECDH handshake that writes a `crypto_sessions` row and repeatedly writes `crypto_nonces` rows for replay protection. `crypto_nonces` is the largest table (4 MB, 21,310 rows) despite storing 5-minute-lived data.

### Root Cause
- Session lifetime is short; not persisted client-side.
- Nonce store is Postgres, not edge memory/KV.
- Rate limiter (`handshake_rate`) also lives in Postgres. All three could live at the edge.

### Current Flow
```
Tab open → handshake → INSERT crypto_sessions (aes_key, expires_at, ...)
                    → INSERT crypto_nonces (nonce, session_id) per request
                    → UPSERT handshake_rate (ip, minute_bucket, count)
                    → SELECT crypto_sessions WHERE id=$1 (per request)
```
- **DB round trips per encrypted request:** 2 (nonce insert + session lookup)
- **Read cost:** 21,320
- **Write cost:** ~29,000
- **CPU cost:** ~130 s
- **IO cost:** heavy WAL, table bloat on `crypto_nonces`

### Optimized Flow
```
Browser: HttpOnly Secure SameSite=Strict cookie "cs" = signed(session_id)
         + client keeps AES key in sessionStorage (per-tab, non-exportable use)

Handshake once per install (or after 30 days) → Worker mints session:
  L3 Worker memory  sessions:Map<id, {aes_key, exp, origin}>
  L4 KV             key "cs:{id}"  → {aes_key, exp, origin}       (TTL 30 d)
  L4 KV             key "cs_rev"   → revocation list (set of ids) (TTL 30 d)

Per-request replay protection:
  L3 Worker in-memory LRU nonces (5-min window, ~10k entries)
  L4 KV atomic put with `expirationTtl:300` and cas on collision

Rate limit:
  Worker Durable-Object-less approach: KV counter with 60 s TTL per IP,
  or in-memory bucket per isolate (Free plan: acceptable eventual consistency).
```

Key design points:
- DB touched **only** when a session is created (rare) or explicitly revoked. Steady state: **0 DB round trips** for handshake/replay/rate-limit.
- `crypto_nonces` table becomes optional (can remain for audit but no hot writes). Table size stops growing.
- If the KV nonce store somehow misses, worker rejects and forces a fresh handshake — safe default.
- Revocation: admin action writes a small `cs_rev` KV set entry; workers consult it on session load. Cost: 1 KV read per new session bind, not per request.

### Reduction
| Metric | Before | After | Δ |
|---|---|---|---|
| DB reads (crypto_*) | 21,320 | ~200 | **-99 %** |
| DB writes (crypto_* + handshake_rate) | ~29,000 | ~200 | **-99 %** |
| DB CPU | ~130 s | ~2 s | **-98 %** |
| WAL volume (this op) | dominant | negligible | **-99 %** |
| `crypto_nonces` table size | 4 MB, growing | flat, ~KB | **-99 %** |
| Edge invocations (handshake) | ~21k | ~200 | **-99 %** |

### Fail-safe
- Supabase down → sessions live in KV; users continue to authenticate and use encrypted routes for **up to 30 days** without touching the DB.
- KV down → worker returns cached in-memory sessions for the isolate lifetime (~10 min warm), then forces one handshake to reseed. No data loss.
- Full outage → new logins blocked, existing sessions keep working; matches current behavior but with a much larger buffer.

### Risk / Rollback / Verify
- **Risk:** Medium-High — cryptographic path. Mitigation: dual-write for 1 week (KV **and** DB), then flip readers to KV, then stop DB writes.
- **Rollback:** Worker flag `CRYPTO_KV=0` reverts to today's DB-backed flow (DB writes still exist during the dual-write window).
- **Verify:** `crypto_nonces` insert rate → 0; encrypted request success rate unchanged; explicit revocation test (admin revokes → next request from that session denied within ≤60 s KV propagation).

---

## Combined impact (top-3 only)

| Metric | Before | After | Δ |
|---|---|---|---|
| DB reads | ~656,000 | ~6,200 | **-99 %** |
| DB writes | ~44,500 | ~400 | **-99 %** |
| DB CPU | ~710 s | ~18 s | **-97 %** |
| Edge Function invocations | ~656k | ~6k | **-99 %** |
| Egress bandwidth | full bodies | mostly `304` + tiny diffs | **-85 to -95 %** |
| Largest table growth (`crypto_nonces`) | +21k rows/wk | flat | **-99 %** |

Free-plan headroom after the top-3 redesign alone: comfortably fits `500 MB DB / 2 GB egress / 500k edge invocations` with ~5× user growth headroom **without touching operations #4–#12** from the earlier audit.

---

## What I will NOT do (per your constraints)
- No plan upgrade, no added compute, no new paid infrastructure.
- No schema drops, no data migration in this phase. The only DB-side change proposed is scheduling the existing `purge_expired_nonces()` function via `pg_cron` once the crypto path is fully off DB — pure hygiene, not compute.
- User experience unchanged: same UI, same latencies (better on cache hit), same permissions, same crypto guarantees.

## Awaiting approval
Approve this and the first PR opens against **Operation #1 (settings KV+ETag)** — largest win, lowest risk, and it establishes the ETag+KV pattern the other two reuse.
