REVOKE ALL ON FUNCTION public.expire_stale_tv_login_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_tv_login_events() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_tv_login_events() FROM authenticated;

REVOKE ALL ON FUNCTION public.schedule_tv_login_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.schedule_tv_login_cleanup() FROM anon;
REVOKE ALL ON FUNCTION public.schedule_tv_login_cleanup() FROM authenticated;