-- Sequence for monotonic modseq (delta-sync cursor)
CREATE SEQUENCE IF NOT EXISTS public.cached_emails_modseq_seq;

-- Add modseq + destroyed columns
ALTER TABLE public.cached_emails
  ADD COLUMN IF NOT EXISTS modseq BIGINT NOT NULL DEFAULT nextval('public.cached_emails_modseq_seq'),
  ADD COLUMN IF NOT EXISTS destroyed BOOLEAN NOT NULL DEFAULT false;

-- Bump modseq on every UPDATE so clients see the row again in next delta
CREATE OR REPLACE FUNCTION public.bump_email_modseq()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.modseq := nextval('public.cached_emails_modseq_seq');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cached_emails_modseq_bump ON public.cached_emails;
CREATE TRIGGER cached_emails_modseq_bump
  BEFORE UPDATE ON public.cached_emails
  FOR EACH ROW EXECUTE FUNCTION public.bump_email_modseq();

-- Indexes for delta + list queries
CREATE INDEX IF NOT EXISTS cached_emails_modseq_idx
  ON public.cached_emails (modseq);

CREATE INDEX IF NOT EXISTS cached_emails_date_idx
  ON public.cached_emails (account_label, date DESC)
  WHERE destroyed = false;