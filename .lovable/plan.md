
# Fix Telegram login location not showing

## Root cause
- This is not a Telegram formatting issue. Your screenshot has no `Maps:` line, which means the edge function never received usable coordinates (`hasCoords = false`), so the problem is earlier in the flow.
- In `src/App.tsx`, location is gathered in the browser and failures are silently swallowed (`.catch(() => null)`). If browser geolocation is blocked, denied, times out, or preview/iframe restrictions apply, no `lat/lon` is sent.
- The browser-side IP fallback (`ipapi.co`) is also unreliable because it runs client-side and its failure is also ignored.
- If notification sending falls back through `apiCall("send-login-notification")`, `cloudflare-worker/worker.js` proxies the request but does not forward the real visitor IP headers. Then `send-login-notification` cannot resolve IP-based location and ends up with `Unknown Location`.
- Current edge logs only show boot/shutdown, so there is no visibility into whether GPS failed, IP headers were missing, or reverse geocoding failed.

## Plan
1. Make location capture happen at the earliest possible user action
- Start geolocation immediately from the login submit/captcha entry point.
- Store that pending result and reuse it later when sending the login notification.

2. Stop depending on browser IP lookup as the main fallback
- Keep browser GPS as preferred.
- Move the reliable fallback to the edge function, where it can use the request IP.

3. Preserve real client IP through proxies
- Update `cloudflare-worker/worker.js` to forward original client IP headers (or a normalized `x-client-ip`) to Supabase when proxying `send-login-notification`.
- Expand `getClientIp()` in `supabase/functions/send-login-notification/index.ts` to read the forwarded header plus common proxy headers.
- Optionally align `server.ts` too, so every proxy path behaves the same.

4. Make the edge function always return a useful location result
- If coords exist: reverse geocode and include the Google Maps link.
- If coords do not exist but client IP exists: geolocate via IP and still include approximate city/state plus a map link.
- If reverse geocoding fails but coords exist: send map link anyway and show approximate coordinates instead of `Unknown Location`.

5. Add diagnostics so this does not become guesswork again
- Log which source was used: `gps`, `ip-header`, `client-ip-fallback`, or `none`.
- Log whether reverse geocoding failed and whether client IP headers were present.

## Files to update
- `src/App.tsx`
- `cloudflare-worker/worker.js`
- `supabase/functions/send-login-notification/index.ts`
- `server.ts` (if we want all proxy paths covered)

## Technical details
```text
Current failure path:
browser GPS fails
  + client-side ipapi fallback fails or is blocked
  + worker fallback strips client IP
  => edge function gets no coords and no usable IP
  => Telegram shows Unknown Location

Target flow:
user action
  -> start geolocation immediately
  -> login completes
  -> send notification with coords if available
  -> otherwise edge function uses forwarded real client IP
  -> reverse geocode / build map link
  -> Telegram shows location + map
```

## Verification
- Test normal user login
- Test admin login
- Test with CAPTCHA enabled
- Test when browser location permission is denied
- Test worker-proxied notification path
- Confirm Telegram message shows city/state and a working Google Maps link
- Confirm `Unknown Location` appears only in true hard-failure cases

## Notes
- No database changes are needed for this fix.
- The main bug is in location capture and proxy header forwarding, not in Telegram itself.
