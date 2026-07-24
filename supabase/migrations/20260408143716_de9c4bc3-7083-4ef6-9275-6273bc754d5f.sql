
-- Add assigned_accounts to app_users
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS assigned_accounts jsonb DEFAULT NULL;

-- Create audit_logs table
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  actor_id uuid,
  target_id uuid,
  details jsonb DEFAULT '{}'::jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service can manage audit logs" ON public.audit_logs FOR ALL USING (true) WITH CHECK (true);
