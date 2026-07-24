// Recipient-email redactor. Applied at ingest (before DB write) AND at serve
// time (defense in depth for legacy rows). The real address never reaches the
// client, so no CSS/JS trick on the browser side can un-mask it.

// Matches any RFC-ish email token. Deliberately greedy on the local-part and
// domain so we catch bracketed forms like `[foo@bar.com]` and quoted forms.
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

// Visual: a small pill sized like an email token, blurred, non-selectable.
// Uses currentColor so it blends into whatever text color the email uses
// (Netflix footer = grey, headings = dark). No fixed hex so light/dark themes
// both render sensibly.
const BLUR_PILL =
  '<span aria-hidden="true" style="display:inline-block;vertical-align:baseline;' +
  'min-width:96px;height:0.9em;line-height:1;padding:0 8px;border-radius:4px;' +
  'background:currentColor;color:transparent;opacity:0.28;' +
  'filter:blur(5px);-webkit-filter:blur(5px);' +
  'user-select:none;-webkit-user-select:none;pointer-events:none;' +
  '-webkit-text-security:disc;">hidden</span>';

const TEXT_MASK = "•••••••@•••••";

/** Strip email addresses from an HTML fragment. Also handles mailto: hrefs. */
export function redactEmailsHtml(input: string | null | undefined): string {
  if (!input) return String(input ?? "");
  let out = String(input);
  // Neutralise mailto: links so the address doesn't leak via href or click.
  out = out.replace(/mailto:[^"'\s>]+/gi, "mailto:hidden");
  // Replace visible addresses.
  out = out.replace(EMAIL_RE, BLUR_PILL);
  return out;
}

/** Strip email addresses from plain text fields (preview, to, subject). */
export function redactEmailsText(input: string | null | undefined): string {
  if (!input) return String(input ?? "");
  return String(input).replace(EMAIL_RE, TEXT_MASK);
}
