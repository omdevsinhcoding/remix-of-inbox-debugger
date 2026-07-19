
-- Harden search_path (adds pg_temp isolation on top of existing public search_path)
ALTER FUNCTION public.get_cron_status()                          SET search_path = public, pg_temp;
ALTER FUNCTION public.get_email_cleanup_status()                 SET search_path = public, pg_temp;
ALTER FUNCTION public.schedule_email_cleanup(integer, integer)   SET search_path = public, pg_temp;
ALTER FUNCTION public.schedule_email_sync(text, text, text)      SET search_path = public, pg_temp;
ALTER FUNCTION public.unschedule_email_cleanup()                 SET search_path = public, pg_temp;
ALTER FUNCTION public.unschedule_email_sync()                    SET search_path = public, pg_temp;
ALTER FUNCTION public.purge_expired_crypto_sessions()            SET search_path = public, pg_temp;
ALTER FUNCTION public.purge_expired_nonces()                     SET search_path = public, pg_temp;

-- Restrict EXECUTE to service_role only. All 8 are invoked from edge functions via
-- the service_role client — locking them here removes the default PUBLIC/anon/
-- authenticated access without changing runtime behavior.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.get_cron_status()',
    'public.get_email_cleanup_status()',
    'public.schedule_email_cleanup(integer, integer)',
    'public.schedule_email_sync(text, text, text)',
    'public.unschedule_email_cleanup()',
    'public.unschedule_email_sync()',
    'public.purge_expired_crypto_sessions()',
    'public.purge_expired_nonces()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
