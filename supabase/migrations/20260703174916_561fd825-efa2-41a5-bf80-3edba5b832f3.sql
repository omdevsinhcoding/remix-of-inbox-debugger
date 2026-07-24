CREATE INDEX IF NOT EXISTS cached_emails_date_desc_idx ON public.cached_emails (date DESC);
CREATE INDEX IF NOT EXISTS cached_emails_account_label_date_desc_idx ON public.cached_emails (account_label, date DESC);
CREATE INDEX IF NOT EXISTS cached_emails_cached_at_idx ON public.cached_emails (cached_at);
CREATE INDEX IF NOT EXISTS app_users_role_created_at_idx ON public.app_users (role, created_at ASC);