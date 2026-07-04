# Security memory

Updated after the latest hardening batch:

- `admin_2fa_bypass`: fixed. Admin password login now returns only a 5-minute pending token. Telegram OTP, server-side TOTP verification, and `finalize_admin_session` are required before a real admin session is minted.
- `fetch_emails_admin_open`: fixed. Cron toggles require an admin session. Sync requires admin session or `CRON_SHARED_SECRET`; user refresh uses authenticated `sync_async` / `user_sync` path.
- `fetch_emails_cache_open`: fixed. Cache and count modes require a valid session and keep assigned-account filtering.
- `login_notify_relay`: fixed. Public notification relay removed; login notification now happens inside `manage-app.login` using DB user data and server-side IP lookup.
- `recaptcha_secret_leak`: fixed. `get_settings(recaptcha)` strips `secretKey` for non-admin sessions.