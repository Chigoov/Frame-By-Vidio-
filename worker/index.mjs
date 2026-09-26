import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const exec = promisify(execFile);
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diatur di worker.');
const pollMs = Math.max(1000, Number(process.env.JEDA_WORKER_POLL_MS) || 3000);
const maxVideoBytes = 50 * 1024 * 1024;
const maxDurationMs = 10 * 60 * 1000;
const maxFrames = 100;
const maxFrameBytes = 50 * 1024 * 1024;
const maxOutputBytes = 250 * 1024 * 1024;
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
let lastBackendCheck = 0;
createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.statusCode = request.url === '/healthz' && Date.now() - lastBackendCheck < 30_000 ? 200 : 503;
  response.end(JSON.stringify({ healthy: response.statusCode === 200 }));
}).listen(8080, '127.0.0.1');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const problem = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });

async function ffprobe(file) {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', file], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout);
    const video = data.streams?.find((stream) => stream.codec_type === 'video');
    const durationMs = Math.round(Number(data.format?.duration) * 1000);
    if (!video || !Number.isFinite(durationMs) || durationMs < 1 || durationMs > maxDurationMs
      || !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width * video.height > 40_000_000) {
      throw problem('video_limits_exceeded');
    }
    return { durationMs, width: video.width, height: video.height };
  } catch (error) {
    if (error.code) throw error;
    throw problem('invalid_video');
  }
}

async function processJob(job) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jeda-'));
  const uploadedOutputs = [];
  let sourcePath;
  const controller = new AbortController();
  let heartbeatBusy = false;
  let lastLease = Date.now();
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void (async () => {
      try {
        const { data, error } = await supabase.from('jobs').select('status,cancel_requested,attempts').eq('id', job.id).maybeSingle();
        if (error || !data || data.cancel_requested || data.status !== 'processing' || data.attempts !== job.attempts) controller.abort();
        else if (Date.now() - lastLease >= 60_000) {
          const now = new Date().toISOString();
          const { data: lease, error: leaseError } = await supabase.from('jobs')
            .update({ locked_at: now, updated_at: now }).eq('id', job.id)
            .eq('status', 'processing').eq('attempts', job.attempts).select('id').maybeSingle();
          if (leaseError || !lease) controller.abort();
          else lastLease = Date.now();
        } else lastBackendCheck = Date.now();
      } finally { heartbeatBusy = false; }
    })().catch(() => {});
  }, 5000);
  heartbeat.unref?.();
  try {
    const { data: sourceAsset, error: sourceError } = await supabase.from('assets')
      .select('storage_path,mime_type,size_bytes').eq('id', job.input_asset_id).eq('job_id', job.id).single();
    if (sourceError || !sourceAsset || !['video/mp4', 'video/webm'].includes(sourceAsset.mime_type)) throw problem('source_asset_missing');
    if (sourceAsset.size_bytes > maxVideoBytes) throw problem('video_too_large');
    const folder = `${job.user_id}/${job.id}`;
    const { data: previousFiles, error: previousError } = await supabase.storage.from('jeda-private').list(folder, { limit: 150 });
    if (previousError) throw problem('storage_list_failed', true);
    const staleOutputs = (previousFiles ?? []).filter((item) => /^frame-\d{4}\.png$/.test(item.name)).map((item) => `${folder}/${item.name}`);
    if (staleOutputs.length) {
      const { error } = await supabase.storage.from('jeda-private').remove(staleOutputs);
      if (error) throw problem('storage_cleanup_failed', true);
    }
    sourcePath = path.join(directory, sourceAsset.mime_type === 'video/webm' ? 'source.webm' : 'source.mp4');
    const { data: blob, error: downloadError } = await supabase.storage.from('jeda-private').download(sourceAsset.storage_path);
    if (downloadError || !blob) throw problem('storage_download_failed', true);
    if (blob.size !== sourceAsset.size_bytes || blob.size > maxVideoBytes) throw problem('source_size_mismatch');
    await writeFile(sourcePath, Buffer.from(await blob.arrayBuffer()));

    const video = await ffprobe(sourcePath);
    const options = job.options ?? {};
    const { startMs, endMs, intervalMs, expectedCount } = options;
    const count = Math.floor((endMs - startMs) / intervalMs) + 1;
    if (![startMs, endMs, intervalMs, expectedCount].every(Number.isFinite) || startMs < 0 || endMs <= startMs
      || endMs > video.durationMs || intervalMs < 100 || intervalMs > 10000 || count < 1 || count > maxFrames || count !== expectedCount) {
      throw problem('invalid_job_options');
    }
    const outputPattern = path.join(directory, 'frame-%04d.png');
    const seconds = (value) => (value / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    try {
      await exec('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', seconds(startMs), '-i', sourcePath,
        // ponytail: read one interval beyond the end target so ffmpeg can emit that final frame.
        '-t', seconds(endMs - startMs + intervalMs), '-vf', `fps=1/${seconds(intervalMs)}:start_time=0`, '-frames:v', String(expectedCount),
        '-fps_mode', 'passthrough', outputPattern,
      ], { timeout: 5 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, signal: controller.signal });
    } catch { throw problem(controller.signal.aborted ? 'cancelled' : 'frame_extraction_failed'); }
    const frames = (await readdir(directory)).filter((name) => /^frame-\d{4}\.png$/.test(name)).sort();
    if (!frames.length || frames.length > expectedCount) throw problem('no_frames_extracted');

    let totalOutputBytes = 0;
    for (let index = 0; index < frames.length; index++) {
      if (controller.signal.aborted) throw problem('cancelled');
      const filename = frames[index];
      const localPath = path.join(directory, filename);
      const bytes = await readFile(localPath);
      if (bytes.length > maxFrameBytes) throw problem('frame_too_large');
      totalOutputBytes += bytes.length;
      if (totalOutputBytes > maxOutputBytes) throw problem('job_output_too_large');
      const dimensions = await ffprobeImage(localPath);
      if (dimensions.width * dimensions.height > 40_000_000 || dimensions.width > 8192 || dimensions.height > 8192) {
        throw problem('output_dimensions_exceeded');
      }
      const storagePath = `${job.user_id}/${job.id}/${filename}`;
      const { error: uploadError } = await supabase.storage.from('jeda-private').upload(storagePath, bytes, {
        contentType: 'image/png', cacheControl: '3600', upsert: false,
      });
      if (uploadError) throw problem('output_upload_failed', true);
      uploadedOutputs.push(storagePath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      uploadedOutputs[uploadedOutputs.length - 1] = {
        storage_path: storagePath, mime_type: 'image/png', width: dimensions.width,
        height: dimensions.height, size_bytes: bytes.length, sha256: digest,
      };
    }
    if (controller.signal.aborted) throw problem('cancelled');
    const { error: completeError } = await supabase.rpc('complete_cloud_job', {
      p_job_id: job.id, p_output_assets: uploadedOutputs, p_attempt: job.attempts,
    });
    if (completeError) {
      const code = completeError.message?.includes('monthly_storage_quota_exceeded') ? 'monthly_storage_quota_exceeded'
        : completeError.message?.includes('cancelled') ? 'cancelled'
          : completeError.message?.includes('plan_not_configured') ? 'plan_not_configured' : 'job_completion_failed';
      throw problem(code, ['monthly_storage_quota_exceeded', 'cancelled', 'plan_not_configured'].includes(code) ? false : true);
    }
    console.info(JSON.stringify({ event: 'job_completed', jobId: job.id, outputCount: uploadedOutputs.length }));
  } catch (error) {
    const code = controller.signal.aborted ? 'cancelled'
      : typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : 'worker_error';
    const { data: nextState, error: failError } = await supabase.rpc('fail_cloud_job', {
      p_job_id: job.id, p_retryable: Boolean(error?.retryable), p_error_code: code, p_attempt: job.attempts,
    });
    if (!failError && nextState !== 'ignored') {
      const outputPaths = uploadedOutputs.map((item) => typeof item === 'string' ? item : item.storage_path);
      if (outputPaths.length) await supabase.storage.from('jeda-private').remove(outputPaths);
    }
    console.error(JSON.stringify({ event: 'job_failed', jobId: job.id, code, retryable: Boolean(error?.retryable), nextState, failError: Boolean(failError) }));
  } finally {
    clearInterval(heartbeat);
    await rm(directory, { recursive: true, force: true });
  }
}

async function ffprobeImage(file) {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const stream = JSON.parse(stdout).streams?.[0];
    if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height)) throw problem('output_invalid');
    return { width: stream.width, height: stream.height };
  } catch (error) {
    if (error.code) throw error;
    throw problem('output_invalid');
  }
}

async function cleanExpiredAssets() {
  const { data: expired, error } = await supabase.from('assets').select('id,job_id,storage_path')
    .not('expires_at', 'is', null).lte('expires_at', new Date().toISOString()).limit(100);
  if (error || !expired?.length) return;
  const eligible = [];
  for (const asset of expired) {
    if (!asset.job_id) { eligible.push(asset); continue; }
    const { data: job } = await supabase.from('jobs').select('status').eq('id', asset.job_id).maybeSingle();
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) eligible.push(asset);
  }
  if (!eligible.length) return;
  const { error: removeError } = await supabase.storage.from('jeda-private').remove(eligible.map((asset) => asset.storage_path));
  if (removeError) return;
  await supabase.from('assets').delete().in('id', eligible.map((asset) => asset.id));
}

async function cleanAbandonedUploads() {
  const { data: jobs, error } = await supabase.from('jobs').select('id,user_id')
    .eq('status', 'awaiting_upload').lt('upload_expires_at', new Date().toISOString()).limit(50);
  if (error || !jobs?.length) return;
  for (const job of jobs) {
    await supabase.rpc('cancel_cloud_job', { p_user_id: job.user_id, p_job_id: job.id });
  }
}

async function cleanPendingDeletions() {
  const { data: jobs, error } = await supabase.from('jobs').select('id,user_id,status,upload_expires_at')
    .in('status', ['cancelled', 'deleting']).limit(50);
  if (error || !jobs?.length) return;
  for (const job of jobs) {
    if (job.upload_expires_at && Date.parse(job.upload_expires_at) > Date.now()) continue;
    try { await removeStoragePrefix(`${job.user_id}/${job.id}`); }
    catch { continue; }
    const functionName = job.status === 'cancelled' ? 'finalize_cancelled_cloud_job' : 'finalize_deleted_cloud_job';
    await supabase.rpc(functionName, { p_job_id: job.id });
  }
}

async function removeStoragePrefix(prefix) {
  for (;;) {
    const { data, error } = await supabase.storage.from('jeda-private').list(prefix, { limit: 500, offset: 0 });
    if (error) throw problem('storage_cleanup_failed', true);
    if (!data?.length) return;
    const folders = data.filter((item) => item.id === null).map((item) => `${prefix}/${item.name}`);
    const files = data.filter((item) => item.id !== null).map((item) => `${prefix}/${item.name}`);
    for (const folder of folders) await removeStoragePrefix(folder);
    if (files.length) {
      const { error: removeError } = await supabase.storage.from('jeda-private').remove(files);
      if (removeError) throw problem('storage_cleanup_failed', true);
    }
    if (!folders.length && !files.length) return;
  }
}

async function processAccountDeletions() {
  const { data: requests, error } = await supabase.from('account_deletion_requests')
    .select('user_id,delete_after').lte('delete_after', new Date().toISOString()).limit(10);
  if (error || !requests?.length) return;
  for (const request of requests) {
    const { data: jobs, error: jobsError } = await supabase.from('jobs').select('id,status').eq('user_id', request.user_id);
    if (jobsError) continue;
    let active = false;
    for (const job of jobs ?? []) {
      if (job.status === 'processing') {
        await supabase.rpc('cancel_cloud_job', { p_user_id: request.user_id, p_job_id: job.id });
        active = true;
      } else if (job.status === 'awaiting_upload' || job.status === 'queued') {
        await supabase.rpc('cancel_cloud_job', { p_user_id: request.user_id, p_job_id: job.id });
      }
    }
    if (active) continue;
    try { await removeStoragePrefix(request.user_id); }
    catch { continue; }
    const { error: deleteError } = await supabase.auth.admin.deleteUser(request.user_id);
    if (!deleteError) console.info(JSON.stringify({ event: 'account_deleted' }));
  }
}

console.info(JSON.stringify({ event: 'worker_started', pollMs }));
for (;;) {
  await cleanExpiredAssets();
  await cleanAbandonedUploads();
  await cleanPendingDeletions();
  await processAccountDeletions();
  const { data: jobs, error } = await supabase.rpc('claim_cloud_job');
  if (error) {
    console.error(JSON.stringify({ event: 'queue_read_failed' }));
    await sleep(pollMs);
    continue;
  }
  lastBackendCheck = Date.now();
  if (!jobs?.length) { await sleep(pollMs); continue; }
  await processJob(jobs[0]);
}
