-- app_settings: service role only access
CREATE POLICY "Service role only"
  ON public.app_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- app_otps: service role only access
CREATE POLICY "Service role only"
  ON public.app_otps
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);