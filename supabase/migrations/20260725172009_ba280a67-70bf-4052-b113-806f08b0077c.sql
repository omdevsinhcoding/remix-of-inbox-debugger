
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS plan_end_notified_at timestamptz;

DO $$ BEGIN
  PERFORM cron.unschedule('plan-reminders');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'plan-reminders',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/plan-reminders',
    headers := '{"Content-Type":"application/json","x-cron-secret":"Fy21ZhebFHT2lW5shRIrRHM61ILGo97Cr98VGx5CAi0TRlbyMu2SV5AQCpPa3Pwa"}'::jsonb,
    body := '{"source":"cron"}'::jsonb
  ) AS request_id;
  $cron$
);
