CREATE TABLE IF NOT EXISTS public.netflix_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  account_label text,
  cookies_json text,
  status text NOT NULL DEFAULT 'idle',
  last_error text,
  logs jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.netflix_sessions TO service_role;

ALTER TABLE public.netflix_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.netflix_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER netflix_sessions_touch BEFORE UPDATE ON public.netflix_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();