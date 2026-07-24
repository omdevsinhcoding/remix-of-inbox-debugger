
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS feature_gmail boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS feature_tv    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS feature_link  boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.nftoken_links (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  account_key text NOT NULL,
  login_email text NOT NULL,
  link_url text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.nftoken_links TO service_role;

ALTER TABLE public.nftoken_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "nftoken_links_service_only" ON public.nftoken_links;
CREATE POLICY "nftoken_links_service_only" ON public.nftoken_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS nftoken_links_user_idx ON public.nftoken_links(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS nftoken_links_exp_idx ON public.nftoken_links(expires_at);

DROP TRIGGER IF EXISTS nftoken_links_touch ON public.nftoken_links;
CREATE TRIGGER nftoken_links_touch
  BEFORE UPDATE ON public.nftoken_links
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
