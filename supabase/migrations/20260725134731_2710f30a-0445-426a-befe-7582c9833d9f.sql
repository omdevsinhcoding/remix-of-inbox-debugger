CREATE OR REPLACE FUNCTION public.expire_stale_tv_login_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n integer := 0;
BEGIN
  UPDATE public.tv_login_events
     SET status = 'error',
         result = 'runner_timeout',
         message = CASE
           WHEN status = 'queued' THEN 'TV sign-in took too long to start. Please try a fresh TV code.'
           ELSE 'TV sign-in took too long to finish. Please try a fresh TV code.'
         END,
         finished_at = COALESCE(finished_at, now()),
         updated_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'autoExpiredAt', now(),
           'autoExpireReason', 'stale_tv_runner'
         )
   WHERE status IN ('queued', 'running', 'in_progress', 'verifying', 'checking')
     AND created_at < now() - interval '10 minutes';

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.schedule_tv_login_cleanup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  BEGIN
    PERFORM cron.unschedule('tv-login-cleanup');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM cron.schedule(
    'tv-login-cleanup',
    '* * * * *',
    'SELECT public.expire_stale_tv_login_events();'
  );
END;
$function$;

SELECT public.schedule_tv_login_cleanup();