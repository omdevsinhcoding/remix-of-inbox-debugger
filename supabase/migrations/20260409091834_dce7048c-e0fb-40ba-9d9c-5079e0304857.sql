
-- Function to schedule email sync cron job
CREATE OR REPLACE FUNCTION public.schedule_email_sync(
  cron_expr text,
  function_url text,
  auth_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM cron.schedule(
    'sync-netflix-emails',
    cron_expr,
    format(
      $cron$
      SELECT net.http_post(
        url := %L,
        headers := %L::jsonb,
        body := '{"mode":"sync","source":"cron"}'::jsonb
      ) AS request_id;
      $cron$,
      function_url,
      json_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || auth_key
      )::text
    )
  );
END;
$$;

-- Function to unschedule email sync cron job
CREATE OR REPLACE FUNCTION public.unschedule_email_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM cron.unschedule('sync-netflix-emails');
EXCEPTION WHEN OTHERS THEN
  -- Job doesn't exist, ignore
  NULL;
END;
$$;

-- Function to get cron status
CREATE OR REPLACE FUNCTION public.get_cron_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  job_exists boolean;
  job_schedule text;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM cron.job WHERE jobname = 'sync-netflix-emails'
  ) INTO job_exists;

  IF job_exists THEN
    SELECT schedule INTO job_schedule FROM cron.job WHERE jobname = 'sync-netflix-emails';
  END IF;

  SELECT jsonb_build_object(
    'active', job_exists,
    'schedule', COALESCE(job_schedule, ''),
    'interval', CASE
      WHEN job_schedule LIKE '*/1 %' THEN 1
      WHEN job_schedule LIKE '*/3 %' THEN 3
      WHEN job_schedule LIKE '*/5 %' THEN 5
      WHEN job_schedule LIKE '*/10 %' THEN 10
      ELSE 3
    END
  ) INTO result;

  RETURN result;
END;
$$;
