DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'security_events'
      AND p.polname = 'Service role can manage security events'
  ) THEN
    CREATE POLICY "Service role can manage security events"
      ON public.security_events
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;