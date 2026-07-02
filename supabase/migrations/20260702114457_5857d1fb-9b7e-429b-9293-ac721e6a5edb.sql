-- Fix custom-auth/RLS mismatch for notification-related tables.
-- This app uses custom HMAC sessions and routes notification actions through
-- the manage-app Edge Function with service_role access, not Supabase Auth.

-- 1) Remove policies that depend on auth.uid(), which is always NULL here.
DROP POLICY IF EXISTS "push: own rows" ON public.push_subscriptions;

DROP POLICY IF EXISTS "prefs: own row select" ON public.notification_prefs;
DROP POLICY IF EXISTS "prefs: own row upsert" ON public.notification_prefs;
DROP POLICY IF EXISTS "prefs: own row update" ON public.notification_prefs;
DROP POLICY IF EXISTS "prefs: own row delete" ON public.notification_prefs;

DROP POLICY IF EXISTS "events: insert own" ON public.notification_events;
DROP POLICY IF EXISTS "events: select own" ON public.notification_events;

DROP POLICY IF EXISTS "Service role only push subscriptions" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Service role only notification prefs" ON public.notification_prefs;
DROP POLICY IF EXISTS "Service role only notification events" ON public.notification_events;
DROP POLICY IF EXISTS "Service role only notifications" ON public.notifications;
DROP POLICY IF EXISTS "Realtime public notification read" ON public.notifications;
DROP POLICY IF EXISTS "Allow all users to view notifications" ON public.notifications;
DROP POLICY IF EXISTS "Allow target users to view notifications" ON public.notifications;

-- 2) Tighten Data API table grants so browser roles cannot access these
-- custom-auth tables directly. Edge Functions use service_role and enforce
-- the application's HMAC session authorization in code.
REVOKE ALL ON public.push_subscriptions FROM anon, authenticated;
REVOKE ALL ON public.notification_prefs FROM anon, authenticated;
REVOKE ALL ON public.notification_events FROM anon, authenticated;
REVOKE ALL ON public.notifications FROM anon, authenticated;

GRANT ALL ON public.push_subscriptions TO service_role;
GRANT ALL ON public.notification_prefs TO service_role;
GRANT ALL ON public.notification_events TO service_role;
GRANT ALL ON public.notifications TO service_role;

-- 3) Keep RLS enabled and explicitly document/enforce service-role-only access.
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only push subscriptions"
  ON public.push_subscriptions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role only notification prefs"
  ON public.notification_prefs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role only notification events"
  ON public.notification_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role only notifications"
  ON public.notifications
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4) The frontend currently reads notifications through manage-app, not
-- Supabase Realtime. Remove direct Realtime publication so there is no
-- non-service-role SELECT policy gap and no accidental public delivery path.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.notifications;
  END IF;
END $$;