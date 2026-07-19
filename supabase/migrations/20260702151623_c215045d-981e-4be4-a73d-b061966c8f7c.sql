
-- 1. Extend notifications
alter table public.notifications
  add column if not exists kind text not null default 'legacy',
  add column if not exists mode text,
  add column if not exists show_frequency text,
  add column if not exists platform_icon text,
  add column if not exists sub_kind text,
  add column if not exists rating numeric,
  add column if not exists genre_tags text[],
  add column if not exists body_markdown text,
  add column if not exists locked boolean not null default false,
  add column if not exists language text default 'en';

-- 2. User soft-delete
alter table public.notification_reads
  add column if not exists deleted_at timestamptz;

-- 3. Impressions
create table if not exists public.notification_impressions (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null,
  times_shown integer not null default 0,
  first_shown_at timestamptz,
  dismissed_at timestamptz,
  clicked_at timestamptz,
  completed_at timestamptz,
  meta jsonb,
  updated_at timestamptz not null default now(),
  unique (notification_id, user_id)
);
grant select, insert, update on public.notification_impressions to authenticated;
grant all on public.notification_impressions to service_role;
alter table public.notification_impressions enable row level security;
create policy "impressions_read"   on public.notification_impressions for select to authenticated using (true);
create policy "impressions_insert" on public.notification_impressions for insert to authenticated with check (true);
create policy "impressions_update" on public.notification_impressions for update to authenticated using (true);

create index if not exists notification_impressions_user_idx on public.notification_impressions(user_id);
create index if not exists notification_impressions_notif_idx on public.notification_impressions(notification_id);

-- 4. Translation cache
create table if not exists public.notification_translations (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  lang text not null,
  title text,
  body text,
  body_markdown text,
  created_at timestamptz not null default now(),
  primary key (notification_id, lang)
);
grant select on public.notification_translations to authenticated;
grant all on public.notification_translations to service_role;
alter table public.notification_translations enable row level security;
create policy "translations_read" on public.notification_translations for select to authenticated using (true);

-- 5. R2 storage settings seed
insert into public.app_settings(key, value)
values ('r2_storage', jsonb_build_object(
  'accountId','', 'accessKeyId','', 'secretAccessKey','',
  'bucket','', 'publicBaseUrl','', 'pathPrefix','notifications/', 'enabled', false
))
on conflict (key) do nothing;
