DROP POLICY IF EXISTS nftoken_links_owner_read ON public.nftoken_links;
CREATE POLICY nftoken_links_owner_read ON public.nftoken_links
FOR SELECT TO authenticated
USING (auth.uid() = user_id);