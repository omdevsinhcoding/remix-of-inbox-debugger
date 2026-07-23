ALTER TABLE public.nftoken_links
  ADD COLUMN IF NOT EXISTS link_url text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

UPDATE public.nftoken_links
SET link_url = link
WHERE link_url IS NULL AND link IS NOT NULL;

ALTER TABLE public.nftoken_links
  ALTER COLUMN link DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nftoken_links_user_status_exp
  ON public.nftoken_links (user_id, status, expires_at DESC);
