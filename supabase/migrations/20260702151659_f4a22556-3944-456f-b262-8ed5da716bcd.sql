
drop policy if exists "impressions_insert" on public.notification_impressions;
drop policy if exists "impressions_update" on public.notification_impressions;
-- Reads stay open (users may want to see their own impression rows if we ever read from client);
-- writes go exclusively through service_role in the edge function.
revoke insert, update on public.notification_impressions from authenticated;
