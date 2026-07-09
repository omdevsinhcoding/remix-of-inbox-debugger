REVOKE ALL ON FUNCTION public.enforce_free_profile_expiry() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_expired_free_profiles() FROM PUBLIC, anon, authenticated;