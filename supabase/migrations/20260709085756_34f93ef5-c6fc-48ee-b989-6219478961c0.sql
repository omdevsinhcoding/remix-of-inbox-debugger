ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS app_users_expires_at_idx
  ON public.app_users (expires_at)
  WHERE expires_at IS NOT NULL;

-- Safety guard: only free profiles may carry an expiry; paid profiles must stay null.
-- Enforced via trigger (CHECK can't reference other columns in cross-row scenarios cleanly here).
CREATE OR REPLACE FUNCTION public.enforce_free_profile_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.expires_at IS NOT NULL AND COALESCE(NEW.is_free, false) = false THEN
    RAISE EXCEPTION 'expires_at can only be set on free profiles';
  END IF;
  IF NEW.is_free = true AND NEW.role = 'admin' THEN
    RAISE EXCEPTION 'admin profiles cannot be marked free';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_free_profile_expiry_trg ON public.app_users;
CREATE TRIGGER enforce_free_profile_expiry_trg
  BEFORE INSERT OR UPDATE ON public.app_users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_free_profile_expiry();

-- Helper the cron job uses. SECURITY DEFINER so the cron role can delete
-- without needing table grants.
CREATE OR REPLACE FUNCTION public.purge_expired_free_profiles()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.app_users
     WHERE is_free = true
       AND expires_at IS NOT NULL
       AND expires_at < now()
     RETURNING id
  )
  SELECT count(*) INTO n FROM gone;
  RETURN n;
END;
$$;