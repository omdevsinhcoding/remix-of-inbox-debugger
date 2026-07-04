
-- =========================================
-- 1. EXTEND public.notifications
-- =========================================
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS image_key text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'announcement',
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS icon text,
  ADD COLUMN IF NOT EXISTS action_url text,
  ADD COLUMN IF NOT EXISTS action_label text,
  ADD COLUMN IF NOT EXISTS action2_url text,
  ADD COLUMN IF NOT EXISTS action2_label text,
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS publish_at timestamptz,
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS group_key text,
  ADD COLUMN IF NOT EXISTS created_by uuid;

-- Uniqueness on dedupe_key when supplied
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_uidx
  ON public.notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_publish_at_idx ON public.notifications (publish_at);
CREATE INDEX IF NOT EXISTS notifications_pinned_idx    ON public.notifications (pinned);
CREATE INDEX IF NOT EXISTS notifications_category_idx  ON public.notifications (category);
CREATE INDEX IF NOT EXISTS notifications_priority_idx  ON public.notifications (priority);

-- =========================================
-- 2. EXTEND public.notification_reads
-- =========================================
ALTER TABLE public.notification_reads
  ADD COLUMN IF NOT EXISTS seen_at        timestamptz,
  ADD COLUMN IF NOT EXISTS read_at        timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at    timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_until  timestamptz;

CREATE INDEX IF NOT EXISTS notification_reads_user_idx ON public.notification_reads (user_id);
CREATE INDEX IF NOT EXISTS notification_reads_notif_idx ON public.notification_reads (notification_id);

-- =========================================
-- 3. NEW public.notification_prefs
-- =========================================
CREATE TABLE IF NOT EXISTS public.notification_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  category text NOT NULL DEFAULT 'all',
  in_app_enabled boolean NOT NULL DEFAULT true,
  push_enabled  boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start time,
  quiet_hours_end   time,
  quiet_tz text DEFAULT 'UTC',
  digest_frequency text NOT NULL DEFAULT 'off',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, category)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_prefs TO authenticated;
GRANT ALL ON public.notification_prefs TO service_role;

ALTER TABLE public.notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prefs: own row select" ON public.notification_prefs;
CREATE POLICY "prefs: own row select" ON public.notification_prefs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "prefs: own row upsert" ON public.notification_prefs;
CREATE POLICY "prefs: own row upsert" ON public.notification_prefs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "prefs: own row update" ON public.notification_prefs;
CREATE POLICY "prefs: own row update" ON public.notification_prefs
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "prefs: own row delete" ON public.notification_prefs;
CREATE POLICY "prefs: own row delete" ON public.notification_prefs
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- =========================================
-- 4. NEW public.push_subscriptions
-- =========================================
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  ua text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "push: own rows" ON public.push_subscriptions;
CREATE POLICY "push: own rows" ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON public.push_subscriptions (user_id);

-- =========================================
-- 5. NEW public.notification_events (analytics funnel)
-- =========================================
CREATE TABLE IF NOT EXISTS public.notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event text NOT NULL, -- delivered|seen|read|clicked|dismissed|snoozed|archived
  at timestamptz NOT NULL DEFAULT now(),
  meta jsonb
);

GRANT SELECT, INSERT ON public.notification_events TO authenticated;
GRANT ALL ON public.notification_events TO service_role;

ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "events: insert own" ON public.notification_events;
CREATE POLICY "events: insert own" ON public.notification_events
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "events: select own" ON public.notification_events;
CREATE POLICY "events: select own" ON public.notification_events
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS notification_events_notif_event_idx
  ON public.notification_events (notification_id, event);
CREATE INDEX IF NOT EXISTS notification_events_user_idx
  ON public.notification_events (user_id);

-- =========================================
-- 6. Realtime publication for notifications
-- =========================================
DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications';
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- =========================================
-- 7. updated_at trigger for notification_prefs
-- =========================================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notification_prefs_updated_at ON public.notification_prefs;
CREATE TRIGGER trg_notification_prefs_updated_at
  BEFORE UPDATE ON public.notification_prefs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
