DROP POLICY "Anyone can read user profiles" ON public.app_users;
DROP POLICY "Anyone can read cached emails" ON public.cached_emails;

CREATE POLICY "Service role only app_users"
  ON public.app_users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);