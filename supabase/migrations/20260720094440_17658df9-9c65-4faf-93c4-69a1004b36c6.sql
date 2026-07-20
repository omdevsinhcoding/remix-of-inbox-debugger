CREATE TABLE public.tv_login_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  username text,
  imap_user text,
  account_label text,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  cookies_available boolean NOT NULL DEFAULT false,
  ip text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.tv_login_events TO service_role;

ALTER TABLE public.tv_login_events ENABLE ROW LEVEL SECURITY;

-- No direct client access; all reads/writes go through the manage-app edge function using service_role.
CREATE POLICY "tv_login_events_no_client_access"
  ON public.tv_login_events
  FOR ALL
  USING (false)
  WITH CHECK (false);

CREATE INDEX idx_tv_login_events_user_created ON public.tv_login_events(user_id, created_at DESC);
CREATE INDEX idx_tv_login_events_code ON public.tv_login_events(code);

CREATE TRIGGER trg_tv_login_events_touch
  BEFORE UPDATE ON public.tv_login_events
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();