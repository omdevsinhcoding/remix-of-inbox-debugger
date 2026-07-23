
-- 1) Durable job coordination table -----------------------------------------
CREATE TABLE IF NOT EXISTS public.sync_state (
  job_name         text PRIMARY KEY,
  last_cursor_date timestamptz,
  last_cursor_id   text,
  last_run_at      timestamptz,
  last_success_at  timestamptz,
  locked_until     timestamptz,
  status           text,
  error_count      integer NOT NULL DEFAULT 0,
  meta             jsonb   NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Service role only (edge functions). No anon/auth policies — RLS blocks all.
GRANT ALL ON public.sync_state TO service_role;
ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.update_sync_state_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS sync_state_touch ON public.sync_state;
CREATE TRIGGER sync_state_touch BEFORE UPDATE ON public.sync_state
  FOR EACH ROW EXECUTE FUNCTION public.update_sync_state_updated_at();

-- Atomic lock acquisition. Returns TRUE if caller acquired the lease.
-- Uses a single UPSERT so two concurrent callers can never both win.
CREATE OR REPLACE FUNCTION public.acquire_sync_lock(_job text, _lease_seconds int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ok boolean; BEGIN
  INSERT INTO public.sync_state (job_name, locked_until, last_run_at, status)
  VALUES (_job, now() + make_interval(secs => _lease_seconds), now(), 'running')
  ON CONFLICT (job_name) DO UPDATE
    SET locked_until = EXCLUDED.locked_until,
        last_run_at  = EXCLUDED.last_run_at,
        status       = 'running'
    WHERE public.sync_state.locked_until IS NULL
       OR public.sync_state.locked_until < now();
  GET DIAGNOSTICS ok = ROW_COUNT;
  RETURN ok > 0;
END; $$;
REVOKE ALL ON FUNCTION public.acquire_sync_lock(text,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_sync_lock(text,int) TO service_role;

CREATE OR REPLACE FUNCTION public.release_sync_lock(_job text, _ok boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.sync_state
     SET locked_until    = NULL,
         status          = CASE WHEN _ok THEN 'idle' ELSE 'error' END,
         last_success_at = CASE WHEN _ok THEN now() ELSE last_success_at END,
         error_count     = CASE WHEN _ok THEN 0 ELSE error_count + 1 END
   WHERE job_name = _job;
$$;
REVOKE ALL ON FUNCTION public.release_sync_lock(text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_sync_lock(text,boolean) TO service_role;

-- 2) Indexes matching the new query patterns --------------------------------

-- Partial index for the bounded legacy backfill (WHERE account_label IS NULL).
-- Once backfill drains, this index shrinks to near-zero. Tiny write overhead
-- because the predicate is almost always false on new rows (default 'Primary').
CREATE INDEX IF NOT EXISTS idx_cached_emails_null_label
  ON public.cached_emails (id)
  WHERE account_label IS NULL;

-- Keyset composite for incremental "rows after (date, id)" pagination.
CREATE INDEX IF NOT EXISTS idx_cached_emails_date_id_desc
  ON public.cached_emails (date DESC, id DESC)
  WHERE destroyed = false;

-- 3) Prune redundant/near-dead indexes --------------------------------------
-- Duplicate of cached_emails_account_label_date_desc_idx (same columns).
DROP INDEX IF EXISTS public.cached_emails_date_idx;
-- Duplicate of cached_emails_date_desc_idx.
DROP INDEX IF EXISTS public.idx_cached_emails_date;
-- Barely used (6 scans historic), cached_at not used in any hot path.
DROP INDEX IF EXISTS public.cached_emails_cached_at_idx;

-- 4) Remove cached_emails from realtime publication -------------------------
-- Every INSERT/UPDATE was replicated through the logical decoder even though
-- no client subscribes to this table (verified — no client-side supabase
-- .from("cached_emails") in the codebase). Dropping it removes the WAL + IO
-- overhead on every sync tick.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname='public' AND tablename='cached_emails'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.cached_emails;
  END IF;
END $$;

-- 5) Slow the hot cron from 1 min → 3 min -----------------------------------
-- Keeps user-perceived freshness (Netflix TV codes/OTPs arrive in <30s of
-- request anyway thanks to on-demand refresh from the client). Cron is
-- the safety net, not the primary path.
DO $$
DECLARE cur record; new_cmd text; BEGIN
  SELECT command INTO cur FROM cron.job WHERE jobname='sync-netflix-emails';
  IF FOUND THEN
    PERFORM cron.unschedule('sync-netflix-emails');
    PERFORM cron.schedule('sync-netflix-emails', '*/3 * * * *', cur.command);
  END IF;
END $$;

-- 6) Seed the sync_state row so first run is clean --------------------------
INSERT INTO public.sync_state (job_name, status)
VALUES ('email-sync', 'idle'), ('legacy-label-backfill', 'idle')
ON CONFLICT (job_name) DO NOTHING;

ANALYZE public.cached_emails;
