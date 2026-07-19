
CREATE TABLE public.cached_emails (
  id TEXT PRIMARY KEY,
  subject TEXT,
  from_address TEXT,
  to_address TEXT,
  date TIMESTAMPTZ,
  otp TEXT,
  preview TEXT,
  html TEXT,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cached_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read cached emails"
  ON public.cached_emails FOR SELECT
  USING (true);

CREATE POLICY "Service role can insert/update cached emails"
  ON public.cached_emails FOR ALL
  USING (true)
  WITH CHECK (true);
