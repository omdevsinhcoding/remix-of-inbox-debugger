ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS is_free boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order integer;
CREATE INDEX IF NOT EXISTS app_users_display_order_idx
  ON public.app_users (pinned DESC, sort_order ASC NULLS LAST, created_at ASC);