# Fix delayed/missing Gmail inbox refresh

## Confirmed findings
- The reported 21 Aug 2026 12:14 PM household message is absent from `cached_emails`; this is an ingestion failure, not only a UI display/cache issue.
- Manual refresh currently searches only the IMAP `INBOX`. Netflix mail moved by Gmail rules or classification outside that mailbox cannot be discovered.
- The 8-second IMAP budget only flips a boolean; it does not interrupt an IMAP command already waiting on the network.
- The frontend can start the full refresh a second time after a timeout because `NetworkError` is treated as retryable, despite the lower transport layer intentionally avoiding replay for `fetch-emails`.
- After ingestion, the user read paths already classify household messages before account-update messages and permit household mail.

## Implementation
1. **Make Netflix discovery reliable**
   - Keep the fast newest-message scan for normal low-latency refreshes.
   - Search Gmail’s All Mail mailbox as a bounded fallback when the INBOX scan finds no uncached Netflix message, so Promotions/archived/filter-routed household messages are still discovered.
   - Continue enforcing official Netflix sender validation and recipient/account routing before storing anything.
   - Fetch the newest uncached matching messages first and keep all existing account isolation rules.

2. **Enforce the existing time budget**
   - Convert the current passive timer into real cancellation: when the per-account budget expires, close the IMAP connection so an in-flight search/fetch cannot keep the Edge Function alive for minutes.
   - Preserve the current 8-second quick-refresh and 15-second browser request limits; do not extend them.
   - Return partial successful results from accounts that finished, plus a clear warning for timed-out accounts.

3. **Stop duplicate refresh jobs and endless loading**
   - Remove the outer frontend retry for `fetch-emails`; a single click will create exactly one server sync.
   - Keep `finally` as the authoritative cleanup for the refresh lock/loading state.
   - After the one sync attempt, immediately reload the authoritative cached inbox once so mail inserted near the transport deadline appears without a second click.

4. **Make delta delivery resilient**
   - Ensure the post-refresh cache reload updates IndexedDB/delta state consistently, preventing a stale cursor from hiding a newly inserted row on later navigation.
   - Keep non-baseline deltas uncached; do not add polling, cron syncing, or visual changes.

## Verification
- Add focused tests for: household classification, shared-inbox recipient routing, scanning past cached UIDs, All Mail fallback, and timeout cancellation.
- Run Edge Function tests and verify current build/runtime logs.
- Trigger a real manual sync against the configured account, then verify in the database that the target household message is inserted with the correct account label and increasing `modseq`.
- Test the live UI with rapid Refresh clicks and confirm: one network sync per click, loading always clears within the existing limit, and the new row appears without waiting 3–10 minutes.
