DELETE FROM public.cached_emails WHERE account_label = 'Primary';
DELETE FROM public.tv_login_events WHERE account_label = 'Primary';
DELETE FROM public.netflix_sessions WHERE account_label = 'Primary';
DELETE FROM public.imap_cookies WHERE label = 'Primary';