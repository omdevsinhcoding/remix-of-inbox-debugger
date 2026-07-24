DROP POLICY IF EXISTS translations_read_authed ON public.notification_translations;
REVOKE SELECT ON public.notification_translations FROM authenticated;
CREATE POLICY translations_service_only ON public.notification_translations FOR ALL TO service_role USING (true) WITH CHECK (true);