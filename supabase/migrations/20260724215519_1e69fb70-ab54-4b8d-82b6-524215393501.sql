
CREATE TABLE IF NOT EXISTS public.github_config (
  id smallint PRIMARY KEY DEFAULT 1,
  pat text,
  repo text,
  hmac_key text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT github_config_singleton CHECK (id = 1)
);
GRANT ALL ON public.github_config TO service_role;
ALTER TABLE public.github_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "github_config_service_only" ON public.github_config;
CREATE POLICY "github_config_service_only" ON public.github_config FOR ALL TO service_role USING (true) WITH CHECK (true);
