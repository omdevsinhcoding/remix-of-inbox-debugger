# Free-Plan Architecture Notes

## Previous failure mode
- `sync-netflix-emails` pg_cron ran **every minute**. Each tick spawned a fresh
  Deno isolate; in-memory throttles (`__legacyBackfillDone`,
  `__lastStaleCleanupAt`) reset every ~15 s, so the "one-shot per isolate"
  guards did nothing.
- Every tick therefore performed:
  - a full-table `UPDATE cached_emails SET account_label='Primary' WHERE account_label IS NULL` (seq scan),
  - an unbounded `SELECT id FROM cached_emails LIMIT 5000` (dedup),
  - an inline `DELETE FROM cached_emails WHERE date < cutoff` (WAL heavy).
- `app_settings.value` was re-queried on every code path (~488 k reads / day).
- `cached_emails` was in `supabase_realtime` publication without any client
  subscribers, so every INSERT/UPDATE paid logical-decoding WAL cost.
- Three overlapping indexes on `cached_emails` (`cached_emails_date_idx`,
  `idx_cached_emails_date`, `cached_emails_cached_at_idx`) added pure write
  amplification.
- `count:'exact'` on the admin dashboard forced an index-only scan on every mount.

## New control flow
- Cron cadence **1 min → 3 min** for `sync-netflix-emails`.
- New `public.sync_state` table + `acquire_sync_lock()` /
  `release_sync_lock()` SECURITY DEFINER helpers give us a **DB-durable
  lease** that survives isolate restarts. Overlapping ticks acquire → miss →
  exit in one RPC call.
- Legacy label backfill is now bounded to `BACKFILL_BATCH_SIZE=500` rows per
  run, gated by its own lease, and driven by a partial index
  (`idx_cached_emails_null_label`) so it is index-only. Drains organically.
- Dedup fetch is keyset-bounded (`ORDER BY date DESC, id DESC LIMIT 2000`,
  `WHERE destroyed=false AND date >= cutoff`) using
  `idx_cached_emails_date_id_desc` — no OFFSET, no full scan.
- Inline stale cleanup fires **at most once per 6 h** per isolate; retention
  cron is authoritative.
- Admin dashboard counts switched from `count:'exact'` to `count:'planned'`
  (uses `pg_class.reltuples` — O(1)); autovacuum tuned to keep it accurate.
- Per-invocation 30 s in-memory settings cache with write-through invalidation
  in `supabase/functions/_shared/settingsCache.ts`.
- `app_sessions.last_seen_at` heartbeat throttled to 60 s / session.
- Realtime publication no longer includes `cached_emails`.
- Every log-style table has a daily/hourly retention cron and matching timestamp
  index so the DELETEs are cheap index-range scans.

## Why this is safe on Free plan
- **Disk IO**: heavy scans (backfill, dedup, count) turned into either
  bounded index reads or O(1) planner lookups.
- **WAL**: dropped realtime replication for `cached_emails`; heartbeat and
  cleanup writes are debounced.
- **Egress**: list responses drop the `html` column; only fetched on demand.
- **Edge invocations**: settings cache + Cloudflare KV cache upstream already
  collapse repeated reads; cron cadence 1/3× cuts function invocations by 66 %.
- **Correctness never depends on isolate memory**: locks + retention live in
  Postgres.

## Rollback
Every change is reversible:
- Cron cadence: `SELECT cron.unschedule('sync-netflix-emails'); SELECT cron.schedule('sync-netflix-emails','*/1 * * * *', <same command>);`
- Drop new artefacts: `DROP TABLE public.sync_state CASCADE; DROP INDEX idx_cached_emails_null_label, idx_cached_emails_date_id_desc;`
- Re-add realtime: `ALTER PUBLICATION supabase_realtime ADD TABLE public.cached_emails;`
- Restore dropped indexes: `CREATE INDEX cached_emails_date_idx ON public.cached_emails (account_label, date DESC); CREATE INDEX idx_cached_emails_date ON public.cached_emails (date); CREATE INDEX cached_emails_cached_at_idx ON public.cached_emails (cached_at);`

## Validation checklist
1. `SELECT pg_stat_statements_reset();` (baseline reset).
2. Wait ~15 min of production traffic.
3. Run every block in `docs/observability.sql`.
4. Expect:
   - `cached_emails` top query is gone from top-15 offenders.
   - `pg_stat_user_tables.cached_emails.seq_tup_read` growth ≪ before.
   - `sync_state.email-sync.status='idle'` most of the time; `locked_until IS NULL`.
   - `cron.job_run_details` shows `sync-netflix-emails` runs every 3 min, status `succeeded`.
   - `idx_cached_emails_null_label` size shrinks over hours as backfill drains.
5. Run the three `EXPLAIN ANALYZE` blocks in section 8 — all should be
   `Index Only Scan` or `Index Scan`, never `Seq Scan`.

## Constants (edit in `supabase/functions/fetch-emails/index.ts`)
- `SYNC_LOCK_LEASE_SECONDS = 120`
- `BACKFILL_LOCK_LEASE_SECONDS = 60`
- `BACKFILL_BATCH_SIZE = 500`
- `STALE_CLEANUP_MIN_INTERVAL_MS = 6 * 60 * 60_000`
- `DEDUP_ID_LIMIT = 2000`
- session heartbeat throttle: `SESSION_TOUCH_MIN_INTERVAL_MS` in `supabase/functions/_shared/settingsCache.ts` (60 s).
