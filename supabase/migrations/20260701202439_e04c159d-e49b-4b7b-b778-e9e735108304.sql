
REVOKE EXECUTE ON FUNCTION public.schedule_email_sync(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.unschedule_email_sync() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_cron_status() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.schedule_email_sync(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.unschedule_email_sync() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_cron_status() TO service_role;
