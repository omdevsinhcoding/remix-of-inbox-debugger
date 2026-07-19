SELECT cron.unschedule('sync-netflix-emails');

SELECT cron.schedule(
  'sync-netflix-emails',
  '*/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://jsqchutnfdeljajkxmly.supabase.co/functions/v1/fetch-emails',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA"}'::jsonb,
    body := '{"mode":"sync","source":"cron"}'::jsonb
  ) AS request_id;
  $$
);