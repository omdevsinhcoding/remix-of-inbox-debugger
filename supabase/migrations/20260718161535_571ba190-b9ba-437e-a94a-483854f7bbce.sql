ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS tv_override text;
DO $$ BEGIN
  ALTER TABLE public.app_users ADD CONSTRAINT app_users_tv_override_check CHECK (tv_override IN ('on','off'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;