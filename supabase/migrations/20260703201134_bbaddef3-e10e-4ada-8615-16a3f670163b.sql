ALTER TABLE public.app_sessions
  ADD COLUMN IF NOT EXISTS refresh_token_hash text,
  ADD COLUMN IF NOT EXISTS refresh_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS family_id uuid,
  ADD COLUMN IF NOT EXISTS parent_session_id uuid,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_sessions_refresh_hash
  ON public.app_sessions(refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_sessions_family ON public.app_sessions(family_id);