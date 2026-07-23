-- =============================================================================
-- Supabase Free-Plan health snapshot. Run any block ad-hoc in the SQL editor.
-- Baseline → deploy → workload → re-run → diff. All queries are read-only.
-- =============================================================================

-- 1) Top 15 offenders by total time (pg_stat_statements is cumulative — reset
--    with `SELECT pg_stat_statements_reset()` right before a workload test).
SELECT calls, round(total_exec_time::numeric,0) AS total_ms,
       round(mean_exec_time::numeric,2) AS mean_ms,
       round((100*total_exec_time/sum(total_exec_time) OVER ())::numeric,1) AS pct,
       left(regexp_replace(query,'\s+',' ','g'),140) AS query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname=current_database())
ORDER BY total_exec_time DESC LIMIT 15;

-- 2) Table sizes + row counts (hot tables should stay small).
SELECT c.relname AS table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid))       AS heap,
       s.n_live_tup AS rows, s.n_dead_tup AS dead
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
WHERE n.nspname='public' AND c.relkind='r'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 20;

-- 3) Seq scan vs index scan ratio — any hot table with seq_scan >> idx_scan
--    is a missing-index or unbounded-read smell.
SELECT relname, seq_scan, seq_tup_read, idx_scan,
       n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del,
       n_live_tup AS rows
FROM pg_stat_user_tables WHERE schemaname='public'
ORDER BY seq_tup_read DESC NULLS LAST LIMIT 15;

-- 4) Index usage — 0-scan indexes are pure write tax.
SELECT s.relname AS table_name, s.indexrelname AS index_name,
       s.idx_scan, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s WHERE s.schemaname='public'
ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC LIMIT 30;

-- 5) Cron jobs — every schedule that costs IO. Duplicates or */1 cadences here
--    are red flags.
SELECT jobname, schedule, active, left(command,80) AS command
FROM cron.job ORDER BY jobname;

-- 6) Recent cron runs — was the retention/sync job actually running?
SELECT j.jobname, r.start_time, r.status, r.return_message
FROM cron.job_run_details r JOIN cron.job j ON j.jobid=r.jobid
WHERE r.start_time > now() - interval '24 hours'
ORDER BY r.start_time DESC LIMIT 30;

-- 7) Sync-state health — is any job stuck holding a stale lease?
SELECT job_name, status, last_run_at, last_success_at, locked_until,
       error_count, updated_at
FROM public.sync_state ORDER BY job_name;

-- 8) EXPLAIN ANALYZE the rewritten hot paths (paste actual runtime values).
--    a) dedup keyset scan used by fetch-emails:
-- EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM public.cached_emails
--   WHERE destroyed=false AND date >= now() - interval '60 days'
--   ORDER BY date DESC, id DESC LIMIT 2000;
--    b) bounded backfill:
-- EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM public.cached_emails
--   WHERE account_label IS NULL LIMIT 500;
--    c) inbox list (account-scoped keyset):
-- EXPLAIN (ANALYZE, BUFFERS) SELECT id, subject, from_address, date, account_label
--   FROM public.cached_emails
--   WHERE destroyed=false AND account_label = ANY(ARRAY['Primary'])
--   ORDER BY date DESC LIMIT 200;

-- 9) Realtime publication membership — anything here pays WAL logical-decoding
--    cost on every insert/update. Keep it minimal.
SELECT schemaname, tablename FROM pg_publication_tables
WHERE pubname='supabase_realtime' ORDER BY tablename;

-- 10) DB size + WAL — canary for approaching Free-Plan ceiling (500 MB db).
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
