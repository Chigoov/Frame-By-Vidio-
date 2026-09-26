create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Proyek tanpa nama' check (char_length(name) between 1 and 120),
  source_name text not null default '' check (char_length(source_name) <= 255),
  source_duration_ms bigint check (source_duration_ms is null or source_duration_ms >= 0),
  source_width integer check (source_width is null or source_width between 1 and 100000),
  source_height integer check (source_height is null or source_height between 1 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.local_exports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  file_name text not null check (char_length(file_name) between 1 and 255),
  source_time_ms bigint not null check (source_time_ms >= 0),
  width integer not null check (width between 1 and 100000),
  height integer not null check (height between 1 and 100000),
  output_format text not null check (output_format in ('png', 'jpeg', 'webp')),
  scale numeric(4,2) not null default 1 check (scale in (1, 2, 4)),
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  created_at timestamptz not null default now()
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid,
  storage_path text not null unique check (char_length(storage_path) <= 512),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm')),
  width integer check (width is null or width between 1 and 100000),
  height integer check (height is null or height between 1 and 100000),
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  kind text not null check (kind in ('cloud_upscale', 'cloud_extract')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  request_key uuid not null,
  input_asset_id uuid references public.assets(id) on delete set null,
  output_count integer not null default 0 check (output_count >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, request_key)
);

alter table public.assets add constraint assets_job_fk foreign key (job_id) references public.jobs(id) on delete cascade;

create index projects_user_updated_idx on public.projects(user_id, updated_at desc);
create index local_exports_user_created_idx on public.local_exports(user_id, created_at desc);
create index jobs_user_created_idx on public.jobs(user_id, created_at desc);
create index assets_user_created_idx on public.assets(user_id, created_at desc);

create table public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider = 'google_play'),
  product_id text not null check (char_length(product_id) <= 128),
  state text not null check (state in ('active', 'in_grace_period', 'cancelled', 'on_hold', 'paused', 'expired', 'pending')),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table public.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  usage_type text not null check (usage_type in ('cloud_job', 'cloud_storage_bytes', 'ai_upscale_pixels')),
  quantity bigint not null check (quantity > 0),
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, usage_type, idempotency_key)
);

create table public.play_purchases (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  state text not null,
  expires_at timestamptz,
  last_verified_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.local_exports enable row level security;
alter table public.jobs enable row level security;
alter table public.assets enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.play_purchases enable row level security;

revoke all on public.profiles, public.projects, public.local_exports, public.jobs, public.assets,
  public.subscriptions, public.usage_ledger, public.play_purchases from anon, authenticated;
grant select, insert, update, delete on public.projects, public.local_exports to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.jobs, public.assets, public.subscriptions, public.usage_ledger to authenticated;
revoke all on public.play_purchases from anon, authenticated;

create policy profiles_read_own on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy projects_read_own on public.projects for select to authenticated using (user_id = (select auth.uid()));
create policy projects_insert_own on public.projects for insert to authenticated with check (user_id = (select auth.uid()));
create policy projects_update_own on public.projects for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy projects_delete_own on public.projects for delete to authenticated using (user_id = (select auth.uid()));

create policy exports_read_own on public.local_exports for select to authenticated using (user_id = (select auth.uid()));
create policy exports_insert_own on public.local_exports for insert to authenticated with check (
  user_id = (select auth.uid()) and (project_id is null or exists (
    select 1 from public.projects where projects.id = local_exports.project_id and projects.user_id = (select auth.uid())
  ))
);
create policy exports_update_own on public.local_exports for update to authenticated using (user_id = (select auth.uid())) with check (
  user_id = (select auth.uid()) and (project_id is null or exists (
    select 1 from public.projects where projects.id = local_exports.project_id and projects.user_id = (select auth.uid())
  ))
);
create policy exports_delete_own on public.local_exports for delete to authenticated using (user_id = (select auth.uid()));

create policy jobs_read_own on public.jobs for select to authenticated using (user_id = (select auth.uid()));
create policy assets_read_own on public.assets for select to authenticated using (user_id = (select auth.uid()));
create policy assets_delete_own on public.assets for delete to authenticated using (user_id = (select auth.uid()));
create policy subscriptions_read_own on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy usage_read_own on public.usage_ledger for select to authenticated using (user_id = (select auth.uid()));

create function private.create_profile_for_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles(user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function private.create_profile_for_user() from public, anon, authenticated;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.create_profile_for_user();

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('jeda-private', 'jeda-private', false, 52428800, array['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Users read their private media" on storage.objects
  for select to authenticated using (bucket_id = 'jeda-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users delete their private media" on storage.objects
  for delete to authenticated using (bucket_id = 'jeda-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
