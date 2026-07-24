ALTER TABLE public.app_users
ADD COLUMN IF NOT EXISTS profile_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.app_users.profile_prefs IS 'Per-user viewer preferences such as selected avatar and hidden email markers.';