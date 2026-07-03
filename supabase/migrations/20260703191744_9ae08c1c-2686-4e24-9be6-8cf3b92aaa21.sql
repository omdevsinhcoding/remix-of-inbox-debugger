
-- 1) Tighten notification_impressions: only owner can read; edge functions use service_role and bypass RLS.
DROP POLICY IF EXISTS impressions_read ON public.notification_impressions;
CREATE POLICY impressions_read_own ON public.notification_impressions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- 2) Tighten notification_translations: reference data, but restrict from anon.
DROP POLICY IF EXISTS translations_read ON public.notification_translations;
CREATE POLICY translations_read_authed ON public.notification_translations
  FOR SELECT TO authenticated
  USING (true);
REVOKE SELECT ON public.notification_translations FROM anon;

-- 3) Security events log (append-only, service_role only).
CREATE TABLE IF NOT EXISTS public.security_events (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  uid uuid,
  ip inet,
  ua text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_ts_idx ON public.security_events (ts DESC);
CREATE INDEX IF NOT EXISTS security_events_type_idx ON public.security_events (type);
REVOKE ALL ON public.security_events FROM PUBLIC, anon, authenticated;
GRANT INSERT, SELECT ON public.security_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.security_events_id_seq TO service_role;
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated ⇒ zero client access; service_role bypasses RLS.

-- 4) Feature flag for strict-encryption mode (default: strict).
INSERT INTO public.app_settings(key, value)
  VALUES ('security_mode', '"v2_strict"'::jsonb)
  ON CONFLICT (key) DO NOTHING;
