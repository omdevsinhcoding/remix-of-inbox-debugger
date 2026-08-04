CREATE POLICY "No client access to sync state"
ON public.sync_state
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);