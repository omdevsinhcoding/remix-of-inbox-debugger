CREATE POLICY "Service role only notifications"
  ON public.notifications
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role only notification_reads"
  ON public.notification_reads
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);