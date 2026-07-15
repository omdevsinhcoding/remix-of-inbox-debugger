ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS auto_delete boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.purge_expired_free_profiles()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.app_users
     WHERE is_free = true
       AND auto_delete = true
       AND expires_at IS NOT NULL
       AND expires_at < now()
     RETURNING id
  )
  SELECT count(*) INTO n FROM gone;
  RETURN n;
END;
$function$;