

## Plan: Admin Panel Enhancements & Email Filter Controls

### What You Asked For
1. **Sign-in code filter toggle** — Admin can toggle whether "sign in code" emails are shown or hidden in the inbox
2. **Server config pre-fill not working** — Fix the config fields not loading saved values
3. **Admin "Visit User" (Eye icon) should go directly into user account** — Currently it does via `loginAsUser`, but need to verify it navigates properly
4. **Admin change user password** — Already exists, confirm working
5. **Add multiple email accounts** — Support more than one IMAP account
6. **Admin panel UI improvements** — Better layout, polish, organization

---

### Changes

#### 1. Email Filter Toggle in Admin Panel (new setting)
**File: `src/App.tsx` — AdminPanel**
- Add a new toggle: **"Show Sign-In Code Emails"** (on/off)
- Stores in `app_settings` with key `email_filters` → `{ showSignInCodes: true/false }`
- When OFF, the `EmailViewer` fetches this setting and filters out emails with subjects containing "Enter this code to sign in" or similar sign-in code keywords
- Also update `fetch-emails/index.ts` to optionally filter sign-in code emails at the server level (like password reset filtering)

**File: `supabase/functions/fetch-emails/index.ts`**
- Add `SIGN_IN_CODE_SUBJECTS` filter array (e.g., "enter this code", "sign in code", "sign-in activity")
- Read `email_filters` setting from `app_settings`
- If `showSignInCodes` is false, skip those emails during IMAP sync (same pattern as password reset filtering)

#### 2. Fix Server Config Pre-fill
**File: `src/App.tsx` — AdminPanel useEffect**
- The config fetch looks correct (`get_settings` with key `config`), but the DB currently has no `config` key saved
- The issue: config values are only saved when admin clicks "Save Server Configuration" — if they were set via environment variables originally, they won't appear in the UI
- Fix: ensure the initial load properly populates fields; add a check that if `config.value` has the keys, spread them properly

#### 3. Admin Visit User — Direct Account Access
**File: `src/App.tsx` — `loginAsUser` function (line 700-705)**
- Already implemented and navigates to `/viewer`
- Verify it works correctly; the Eye icon click should set localStorage and redirect

#### 4. Multiple Email Accounts Support
**File: `src/App.tsx` — AdminPanel**
- Convert the single IMAP config into an **email accounts list** stored in `app_settings` key `email_accounts`
- Admin can add/remove multiple IMAP accounts (each with host, port, user, password, label)
- UI: "Email Accounts" section with add/remove buttons, each account as a card

**File: `supabase/functions/fetch-emails/index.ts`**
- Read `email_accounts` array from `app_settings` instead of single config
- Loop through each account, connect to IMAP, fetch emails from all accounts
- Tag cached emails with `account_label` or `account_id` for identification

**Database migration:**
- Add `account_label` column to `cached_emails` table (nullable, default null for backward compatibility)

#### 5. Admin Panel UI Enhancements
**File: `src/App.tsx` — AdminPanel**
- Add tab-based navigation: **Users | Security | Email Accounts | Settings**
- Better card styling with icons and descriptions
- Status indicators (green dot for active IMAP connections)
- User list: show last login time, add search/filter
- Move "Change Admin Password" into a dropdown/profile menu in header
- Add dashboard stats at top: total users, active emails, last sync time

---

### Files to Edit
1. `src/App.tsx` — Admin panel redesign (tabs, email filter toggle, multi-account UI, enhancements)
2. `supabase/functions/fetch-emails/index.ts` — Sign-in code filtering, multi-account IMAP support
3. **Database migration** — Add `account_label` column to `cached_emails`

### Technical Notes
- Email filter setting uses existing `app_settings` table (key: `email_filters`)
- Multi-account stored as JSON array in `app_settings` (key: `email_accounts`)
- Backward compatible: if no `email_accounts` key exists, falls back to single `config` key
- Sign-in code filter keywords: "enter this code", "sign-in code", "sign in to", "sign-in activity"

