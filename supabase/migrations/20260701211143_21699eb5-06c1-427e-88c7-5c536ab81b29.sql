CREATE TABLE IF NOT EXISTS public.app_admin_2fa_state (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  otp_verified_at timestamp with time zone,
  totp_verified_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.app_admin_2fa_state TO service_role;

ALTER TABLE public.app_admin_2fa_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only admin 2FA state" ON public.app_admin_2fa_state;
CREATE POLICY "Service role only admin 2FA state"
ON public.app_admin_2fa_state
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_app_admin_2fa_state_user_expires
ON public.app_admin_2fa_state(user_id, expires_at);

CREATE OR REPLACE FUNCTION public.schedule_email_sync(cron_expr text, function_url text, auth_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM cron.schedule(
    'sync-netflix-emails',
    cron_expr,
    format(
      $cron$
      SELECT net.http_post(
        url := %L,
        headers := %L::jsonb,
        body := '{"mode":"sync","source":"cron"}'::jsonb
      ) AS request_id;
      $cron$,
      function_url,
      json_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', auth_key
      )::text
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.schedule_email_sync(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_email_sync(text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.unschedule_email_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unschedule_email_sync() TO service_role;
REVOKE ALL ON FUNCTION public.get_cron_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cron_status() TO service_role;