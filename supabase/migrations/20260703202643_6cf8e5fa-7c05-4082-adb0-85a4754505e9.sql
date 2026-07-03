CREATE OR REPLACE FUNCTION public.audit_logs_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (%.% blocked)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION public.audit_logs_immutable() FROM PUBLIC, anon, authenticated;