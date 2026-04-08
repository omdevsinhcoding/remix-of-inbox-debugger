

## Plan: Gmail-Style Responsive Header & Layout Fix

### Problem
The header looks cramped on mobile — the mail icon, username badge, refresh button, and logout are squeezed together. The overall layout doesn't feel polished like Gmail on small screens.

### Changes to `src/App.tsx`

**1. Header redesign (Gmail-inspired, mobile-first)**
- Make the red mail icon larger and more prominent (like Gmail's logo area)
- Show username badge cleaner — remove the green dot animation clutter, use a simple text label
- Refresh button: icon-only on mobile (already done), keep clean circular style
- Logout button: smaller, subtle
- Use proper spacing: `px-3` on mobile, `px-4` on desktop
- Add `gap-2` between header items consistently

**2. Header structure (lines 1009-1033)**
- Left side: Red icon (bigger on mobile: `p-2 rounded-xl`) + username pill (cleaner text sizing)
- Right side: Refresh + Logout with consistent sizing
- Remove `flex-shrink` hacks, use proper `min-w-0` and `truncate` only where needed
- Username max-width: increase from `60px` to `80px` on mobile for readability

**3. Email content area responsiveness (lines 1107-1160)**
- Email detail header padding: already has `p-3 sm:p-6`, keep it
- Sender avatar and info: already responsive, keep it
- Email body container: ensure `overflow-x-hidden` and proper word-break for HTML content

**4. Inbox list items (lines 1077-1101)**
- Slightly increase padding on mobile: `p-3` instead of `p-4` to save space
- From name: increase `max-w-[60%]` to `max-w-[70%]` for better truncation

### Files to Edit
- `src/App.tsx` — Header section (lines 1009-1033), inbox list items styling

