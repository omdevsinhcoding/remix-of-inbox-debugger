GRANT ALL ON public.imap_cookies TO service_role;

-- Keep browser roles locked out unless explicitly opened later.
REVOKE ALL ON public.imap_cookies FROM anon;
REVOKE ALL ON public.imap_cookies FROM authenticated;