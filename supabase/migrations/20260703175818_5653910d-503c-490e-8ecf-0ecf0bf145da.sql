
CREATE OR REPLACE FUNCTION public.unschedule_email_cleanup()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM cron.unschedule('email-cleanup');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.schedule_email_cleanup(days integer, hour integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d integer := GREATEST(1, COALESCE(days, 30));
  h integer := GREATEST(0, LEAST(23, COALESCE(hour, 3)));
BEGIN
  PERFORM public.unschedule_email_cleanup();
  PERFORM cron.schedule(
    'email-cleanup',
    format('0 %s * * *', h),
    format('DELETE FROM public.cached_emails WHERE date < now() - interval ''%s days''', d)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_email_cleanup_status()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  job_exists boolean;
  job_schedule text;
  job_command text;
BEGIN
  SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname = 'email-cleanup') INTO job_exists;
  IF job_exists THEN
    SELECT schedule, command INTO job_schedule, job_command FROM cron.job WHERE jobname = 'email-cleanup';
  END IF;
  RETURN jsonb_build_object(
    'active', job_exists,
    'schedule', COALESCE(job_schedule, ''),
    'command', COALESCE(job_command, '')
  );
END;
$$;
