REVOKE ALL ON FUNCTION public.purge_expired_crypto_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_crypto_sessions() TO service_role;