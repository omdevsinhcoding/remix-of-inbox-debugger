DO $$
DECLARE
  target_job_id bigint;
BEGIN
  FOR target_job_id IN
    SELECT jobid FROM cron.job WHERE jobname = 'sync-netflix-emails'
  LOOP
    PERFORM cron.unschedule(target_job_id);
  END LOOP;
END
$$;