CREATE OR REPLACE FUNCTION public.acquire_sync_lock(_job text, _lease_seconds integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE affected integer; BEGIN
  INSERT INTO public.sync_state (job_name, locked_until, last_run_at, status)
  VALUES (_job, now() + make_interval(secs => _lease_seconds), now(), 'running')
  ON CONFLICT (job_name) DO UPDATE
    SET locked_until = EXCLUDED.locked_until,
        last_run_at  = EXCLUDED.last_run_at,
        status       = 'running'
    WHERE public.sync_state.locked_until IS NULL
       OR public.sync_state.locked_until < now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END; $function$;