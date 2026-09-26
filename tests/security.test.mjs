import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = await readFile(new URL('../supabase/migrations/20260926140000_initial_schema.sql', import.meta.url), 'utf8');
const cloudMigration = await readFile(new URL('../supabase/migrations/20260926150000_cloud_processing.sql', import.meta.url), 'utf8');

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create schema storage;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create table storage.buckets (
    id text primary key, name text not null, public boolean not null default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (bucket_id text not null references storage.buckets(id), name text not null);
  alter table storage.objects enable row level security;
  create function storage.foldername(path text) returns text[] language sql immutable as $$
    select string_to_array(path, '/')
  $$;
  grant usage on schema storage to authenticated;
  grant select, delete on storage.objects to authenticated;
`);

await db.exec(migration);
await db.exec(cloudMigration);

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const ownerProject = '00000000-0000-4000-8000-000000000010';
const otherProject = '00000000-0000-4000-8000-000000000011';
await db.query('insert into auth.users (id, raw_user_meta_data) values ($1, $2)', [owner, { display_name: 'Owner' }]);
await db.query('insert into auth.users (id, raw_user_meta_data) values ($1, $2)', [other, { display_name: 'Other' }]);
await db.query("insert into public.subscriptions(user_id, provider, product_id, state, current_period_end) values ($1, 'google_play', 'pro-month', 'active', now() + interval '30 days')", [owner]);
await db.query(`insert into public.plan_limits(plan_code, enabled, monthly_jobs, monthly_storage_bytes, max_upload_bytes, max_duration_ms, max_frames, retention_days)
  values ('free', true, 1, 100000, 5000000, 600000, 100, 3), ('pro', true, 1, 100000, 5000000, 600000, 100, 3)`);
await db.query('insert into storage.objects(bucket_id, name) values ($1, $2)', ['jeda-private', `${owner}/frame.png`]);

await db.exec('set role authenticated');
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
await assert.rejects(db.query('select * from public.plan_limits'), /permission denied/i, 'clients cannot read or edit internal plan limits');
const ownProfile = await db.query('select display_name from public.profiles');
assert.deepEqual(ownProfile.rows, [{ display_name: 'Owner' }], 'auth trigger creates a visible profile for its owner');
await db.query('insert into public.projects(id, user_id, name) values ($1, $2, $3)', [ownerProject, owner, 'Proyek saya']);
await db.query(`insert into public.local_exports(user_id, file_name, source_time_ms, width, height, output_format)
  values ($1, 'frame.png', 1000, 1280, 720, 'png')`, [owner]);
assert.equal((await db.query('select count(*)::int as count from public.projects')).rows[0].count, 1);
assert.equal((await db.query('select count(*)::int as count from storage.objects')).rows[0].count, 1);
await assert.rejects(
  db.query('insert into public.jobs(user_id, kind, request_key) values ($1, $2, $3)', [owner, 'cloud_upscale', '00000000-0000-4000-8000-000000000003']),
  /permission denied/i,
  'clients cannot bypass cloud job creation and its entitlement checks',
);
await assert.rejects(
  db.query("insert into public.subscriptions(user_id, provider, product_id, state) values ($1, 'google_play', 'pro-year', 'active')", [owner]),
  /permission denied/i,
  'clients cannot grant themselves a subscription',
);

await db.query("select set_config('request.jwt.claim.sub', $1, false)", [other]);
assert.equal((await db.query('select count(*)::int as count from public.projects')).rows[0].count, 0);
assert.equal((await db.query('select count(*)::int as count from public.local_exports')).rows[0].count, 0);
assert.equal((await db.query('select count(*)::int as count from public.subscriptions')).rows[0].count, 0);
assert.equal((await db.query('select count(*)::int as count from storage.objects')).rows[0].count, 0);
await assert.rejects(
  db.query('insert into public.projects(user_id, name) values ($1, $2)', [owner, 'Bukan proyek saya']),
  /row-level security/i,
  'RLS rejects writes under another user id',
);
await assert.rejects(
  db.query(`insert into public.local_exports(user_id, project_id, file_name, source_time_ms, width, height, output_format)
    values ($1, $2, 'lintas-akun.png', 0, 1, 1, 'png')`, [other, ownerProject]),
  /row-level security/i,
  'RLS prevents linking an export to another user project',
);

await assert.rejects(
  db.query(`select * from public.reserve_cloud_extract_job($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    owner, '00000000-0000-4000-8000-000000000003', 'video.mp4', 'video/mp4', 2048, 10000, 1920, 1080,
    { startMs: 0, endMs: 5000, intervalMs: 1000, expectedCount: 6 },
  ]),
  /permission denied/i,
  'clients cannot reserve cloud jobs without the server boundary',
);

await db.exec('reset role');
await db.query('insert into public.projects(id, user_id, name) values ($1, $2, $3)', [otherProject, other, 'Proyek akun lain']);
await db.exec('set role service_role');
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
const ownerKey = '00000000-0000-4000-8000-000000000003';
const jobArgs = [owner, ownerKey, 'video.mp4', 'video/mp4', 2048, 10000, 1920, 1080,
  { startMs: 0, endMs: 5000, intervalMs: 1000, expectedCount: 6 }, ownerProject];
const reserveWithProject = 'select * from public.reserve_cloud_extract_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)';
await assert.rejects(db.query(reserveWithProject, [...jobArgs.slice(0, 9), otherProject]), /project_not_found/i,
  'cloud jobs cannot be assigned to another account project');
const reserved = await db.query(reserveWithProject, jobArgs);
const jobId = reserved.rows[0].job_id;
assert.equal(reserved.rows[0].status, 'awaiting_upload');
assert.ok(reserved.rows[0].storage_path.startsWith(`${owner}/${jobId}/`));
await db.exec('reset role');
assert.equal((await db.query('select project_id from public.jobs where id=$1', [jobId])).rows[0].project_id, ownerProject);
await db.exec('set role service_role');
assert.equal((await db.query(reserveWithProject, jobArgs)).rows[0].job_id, jobId,
  'repeating a request key returns the same job without duplicate usage');
await assert.rejects(db.query(reserveWithProject, [...jobArgs.slice(0, 9), null]), /idempotency_conflict/i,
  'reusing a key for a different project fails instead of silently returning the old job');
await assert.rejects(
  db.query(reserveWithProject, [
    owner, '00000000-0000-4000-8000-000000000004', ...jobArgs.slice(2),
  ]),
  /monthly_quota_exceeded/i,
  'server reservation enforces the monthly job cap atomically',
);
await assert.rejects(db.query('select public.activate_cloud_job($1,$2,$3)', [owner, jobId, 1024]), /upload_size_mismatch/i);
assert.equal((await db.query('select public.activate_cloud_job($1,$2,$3)', [owner, jobId, 2048])).rows[0].activate_cloud_job, 'queued');
const claimed = await db.query('select * from public.claim_cloud_job()');
assert.equal(claimed.rows[0].id, jobId);
assert.equal(claimed.rows[0].attempts, 1);
assert.equal((await db.query('select public.fail_cloud_job($1,$2,$3,$4)', [jobId, true, 'stale_worker', 0])).rows[0].fail_cloud_job, 'ignored',
  'an old worker attempt cannot fail a newer lease');
await assert.rejects(db.query('select public.complete_cloud_job($1,$2,$3)', [jobId, [], 0]), /job_not_processing/i,
  'an old worker attempt cannot complete a newer lease');
await db.query('select public.complete_cloud_job($1,$2,$3)', [jobId, [{
  storage_path: `${owner}/${jobId}/frame-0001.png`, mime_type: 'image/png', width: 1920,
  height: 1080, size_bytes: 500, sha256: 'a'.repeat(64),
}], 1]);
await db.exec('reset role');
await db.exec('set role authenticated');
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
const completed = await db.query('select status,output_count from public.jobs where id=$1', [jobId]);
assert.deepEqual(completed.rows, [{ status: 'completed', output_count: 1 }]);
await db.exec('reset role');
await db.query("update public.jobs set upload_expires_at = now() - interval '1 second' where id=$1", [jobId]);
await db.exec('set role service_role');
const deletePaths = await db.query('select public.delete_cloud_job($1,$2)', [owner, jobId]);
assert.equal(deletePaths.rows[0].delete_cloud_job.length, 2, 'job deletion returns input and output objects for cleanup');
await db.query('select public.finalize_deleted_cloud_job($1)', [jobId]);
await db.exec('reset role');
await db.exec('set role authenticated');
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
assert.equal((await db.query("select coalesce(sum(quantity),0)::int as jobs from public.usage_ledger where user_id=$1 and usage_type='cloud_job'", [owner])).rows[0].jobs, 1,
  'deleting result files does not erase the already-used monthly job quota');
assert.equal((await db.query("select count(*)::int as count from public.usage_ledger where user_id=$1 and usage_type='cloud_storage_bytes'", [owner])).rows[0].count, 0);

await db.exec('reset role');
await db.exec('set role service_role');
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [other]);
const otherArgs = [other, '00000000-0000-4000-8000-000000000005', 'video.webm', 'video/webm', 512, 10000, 640, 360,
  { startMs: 0, endMs: 1000, intervalMs: 1000, expectedCount: 2 }];
const otherJob = (await db.query(`select * from public.reserve_cloud_extract_job($1,$2,$3,$4,$5,$6,$7,$8,$9)`, otherArgs)).rows[0].job_id;
await db.query('select public.activate_cloud_job($1,$2,$3)', [other, otherJob, 512]);
await db.query('select * from public.claim_cloud_job()');
await db.query('select public.cancel_cloud_job($1,$2)', [other, otherJob]);
assert.equal((await db.query('select public.fail_cloud_job($1,$2,$3,$4)', [otherJob, false, 'cancelled', 1])).rows[0].fail_cloud_job, 'cancelled');
await assert.rejects(db.query('select public.finalize_cancelled_cloud_job($1)', [otherJob]), /upload_token_still_valid/i,
  'cancelled uploads remain reserved while their signed upload token can still recreate the object');
await db.exec('reset role');
await db.query("update public.jobs set upload_expires_at = now() - interval '1 second' where id=$1", [otherJob]);
await db.exec('set role service_role');
await db.query('select public.finalize_cancelled_cloud_job($1)', [otherJob]);
await db.exec('reset role');
await db.exec('set role authenticated');
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [other]);
assert.equal((await db.query("select count(*)::int as count from public.usage_ledger where usage_type='cloud_job' and user_id=$1", [other])).rows[0].count, 0,
  'cancelling a processing job stops future work and refunds its reservation');
await db.exec('reset role');
await db.exec('set role service_role');
await db.query(`select * from public.reserve_cloud_extract_job($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
  other, '00000000-0000-4000-8000-000000000006', ...otherArgs.slice(2),
]);
const deleteAfter = await db.query('select public.request_account_deletion($1) as delete_after', [other]);
assert.ok(Date.parse(deleteAfter.rows[0].delete_after) > Date.now() + 60 * 60 * 1000,
  'account deletion waits for outstanding two-hour signed upload capabilities');
await assert.rejects(
  db.query(`select * from public.reserve_cloud_extract_job($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    other, '00000000-0000-4000-8000-000000000006', ...otherArgs.slice(2),
  ]),
  /account_deletion_pending/i,
  'new cloud jobs stop as soon as account deletion is requested',
);

await db.close();
console.log('Database RLS, cloud job, quota, cancellation, and account deletion checks passed.');
