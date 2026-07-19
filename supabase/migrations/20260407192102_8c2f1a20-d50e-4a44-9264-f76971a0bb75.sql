
ALTER TABLE public.app_users ADD COLUMN must_change_password boolean NOT NULL DEFAULT true;

-- Existing users should NOT be forced to change
UPDATE public.app_users SET must_change_password = false;
