

# Fix: Account Assignment Not Filtering Emails

## Problem

When admin assigns accounts (e.g., "Coding") to a user and saves, the user still sees ALL emails instead of only their assigned account's emails. The feature appears "useless."

**Root cause**: The `assigned_accounts` value is embedded in the session token and localStorage at **login time**. If admin assigns accounts after the user logged in, the session token and localStorage still have the old value (`null`). The edge function trusts this stale data, so filtering never happens.

Even if the user re-logs in, there's a race condition where the session token's `assignedAccounts` can be overridden by the body's `accountLabels` (which comes from stale localStorage).

## Solution

Make the `fetch-emails` edge function **always check the DB** for current `assigned_accounts` instead of relying on stale session token data.

### 1. Update `fetch-emails` edge function (cache mode)

In the `mode === "cache"` block (~line 284-314):
- After verifying the session token and getting `userId`, query `app_users` table for the **current** `assigned_accounts` value
- Use that fresh DB value instead of the session token's stale `assignedAccounts`
- Remove reliance on `body.accountLabels` for filtering (it's from stale localStorage)

```
Session token → get userId → query app_users.assigned_accounts → use THAT for filtering
```

### 2. Update `fetch-emails` edge function (count mode)

Same fix for the count query (~line 364) — use fresh DB data for the account filter.

### 3. Clean up client-side workaround (src/App.tsx)

Remove line 2080's `body.accountLabels` override from localStorage since the server now handles filtering correctly from DB. The session token is still used for auth, but account filtering is DB-driven.

### 4. Update session token on account changes (optional improvement)

In `updateUserAccounts` (line 1082), if the admin is editing the currently-logged-in user's own accounts, update localStorage too. This won't be critical since the server now checks DB, but keeps things consistent.

## Expected Result

- Admin assigns "Coding" to a user → user immediately sees only "Coding" account emails (no re-login needed)
- Admin removes assignment → user sees nothing (non-admin with no accounts)
- Admin users always see all emails regardless

