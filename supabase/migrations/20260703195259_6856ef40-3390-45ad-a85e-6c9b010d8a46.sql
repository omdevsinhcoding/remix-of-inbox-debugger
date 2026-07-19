
REVOKE ALL ON FUNCTION public.purge_expired_nonces() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_nonces() TO service_role;
