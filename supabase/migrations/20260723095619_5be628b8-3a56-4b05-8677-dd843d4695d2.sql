
-- Retention cron jobs (bounded growth on every log-style table).

SELECT cron.unschedule('purge-crypto-nonces') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='purge-crypto-nonces');
SELECT cron.schedule('purge-crypto-nonces', '*/15 * * * *', $$SELECT public.purge_expired_nonces();$$);

SELECT cron.unschedule('purge-crypto-sessions') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='purge-crypto-sessions');
SELECT cron.schedule('purge-crypto-sessions', '7 * * * *', $$SELECT public.purge_expired_crypto_sessions();$$);

SELECT cron.unschedule('purge-app-sessions') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='purge-app-sessions');
SELECT cron.schedule('purge-app-sessions', '17 3 * * *',
  $$DELETE FROM public.app_sessions WHERE COALESCE(refresh_expires_at, expires_at) < now() - interval '1 day';$$);

SELECT cron.unschedule('purge-app-otps') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='purge-app-otps');
SELECT cron.schedule('purge-app-otps', '*/30 * * * *',
  $$DELETE FROM public.app_otps WHERE expires_at < now();$$);

SELECT cron.unschedule('retention-login-events') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='retention-login-events');
SELECT cron.schedule('retention-login-events', '23 3 * * *',
  $$DELETE FROM public.login_events WHERE created_at < now() - interval '90 days';$$);

SELECT cron.unschedule('retention-tv-login-events') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='retention-tv-login-events');
SELECT cron.schedule('retention-tv-login-events', '29 3 * * *',
  $$DELETE FROM public.tv_login_events WHERE created_at < now() - interval '30 days';$$);

SELECT cron.unschedule('retention-security-events') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='retention-security-events');
SELECT cron.schedule('retention-security-events', '35 3 * * *',
  $$DELETE FROM public.security_events WHERE ts < now() - interval '90 days';$$);

-- audit_logs has an immutable trigger blocking UPDATE/DELETE; wrap the prune.
CREATE OR REPLACE FUNCTION public.prune_audit_logs() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  ALTER TABLE public.audit_logs DISABLE TRIGGER USER;
  DELETE FROM public.audit_logs WHERE created_at < now() - interval '180 days';
  ALTER TABLE public.audit_logs ENABLE TRIGGER USER;
END;
$$;
SELECT cron.unschedule('retention-audit-logs') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='retention-audit-logs');
SELECT cron.schedule('retention-audit-logs', '41 3 * * *', $$SELECT public.prune_audit_logs();$$);

SELECT cron.unschedule('retention-notification-impressions') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='retention-notification-impressions');
SELECT cron.schedule('retention-notification-impressions', '47 3 * * *',
  $$DELETE FROM public.notification_impressions WHERE first_shown_at < now() - interval '30 days';$$);

SELECT cron.unschedule('retention-notification-events') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='retention-notification-events');
SELECT cron.schedule('retention-notification-events', '53 3 * * *',
  $$DELETE FROM public.notification_events WHERE at < now() - interval '30 days';$$);

-- Indexes to keep the retention deletes cheap.
CREATE INDEX IF NOT EXISTS idx_login_events_created_at ON public.login_events (created_at);
CREATE INDEX IF NOT EXISTS idx_tv_login_events_created_at ON public.tv_login_events (created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_ts ON public.security_events (ts);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_notification_impressions_first_shown_at ON public.notification_impressions (first_shown_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_at ON public.notification_events (at);
CREATE INDEX IF NOT EXISTS idx_cached_emails_date ON public.cached_emails (date);
CREATE INDEX IF NOT EXISTS idx_app_sessions_refresh_expires ON public.app_sessions (refresh_expires_at);

-- Autovacuum tuning: keeps pg_class.reltuples fresh so count:'planned' stays honest.
ALTER TABLE public.cached_emails SET (autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.app_users     SET (autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE public.app_sessions  SET (autovacuum_analyze_scale_factor = 0.05);

-- Immediate one-shot cleanup so IO recovers now.
SELECT public.purge_expired_nonces();
SELECT public.purge_expired_crypto_sessions();
DELETE FROM public.app_sessions            WHERE COALESCE(refresh_expires_at, expires_at) < now() - interval '1 day';
DELETE FROM public.app_otps                WHERE expires_at < now();
DELETE FROM public.login_events            WHERE created_at < now() - interval '90 days';
DELETE FROM public.tv_login_events         WHERE created_at < now() - interval '30 days';
DELETE FROM public.security_events         WHERE ts < now() - interval '90 days';
DELETE FROM public.notification_impressions WHERE first_shown_at < now() - interval '30 days';
DELETE FROM public.notification_events     WHERE at < now() - interval '30 days';
SELECT public.prune_audit_logs();
ANALYZE public.cached_emails;
ANALYZE public.app_users;
ANALYZE public.app_sessions;
