grant usage on schema private to service_role;

create table public.plan_limits (
  plan_code text primary key check (plan_code in ('free', 'pro')),
  enabled boolean not null default false,
  monthly_jobs integer not null default 0 check (monthly_jobs between 0 and 500),
  monthly_storage_bytes bigint not null default 0 check (monthly_storage_bytes >= 0),
  max_upload_bytes bigint not null default 0 check (max_upload_bytes between 0 and 52428800),
  max_duration_ms bigint not null default 0 check (max_duration_ms between 0 and 600000),
  max_frames integer not null default 0 check (max_frames between 0 and 100),
  retention_days integer not null default 0 check (retention_days between 0 and 365),
  updated_at timestamptz not null default now()
);
alter table public.plan_limits enable row level security;
revoke all on public.plan_limits from public, anon, authenticated;
grant select, insert, update, delete on public.plan_limits to service_role;

create table public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  delete_after timestamptz not null
);
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public, anon, authenticated;
grant select, insert, update, delete on public.account_deletion_requests to service_role;

alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs alter column status set default 'awaiting_upload';
alter table public.jobs add constraint jobs_status_check
  check (status in ('awaiting_upload', 'queued', 'processing', 'completed', 'failed', 'cancelled', 'deleting'));
alter table public.jobs add column options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object');
alter table public.jobs add column upload_expires_at timestamptz;
alter table public.jobs add column attempts integer not null default 0 check (attempts >= 0);
alter table public.jobs add column available_at timestamptz not null default now();
alter table public.jobs add column locked_at timestamptz;
alter table public.jobs add column completed_at timestamptz;
alter table public.jobs add column cancel_requested boolean not null default false;
create index jobs_queue_idx on public.jobs(status, available_at, created_at) where status in ('queued', 'processing');
create index assets_job_created_idx on public.assets(job_id, created_at);

grant select, insert, update, delete on public.jobs, public.assets, public.usage_ledger to service_role;
grant select on public.subscriptions to service_role;
grant usage, select on sequence public.usage_ledger_id_seq to service_role;

create or replace function public.request_account_deletion(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delete_after timestamptz;
begin
  perform 1 from auth.users u where u.id = p_user_id for update;
  if not found then raise exception 'account_not_found'; end if;
  select r.delete_after into v_delete_after from public.account_deletion_requests r where r.user_id = p_user_id;
  if found then return v_delete_after; end if;

  select greatest(now(), coalesce(max(j.upload_expires_at), now())) into v_delete_after
    from public.jobs j where j.user_id = p_user_id;
  insert into public.account_deletion_requests(user_id, delete_after)
    values (p_user_id, v_delete_after);
  update public.jobs j set status = 'cancelled', updated_at = now()
    where j.user_id = p_user_id and j.status in ('awaiting_upload', 'queued');
  update public.jobs j set cancel_requested = true, updated_at = now()
    where j.user_id = p_user_id and j.status = 'processing';
  return v_delete_after;
end;
$$;

create or replace function public.reserve_cloud_extract_job(
  p_user_id uuid,
  p_request_key uuid,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_duration_ms bigint,
  p_width integer,
  p_height integer,
  p_options jsonb,
  p_project_id uuid default null
)
returns table(job_id uuid, status text, storage_path text, plan_code text, max_frames integer, retention_days integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan_code text;
  v_plan public.plan_limits%rowtype;
  v_existing public.jobs%rowtype;
  v_existing_asset public.assets%rowtype;
  v_job_id uuid := gen_random_uuid();
  v_asset_id uuid := gen_random_uuid();
  v_path text;
  v_month_start timestamptz := date_trunc('month', now());
  v_used_jobs bigint;
  v_used_bytes bigint;
  v_output_count integer;
begin
  if p_request_key is null or p_file_name is null or char_length(p_file_name) not between 1 and 160
     or p_mime_type not in ('video/mp4', 'video/webm')
     or p_size_bytes is null or p_size_bytes < 1
     or p_duration_ms is null or p_duration_ms < 1
     or p_width is null or p_width not between 1 and 8192
     or p_height is null or p_height not between 1 and 8192
     or p_options is null or jsonb_typeof(p_options) <> 'object' then
    raise exception 'invalid_input';
  end if;
  v_output_count := coalesce((p_options ->> 'expectedCount')::integer, 0);
  if v_output_count < 1 then raise exception 'invalid_options'; end if;

  perform 1 from auth.users where id = p_user_id for update;
  if not found then raise exception 'account_not_found'; end if;
  if exists (select 1 from public.account_deletion_requests r where r.user_id = p_user_id) then
    raise exception 'account_deletion_pending';
  end if;

  select * into v_existing from public.jobs j
  where j.user_id = p_user_id and j.request_key = p_request_key;
  if found then
    select * into v_existing_asset from public.assets a
    where a.id = v_existing.input_asset_id and a.user_id = p_user_id;
    if v_existing.project_id is distinct from p_project_id
       or v_existing.options ->> 'sourceName' is distinct from p_file_name
       or not (v_existing.options @> p_options)
       or (v_existing_asset.id is not null and (
         v_existing_asset.mime_type is distinct from p_mime_type
         or v_existing_asset.size_bytes is distinct from p_size_bytes
         or v_existing_asset.width is distinct from p_width
         or v_existing_asset.height is distinct from p_height)) then
      raise exception 'idempotency_conflict';
    end if;
    v_path := v_existing_asset.storage_path;
    return query select v_existing.id, v_existing.status, v_path,
      coalesce(v_existing.options ->> 'planCode', 'free'),
      coalesce((v_existing.options ->> 'maxFrames')::integer, 0),
      coalesce((v_existing.options ->> 'retentionDays')::integer, 0);
    return;
  end if;

  if p_project_id is not null and not exists (
    select 1 from public.projects p where p.id = p_project_id and p.user_id = p_user_id
  ) then raise exception 'project_not_found'; end if;

  select case when exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user_id
      and s.state in ('active', 'in_grace_period', 'cancelled')
      and s.current_period_end > now()
  ) then 'pro' else 'free' end into v_plan_code;
  select * into v_plan from public.plan_limits l where l.plan_code = v_plan_code and l.enabled;
  if not found then raise exception 'plan_not_configured'; end if;
  if v_plan.retention_days < 1 or p_size_bytes > v_plan.max_upload_bytes
     or p_duration_ms > v_plan.max_duration_ms or v_output_count > v_plan.max_frames then
    raise exception 'plan_limit_exceeded';
  end if;

  select coalesce(sum(u.quantity), 0) into v_used_jobs
  from public.usage_ledger u where u.user_id = p_user_id and u.usage_type = 'cloud_job'
    and u.created_at >= v_month_start;
  select coalesce(sum(u.quantity), 0) into v_used_bytes
  from public.usage_ledger u where u.user_id = p_user_id and u.usage_type = 'cloud_storage_bytes'
    and u.created_at >= v_month_start;
  if v_used_jobs + 1 > v_plan.monthly_jobs
     or v_used_bytes + p_size_bytes > v_plan.monthly_storage_bytes then
    raise exception 'monthly_quota_exceeded';
  end if;

  v_path := p_user_id::text || '/' || v_job_id::text || '/source.' ||
    case p_mime_type when 'video/mp4' then 'mp4' else 'webm' end;
  insert into public.jobs(id, user_id, project_id, kind, status, request_key, options, upload_expires_at)
  values (v_job_id, p_user_id, p_project_id, 'cloud_extract', 'awaiting_upload', p_request_key,
    p_options || jsonb_build_object('sourceName', p_file_name, 'planCode', v_plan_code,
      'maxFrames', v_plan.max_frames, 'retentionDays', v_plan.retention_days), now() + interval '2 hours')
  returning id into v_job_id;
  insert into public.assets(id, user_id, job_id, storage_path, mime_type, width, height, size_bytes, expires_at)
  values (v_asset_id, p_user_id, v_job_id, v_path, p_mime_type, p_width, p_height, p_size_bytes,
    now() + make_interval(days => v_plan.retention_days));
  update public.jobs j set input_asset_id = v_asset_id, updated_at = now() where j.id = v_job_id;
  insert into public.usage_ledger(user_id, job_id, usage_type, quantity, idempotency_key)
  values (p_user_id, v_job_id, 'cloud_job', 1, p_request_key),
    (p_user_id, v_job_id, 'cloud_storage_bytes', p_size_bytes, p_request_key);

  return query select v_job_id, 'awaiting_upload'::text, v_path, v_plan_code,
    v_plan.max_frames, v_plan.retention_days;
end;
$$;

create or replace function public.activate_cloud_job(p_user_id uuid, p_job_id uuid, p_uploaded_bytes bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_asset public.assets%rowtype;
begin
  select * into v_job from public.jobs j
  where j.id = p_job_id and j.user_id = p_user_id for update;
  if not found then raise exception 'job_not_found'; end if;
  if v_job.status = 'queued' then return 'queued'; end if;
  if v_job.status <> 'awaiting_upload' or v_job.upload_expires_at <= now() then
    raise exception 'upload_expired';
  end if;
  select * into v_asset from public.assets a where a.id = v_job.input_asset_id for update;
  if not found or p_uploaded_bytes <> v_asset.size_bytes then raise exception 'upload_size_mismatch'; end if;
  update public.jobs j set status = 'queued', available_at = now(), updated_at = now()
    where j.id = p_job_id;
  return 'queued';
end;
$$;

create or replace function public.cancel_cloud_job(p_user_id uuid, p_job_id uuid)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_paths text[];
begin
  select * into v_job from public.jobs j where j.id = p_job_id and j.user_id = p_user_id for update;
  if not found then raise exception 'job_not_found'; end if;
  if v_job.status = 'cancelled' then
    select coalesce(array_agg(a.storage_path), array[]::text[]) into v_paths from public.assets a where a.job_id = p_job_id;
    return v_paths;
  end if;
  if v_job.status = 'processing' then
    update public.jobs j set cancel_requested = true, updated_at = now() where j.id = p_job_id;
    return array[]::text[];
  end if;
  if v_job.status not in ('awaiting_upload', 'queued') then raise exception 'job_not_cancellable'; end if;
  select coalesce(array_agg(a.storage_path), array[]::text[]) into v_paths
    from public.assets a where a.job_id = p_job_id;
  update public.jobs j set status = 'cancelled', input_asset_id = null, updated_at = now()
    where j.id = p_job_id;
  return v_paths;
end;
$$;

create or replace function public.finalize_cancelled_cloud_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs j where j.id = p_job_id and j.status = 'cancelled' for update;
  if not found then raise exception 'job_not_cancelled'; end if;
  if v_job.upload_expires_at > now() then raise exception 'upload_token_still_valid'; end if;
  delete from public.usage_ledger u where u.job_id = p_job_id and u.usage_type in ('cloud_job', 'cloud_storage_bytes');
  delete from public.assets a where a.job_id = p_job_id;
end;
$$;

create or replace function public.delete_cloud_job(p_user_id uuid, p_job_id uuid)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_paths text[];
begin
  select * into v_job from public.jobs j where j.id = p_job_id and j.user_id = p_user_id for update;
  if not found then raise exception 'job_not_found'; end if;
  if v_job.status = 'deleting' then
    select coalesce(array_agg(a.storage_path), array[]::text[]) into v_paths from public.assets a where a.job_id = p_job_id;
    return v_paths;
  end if;
  if v_job.status in ('processing', 'awaiting_upload', 'queued') then raise exception 'job_busy'; end if;
  select coalesce(array_agg(a.storage_path), array[]::text[]) into v_paths
    from public.assets a where a.job_id = p_job_id;
  update public.jobs j set status = 'deleting', updated_at = now() where j.id = p_job_id;
  return v_paths;
end;
$$;

create or replace function public.finalize_deleted_cloud_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs j where j.id = p_job_id and j.status = 'deleting' for update;
  if not found then raise exception 'job_not_deleting'; end if;
  if v_job.upload_expires_at > now() then raise exception 'upload_token_still_valid'; end if;
  delete from public.usage_ledger u where u.job_id = p_job_id and u.usage_type = 'cloud_storage_bytes';
  delete from public.assets a where a.job_id = p_job_id;
  delete from public.jobs j where j.id = p_job_id;
end;
$$;

create or replace function public.claim_cloud_job()
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  with cancelled as (
    update public.jobs j set status = 'cancelled', completed_at = now(), locked_at = null,
      updated_at = now()
    where j.status = 'processing' and j.cancel_requested
      and j.locked_at < now() - interval '15 minutes'
    returning j.id
  )
  delete from public.usage_ledger u where u.job_id in (select c.id from cancelled c)
    and u.usage_type in ('cloud_job', 'cloud_storage_bytes');
  with failed as (
    update public.jobs j set status = 'failed', completed_at = now(), locked_at = null,
      updated_at = now(), error_code = 'worker_attempts_exhausted'
    where j.status = 'processing' and j.attempts >= 3
      and j.locked_at < now() - interval '15 minutes'
    returning j.id
  )
  delete from public.usage_ledger u where u.job_id in (select f.id from failed f)
    and u.usage_type in ('cloud_job', 'cloud_storage_bytes');
  return query
  with candidate as (
    select j.id from public.jobs j
    where (j.status = 'queued' and j.available_at <= now())
       or (j.status = 'processing' and not j.cancel_requested and j.attempts < 3
           and j.locked_at < now() - interval '15 minutes')
    order by j.created_at
    for update skip locked
    limit 1
  ), claimed as (
    update public.jobs j set status = 'processing', attempts = j.attempts + 1,
      locked_at = now(), updated_at = now()
    from candidate c where j.id = c.id returning j.*
  ) select * from claimed;
end;
$$;

create or replace function public.complete_cloud_job(p_job_id uuid, p_output_assets jsonb, p_attempt integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_asset jsonb;
  v_count integer := 0;
  v_output_bytes bigint;
  v_used_bytes bigint;
  v_limit bigint;
  v_prefix text;
begin
  select * into v_job from public.jobs j where j.id = p_job_id and j.status = 'processing'
    and j.attempts = p_attempt for update;
  if not found then raise exception 'job_not_processing'; end if;
  if v_job.cancel_requested then raise exception 'cancelled'; end if;
  if jsonb_typeof(p_output_assets) <> 'array' or jsonb_array_length(p_output_assets) < 1
     or jsonb_array_length(p_output_assets) > (v_job.options ->> 'maxFrames')::integer then
    raise exception 'invalid_outputs';
  end if;
  select coalesce(sum((item ->> 'size_bytes')::bigint), 0) into v_output_bytes
    from jsonb_array_elements(p_output_assets) as elements(item);
  select l.monthly_storage_bytes into v_limit from public.plan_limits l
    where l.plan_code = v_job.options ->> 'planCode' and l.enabled;
  if not found then raise exception 'plan_not_configured'; end if;
  select coalesce(sum(u.quantity), 0) into v_used_bytes from public.usage_ledger u
    where u.user_id = v_job.user_id and u.usage_type = 'cloud_storage_bytes'
      and u.created_at >= date_trunc('month', now());
  if v_used_bytes + v_output_bytes > v_limit then raise exception 'monthly_storage_quota_exceeded'; end if;
  v_prefix := v_job.user_id::text || '/' || v_job.id::text || '/';
  for v_asset in select value from jsonb_array_elements(p_output_assets) loop
    if v_asset ->> 'storage_path' not like v_prefix || 'frame-%'
       or v_asset ->> 'mime_type' <> 'image/png'
       or coalesce((v_asset ->> 'size_bytes')::bigint, 0) < 1
       or coalesce((v_asset ->> 'width')::integer, 0) < 1
       or coalesce((v_asset ->> 'height')::integer, 0) < 1 then
      raise exception 'invalid_output_asset';
    end if;
    insert into public.assets(user_id, job_id, storage_path, mime_type, width, height, size_bytes, sha256, expires_at)
    values (v_job.user_id, v_job.id, v_asset ->> 'storage_path', 'image/png',
      (v_asset ->> 'width')::integer, (v_asset ->> 'height')::integer,
      (v_asset ->> 'size_bytes')::bigint, v_asset ->> 'sha256',
      now() + make_interval(days => (v_job.options ->> 'retentionDays')::integer));
    v_count := v_count + 1;
  end loop;
  update public.jobs j set status = 'completed', output_count = v_count,
    completed_at = now(), locked_at = null, updated_at = now(), error_code = null
    where j.id = p_job_id;
  update public.usage_ledger u set quantity = u.quantity + v_output_bytes
    where u.job_id = p_job_id and u.usage_type = 'cloud_storage_bytes';
end;
$$;

create or replace function public.fail_cloud_job(p_job_id uuid, p_retryable boolean, p_error_code text, p_attempt integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_next text;
begin
  select * into v_job from public.jobs j where j.id = p_job_id and j.status = 'processing'
    and j.attempts = p_attempt for update;
  if not found then return 'ignored'; end if;
  if v_job.cancel_requested or p_error_code = 'cancelled' then
    update public.jobs j set status = 'cancelled', locked_at = null, completed_at = now(), updated_at = now()
      where j.id = p_job_id;
    delete from public.usage_ledger u where u.job_id = p_job_id and u.usage_type in ('cloud_job', 'cloud_storage_bytes');
    v_next := 'cancelled';
  elsif p_retryable and v_job.attempts < 3 then
    update public.jobs j set status = 'queued', available_at = now() + make_interval(mins => v_job.attempts * 2),
      locked_at = null, updated_at = now(), error_code = case
        when coalesce(p_error_code, '') ~ '^[a-z0-9_]{1,80}$' then p_error_code else 'worker_retry' end
      where j.id = p_job_id;
    v_next := 'queued';
  else
    update public.jobs j set status = 'failed', locked_at = null, completed_at = now(), updated_at = now(),
      error_code = case when coalesce(p_error_code, '') ~ '^[a-z0-9_]{1,80}$' then p_error_code else 'processing_failed' end
      where j.id = p_job_id;
    delete from public.usage_ledger u where u.job_id = p_job_id and u.usage_type in ('cloud_job', 'cloud_storage_bytes');
    v_next := 'failed';
  end if;
  return v_next;
end;
$$;

revoke all on function public.reserve_cloud_extract_job(uuid, uuid, text, text, bigint, bigint, integer, integer, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.request_account_deletion(uuid) from public, anon, authenticated;
revoke all on function public.activate_cloud_job(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.cancel_cloud_job(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_cancelled_cloud_job(uuid) from public, anon, authenticated;
revoke all on function public.delete_cloud_job(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_deleted_cloud_job(uuid) from public, anon, authenticated;
revoke all on function public.claim_cloud_job() from public, anon, authenticated;
revoke all on function public.complete_cloud_job(uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.fail_cloud_job(uuid, boolean, text, integer) from public, anon, authenticated;
grant execute on function public.reserve_cloud_extract_job(uuid, uuid, text, text, bigint, bigint, integer, integer, jsonb, uuid) to service_role;
grant execute on function public.request_account_deletion(uuid) to service_role;
grant execute on function public.activate_cloud_job(uuid, uuid, bigint) to service_role;
grant execute on function public.cancel_cloud_job(uuid, uuid) to service_role;
grant execute on function public.finalize_cancelled_cloud_job(uuid) to service_role;
grant execute on function public.delete_cloud_job(uuid, uuid) to service_role;
grant execute on function public.finalize_deleted_cloud_job(uuid) to service_role;
grant execute on function public.claim_cloud_job() to service_role;
grant execute on function public.complete_cloud_job(uuid, jsonb, integer) to service_role;
grant execute on function public.fail_cloud_job(uuid, boolean, text, integer) to service_role;
