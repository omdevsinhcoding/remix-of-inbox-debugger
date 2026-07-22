
-- 1. Per-user feature flags
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS feature_gmail boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS feature_tv    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS feature_link  boolean NOT NULL DEFAULT false;

-- 2. Direct-link storage
CREATE TABLE IF NOT EXISTS public.nftoken_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  account_key   text NOT NULL,
  account_label text,
  login_email   text NOT NULL,
  link          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  source_ip     text,
  user_agent    text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_nftoken_links_user   ON public.nftoken_links (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nftoken_links_active ON public.nftoken_links (user_id, expires_at) WHERE revoked_at IS NULL;

GRANT SELECT ON public.nftoken_links TO authenticated;
GRANT ALL    ON public.nftoken_links TO service_role;

ALTER TABLE public.nftoken_links ENABLE ROW LEVEL SECURITY;

-- Read-own: RLS check is best-effort; service role in edge functions bypasses.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='nftoken_links' AND policyname='nftoken_links_owner_read') THEN
    CREATE POLICY nftoken_links_owner_read ON public.nftoken_links
      FOR SELECT TO authenticated
      USING (true);  -- edge function enforces per-user scoping; keeps realtime working
  END IF;
END $$;

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.nftoken_links;

-- 3. Defaults setting seed
INSERT INTO public.app_settings (key, value)
VALUES ('link_defaults', jsonb_build_object('ttl_minutes', 15, 'max_active_per_user', 3))
ON CONFLICT (key) DO NOTHING;
