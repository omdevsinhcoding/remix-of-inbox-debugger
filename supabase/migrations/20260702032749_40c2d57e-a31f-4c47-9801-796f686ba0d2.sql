
CREATE TABLE public.login_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  username text,
  role text,
  event text NOT NULL,
  ip text,
  ip_source text,
  isp text,
  asn text,
  org text,
  country text,
  country_code text,
  region text,
  district text,
  city text,
  zip text,
  ip_lat double precision,
  ip_lon double precision,
  timezone text,
  utc_offset text,
  currency text,
  calling_code text,
  connection_type text,
  is_proxy boolean,
  is_vpn boolean,
  is_tor boolean,
  is_hosting boolean,
  gps_lat double precision,
  gps_lon double precision,
  gps_accuracy double precision,
  gps_altitude double precision,
  gps_heading double precision,
  gps_speed double precision,
  gps_captured_at timestamptz,
  device_type text,
  device_brand text,
  device_model text,
  os_name text,
  os_version text,
  browser_name text,
  browser_version text,
  browser_engine text,
  user_agent text,
  platform text,
  languages text[],
  hardware_concurrency int,
  device_memory numeric,
  screen_w int,
  screen_h int,
  viewport_w int,
  viewport_h int,
  color_depth int,
  pixel_ratio numeric,
  orientation text,
  network_type text,
  downlink numeric,
  rtt int,
  save_data boolean,
  battery_level numeric,
  battery_charging boolean,
  fingerprint_hash text,
  is_new_device boolean,
  impossible_travel boolean,
  risk_score text,
  risk_reasons text[],
  session_id uuid,
  session_duration_seconds int,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.login_events TO service_role;

ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only login_events"
  ON public.login_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX login_events_user_created_idx ON public.login_events (user_id, created_at DESC);
CREATE INDEX login_events_ip_idx ON public.login_events (ip);
CREATE INDEX login_events_fp_idx ON public.login_events (fingerprint_hash);
CREATE INDEX login_events_created_idx ON public.login_events (created_at DESC);
