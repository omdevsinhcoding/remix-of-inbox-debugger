
-- Add plan date columns to app_users (paid users only)
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS plan_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS plan_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS plan_start_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS plan_last_reminder_at timestamptz;

-- Guard trigger: admins and free users can never have plan dates,
-- and end must be after start when both set.
CREATE OR REPLACE FUNCTION public.enforce_plan_dates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'admin' OR COALESCE(NEW.is_free, false) = true THEN
    NEW.plan_starts_at := NULL;
    NEW.plan_ends_at := NULL;
    NEW.plan_start_notified_at := NULL;
    NEW.plan_last_reminder_at := NULL;
  END IF;
  IF NEW.plan_starts_at IS NOT NULL AND NEW.plan_ends_at IS NOT NULL
     AND NEW.plan_ends_at <= NEW.plan_starts_at THEN
    RAISE EXCEPTION 'plan_ends_at must be after plan_starts_at';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_plan_dates ON public.app_users;
CREATE TRIGGER trg_enforce_plan_dates
  BEFORE INSERT OR UPDATE ON public.app_users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_dates();

-- Safe backfill: existing paid users get plan_starts_at = created_at,
-- plan_ends_at stays NULL (legacy = active, no lockouts).
UPDATE public.app_users
   SET plan_starts_at = created_at
 WHERE is_free = false
   AND role <> 'admin'
   AND plan_starts_at IS NULL;

-- Helpful index for the hourly reminder cron
CREATE INDEX IF NOT EXISTS idx_app_users_plan_ends_at
  ON public.app_users (plan_ends_at)
  WHERE plan_ends_at IS NOT NULL;
