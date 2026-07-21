
ALTER TABLE public.tv_login_events
  ADD COLUMN IF NOT EXISTS message text,
  ADD COLUMN IF NOT EXISTS result text,
  ADD COLUMN IF NOT EXISTS screenshot_url text,
  ADD COLUMN IF NOT EXISTS github_run_url text,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_tv_login_events_user_created ON public.tv_login_events (user_id, created_at DESC);
