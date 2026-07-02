UPDATE public.cached_emails SET otp = NULL WHERE otp IS NOT NULL;
ALTER TABLE public.notifications ALTER COLUMN created_by DROP NOT NULL;