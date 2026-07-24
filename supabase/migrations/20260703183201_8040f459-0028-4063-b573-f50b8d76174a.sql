CREATE TABLE IF NOT EXISTS public.crypto_sessions (
  id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  aes_key bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

GRANT ALL ON public.crypto_sessions TO service_role;

ALTER TABLE public.crypto_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crypto_sessions service only"
  ON public.crypto_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS crypto_sessions_expires_at_idx
  ON public.crypto_sessions (expires_at);

CREATE OR REPLACE FUNCTION public.purge_expired_crypto_sessions()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.crypto_sessions WHERE expires_at < now();
$$;