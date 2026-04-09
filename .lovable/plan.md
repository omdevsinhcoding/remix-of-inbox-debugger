

# Fix: Add Cloudflare URLs to Primary IMAP + Edit Existing Accounts

## Current State

The code already has Cloudflare URL support when **adding a new account** (Email Accounts tab, "Add Account" form has the URL list UI). But:

1. **Primary IMAP Server** (Settings tab) -- has NO Cloudflare URL fields. This is the account you're looking at in the screenshot. The Primary account is stored separately in `serverConfig` and has no `cloudflareUrls` property.

2. **Existing accounts** -- once added, you can only view their Cloudflare URLs (read-only in the expanded card) or delete the whole account. There's no way to edit/add URLs to an already-saved account.

3. **How emails are fetched currently**: The viewer (`EmailViewer`) loads `email_accounts` from `manage-app` edge function, extracts all `cloudflareUrls` from all accounts, then calls those Cloudflare Worker URLs. The Cloudflare Worker (`worker.js`) then calls the Supabase edge function internally. The frontend also still calls `supabase.co/rest/v1/cached_emails` directly for ID lookups. So Supabase is still used for: (a) `manage-app` edge function for login/settings/user management, (b) `cached_emails` REST reads, (c) Realtime subscription.

**Important**: You said you removed Supabase completely, but the app still calls `jsqchutnfdeljajkxmly.supabase.co` for ALL operations (login, settings, user list, etc.) -- those are Supabase edge functions. The only thing we removed was the email sync going through Supabase edge functions. The `manage-app` function still runs on Supabase.

## Plan

### Step 1: Add Cloudflare URL fields to Primary IMAP Server section

**File:** `src/App.tsx` (Settings tab, lines 1386-1421)

Add a new state `primaryCfUrls: string[]` and `primaryCfInput: string`. Below the App Password field in the "Primary IMAP Server" section, add the same Cloudflare Worker URLs UI (list + add/remove + input) that exists in the "Add Account" form.

Save these URLs alongside the existing `serverConfig` in a new setting key `primary_cloudflare_urls`, or store them in the `email_accounts` array as a special "Primary" entry.

### Step 2: Allow editing Cloudflare URLs on existing accounts

**File:** `src/App.tsx` (Connected Accounts section, lines 1315-1350)

In the expanded account card view, add an "Edit URLs" button that shows an inline add/remove UI for `cloudflareUrls`. When URLs are changed, save the updated `email_accounts` array back to settings.

### Step 3: Include Primary account's Cloudflare URLs in the viewer

**File:** `src/App.tsx` (EmailViewer, lines 1562-1584)

When loading worker URLs, also fetch `primary_cloudflare_urls` (or read the Primary entry from `email_accounts`) and include those URLs in `resolvedWorkerUrls`.

### Step 4: Fix import path

**File:** `src/App.tsx` line 7 -- change `@/src/integrations/supabase/client` to `@/integrations/supabase/client`.

---

## How email fetching works (explanation)

```text
User clicks Refresh
    ↓
Frontend calls Cloudflare Worker URLs (from email_accounts settings)
    ↓
Cloudflare Worker calls Supabase Edge Function (server-to-server, invisible to you)
    ↓
Supabase Edge Function connects to IMAP server, downloads emails
    ↓
Emails stored in Supabase DB (cached_emails table)
    ↓
Cloudflare Worker returns emails to frontend
```

The frontend no longer calls the Supabase edge function directly. But the Cloudflare Worker still uses it internally -- this is unavoidable because Cloudflare Workers cannot do raw IMAP connections. Your Supabase project is still needed as the backend for `manage-app` (login, settings, users) and `cached_emails` storage.

---

## Summary

| Change | What |
|--------|------|
| Cloudflare URLs on Primary IMAP | Add URL list UI to Settings tab Primary section |
| Edit URLs on existing accounts | Inline edit UI in expanded account cards |
| Include Primary URLs in viewer | Fetch and merge Primary account's worker URLs |
| Fix import crash | `@/src/` to `@/` |

