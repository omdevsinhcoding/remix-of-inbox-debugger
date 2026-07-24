
-- App Users table (replaces Firebase users collection)
CREATE TABLE public.app_users (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  totp_secret TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read non-sensitive fields (for profile cards)
CREATE POLICY "Anyone can read user profiles"
  ON public.app_users FOR SELECT
  USING (true);

-- No insert/update/delete via client - only edge functions with service role
-- (No additional policies needed - RLS blocks by default)

-- App Settings table (replaces Firebase settings collection)
CREATE TABLE public.app_settings (
  key TEXT NOT NULL PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read settings"
  ON public.app_settings FOR SELECT
  USING (true);

-- App OTPs table (replaces Firebase otps collection)
CREATE TABLE public.app_otps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  otp TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '5 minutes')
);

ALTER TABLE public.app_otps ENABLE ROW LEVEL SECURITY;

-- No client access to OTPs - edge functions use service role
