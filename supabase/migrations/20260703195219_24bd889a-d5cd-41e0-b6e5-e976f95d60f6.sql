
-- Phase A: anti-replay + rate limit + origin binding

ALTER TABLE public.crypto_sessions
  ADD COLUMN IF NOT EXISTS origin_hash text,
  ADD COLUMN IF NOT EXISTS ip text;

-- Set default expires_at to 15 min if column already default was different
ALTER TABLE public.crypto_sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '15 minutes');

CREATE TABLE IF NOT EXISTS public.crypto_nonces (
  session_id uuid NOT NULL,
  nonce bytea NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, nonce)
);
CREATE INDEX IF NOT EXISTS crypto_nonces_seen_at_idx ON public.crypto_nonces (seen_at);
GRANT ALL ON public.crypto_nonces TO service_role;
ALTER TABLE public.crypto_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON public.crypto_nonces FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.handshake_rate (
  ip text NOT NULL,
  minute_bucket timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, minute_bucket)
);
CREATE INDEX IF NOT EXISTS handshake_rate_bucket_idx ON public.handshake_rate (minute_bucket);
GRANT ALL ON public.handshake_rate TO service_role;
ALTER TABLE public.handshake_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON public.handshake_rate FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.purge_expired_nonces()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.crypto_nonces WHERE seen_at < now() - interval '5 minutes';
  DELETE FROM public.handshake_rate WHERE minute_bucket < now() - interval '2 hours';
$$;
