ALTER TABLE public.app_sessions ADD COLUMN IF NOT EXISTS binding_hash text;
CREATE INDEX IF NOT EXISTS idx_app_sessions_binding ON public.app_sessions(binding_hash);