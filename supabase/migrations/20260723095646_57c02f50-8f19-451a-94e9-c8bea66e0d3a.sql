
REVOKE ALL ON FUNCTION public.prune_audit_logs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_audit_logs() TO service_role;
