# How Netflix Mail Works — User Guide

A short walkthrough of the user side of the app.

## 1. Sign in
Open the app, enter your username and password. If 2FA is on, punch in the OTP sent to your email. A session token is saved to your browser so you stay signed in across tabs and refreshes. The bell icon and countdown timer at the top confirm the session is live.

## 2. Your Inbox
The home screen shows every Netflix email addressed to your account, freshest first.
- **Search bar** — instant filter by subject, sender, or code.
- **Filter chips** — narrow to household confirmations, sign-in codes, password resets, or billing.
- **Cache badge** — a small tag tells you whether the data came from the edge cache (fast) or Supabase (fresh).
Pull down or hit refresh to force a sync from the Cloudflare Worker, which fetches new mail from IMAP in the background.

## 3. Opening a Mail
Tap any row to open the full HTML email in a sandboxed iframe. Sign-in codes and reset links are auto-highlighted with a **Copy** button. External images are proxied so nothing tracks you back.

## 4. Notifications
The **bell** in the top bar shows announcements from the team.
- **⚡ Flash Cards** — short pop-up alerts (maintenance windows, new features).
- **📄 Articles** — longer reads rendered from markdown (guides, release notes).
Tabs: **All** and **Unread**. Swipe or click **Delete** to remove one from your view; **Snooze 24h** to hide it for a day. Locked admin notices can't be deleted. High-priority items auto-open once as a premium modal.

## 5. Session & Security
- **Countdown timer** shows time left before your session expires — it auto-refreshes while you're active.
- Every login is recorded with device, IP, city, and ISP. If a login happens from a new device, an alert is sent.
- **Sign out** clears the local session; other devices stay signed in unless you revoke them.

## 6. Maintenance Mode
If the team pushes a maintenance window, a full-screen notice replaces the app with the title, message, and ETA. Once it lifts, the app returns automatically — no refresh needed.

## 7. Offline & Speed
Recent inbox pages are cached in the browser so the list paints instantly on next open. The Cloudflare Worker keeps a shared edge cache too, so cold loads stay under a second in most regions.

That's the whole loop: sign in → read mail → get notified → stay secure.
