
REVOKE ALL ON FUNCTION public.schedule_email_cleanup(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unschedule_email_cleanup() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_email_cleanup_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_email_cleanup(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.unschedule_email_cleanup() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_email_cleanup_status() TO service_role;
