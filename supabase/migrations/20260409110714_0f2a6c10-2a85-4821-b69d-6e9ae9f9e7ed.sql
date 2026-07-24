-- 1. Remove public SELECT policy on app_settings (exposes IMAP creds & reCAPTCHA keys)
DROP POLICY IF EXISTS "Anyone can read settings" ON public.app_settings;

-- 2. Fix audit_logs: remove overly permissive ALL policy, add service-role-only policy
DROP POLICY IF EXISTS "Service can manage audit logs" ON public.audit_logs;

-- Create restrictive policy: only service_role can access audit_logs
-- (Edge functions use service_role key, so they can still write)
CREATE POLICY "Service role only"
  ON public.audit_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 3. Fix cached_emails: replace overly permissive ALL policy
DROP POLICY IF EXISTS "Service role can insert/update cached emails" ON public.cached_emails;

CREATE POLICY "Service role can manage cached emails"
  ON public.cached_emails
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);