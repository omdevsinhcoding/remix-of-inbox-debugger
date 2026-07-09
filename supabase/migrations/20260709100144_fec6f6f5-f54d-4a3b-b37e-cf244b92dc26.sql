-- 1) Allow free profiles to skip username / password entirely
ALTER TABLE public.app_users ALTER COLUMN username DROP NOT NULL;
ALTER TABLE public.app_users ALTER COLUMN password DROP NOT NULL;

-- 2) Seed app_settings with new keys if missing
INSERT INTO public.app_settings (key, value)
VALUES ('location_policy', jsonb_build_object('required', true))
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_settings (key, value)
VALUES ('free_session_minutes', jsonb_build_object('minutes', 10))
ON CONFLICT (key) DO NOTHING;
