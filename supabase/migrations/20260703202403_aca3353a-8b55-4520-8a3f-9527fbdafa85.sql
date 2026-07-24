-- D.3: append-only enforcement. Even service_role (edge functions) can only INSERT.
CREATE OR REPLACE FUNCTION public.audit_logs_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (%.% blocked)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON public.audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_immutable();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON public.audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_immutable();

-- Enrich schema for D.3 forensics (all nullable — existing inserts keep working).
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS result text;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_ts ON public.audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_ts ON public.audit_logs(actor_id, created_at DESC);