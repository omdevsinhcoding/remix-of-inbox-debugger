
-- One-time scrub: strip real email addresses from every stored cached email.
-- New ingest already redacts before writing; this cleans historical rows.
DO $$
DECLARE
  email_re CONSTANT text := '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}';
  blur_pill CONSTANT text := '<span aria-hidden="true" style="display:inline-block;vertical-align:baseline;min-width:96px;height:0.9em;line-height:1;padding:0 8px;border-radius:4px;background:currentColor;color:transparent;opacity:0.28;filter:blur(5px);-webkit-filter:blur(5px);user-select:none;-webkit-user-select:none;pointer-events:none;-webkit-text-security:disc;">hidden</span>';
  text_mask CONSTANT text := '•••••••@•••••';
BEGIN
  UPDATE public.cached_emails
     SET html = regexp_replace(
                  regexp_replace(coalesce(html,''), 'mailto:[^"''\s>]+', 'mailto:hidden', 'gi'),
                  email_re, blur_pill, 'g'),
         preview = regexp_replace(coalesce(preview,''), email_re, text_mask, 'g'),
         to_address = regexp_replace(coalesce(to_address,''), email_re, text_mask, 'g')
   WHERE (html ~ email_re) OR (preview ~ email_re) OR (to_address ~ email_re);
END $$;
