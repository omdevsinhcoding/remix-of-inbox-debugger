
CREATE TABLE IF NOT EXISTS public.imap_cookies (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  imap_user text NOT NULL UNIQUE,
  label text,
  filename text,
  format text,
  count integer NOT NULL DEFAULT 0,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.imap_cookies TO service_role;

ALTER TABLE public.imap_cookies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "imap_cookies_service_only" ON public.imap_cookies
  FOR ALL USING (false) WITH CHECK (false);

CREATE TRIGGER imap_cookies_touch_updated_at
  BEFORE UPDATE ON public.imap_cookies
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
