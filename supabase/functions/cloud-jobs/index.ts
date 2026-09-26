import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...cors, 'Cache-Control': 'no-store' } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxUploadBytes = 50 * 1024 * 1024;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method tidak didukung.' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Permintaan tidak valid.' }, 400); }
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Sesi akun diperlukan.' }, 401);
  const url = Deno.env.get('SUPABASE_URL');
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publicKey || !serviceKey) return json({ error: 'Konfigurasi backend belum lengkap.' }, 503);

  const userClient = createClient(url, publicKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) return json({ error: 'Sesi akun tidak valid.' }, 401);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  if (body?.action === 'summary') {
    const [subscriptionResult, deletionResult] = await Promise.all([
      admin.from('subscriptions').select('state,current_period_end').eq('user_id', auth.user.id).maybeSingle(),
      admin.from('account_deletion_requests').select('delete_after').eq('user_id', auth.user.id).maybeSingle(),
    ]);
    if (subscriptionResult.error || deletionResult.error) return json({ error: 'Status akun belum dapat dibaca.' }, 500);
    const periodEnd = subscriptionResult.data?.current_period_end;
    const planCode = periodEnd && Date.parse(periodEnd) > Date.now()
      && ['active', 'in_grace_period', 'cancelled'].includes(subscriptionResult.data.state) ? 'pro' : 'free';
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const [planResult, usageResult] = await Promise.all([
      admin.from('plan_limits').select('enabled,monthly_jobs,monthly_storage_bytes,max_upload_bytes,max_duration_ms,max_frames,retention_days')
        .eq('plan_code', planCode).maybeSingle(),
      admin.from('usage_ledger').select('usage_type,quantity').eq('user_id', auth.user.id)
        .gte('created_at', monthStart).limit(2000),
    ]);
    if (planResult.error || usageResult.error) return json({ error: 'Pemakaian cloud belum dapat dibaca.' }, 500);
    const used = (usageResult.data ?? []).reduce((totals, row) => {
      if (row.usage_type === 'cloud_job') totals.jobs += row.quantity;
      if (row.usage_type === 'cloud_storage_bytes') totals.storageBytes += row.quantity;
      return totals;
    }, { jobs: 0, storageBytes: 0 });
    return json({ planCode, subscription: subscriptionResult.data, plan: planResult.data, used, deletionRequest: deletionResult.data });
  }

  if (body?.action === 'create') {
    const input = body.video;
    const range = body.range;
    const fileName = typeof input?.fileName === 'string' ? input.fileName.replace(/[\u0000-\u001f]/g, '').slice(0, 160) : '';
    const mimeType = input?.mimeType;
    const sizeBytes = Number(input?.sizeBytes);
    const durationMs = Number(input?.durationMs);
    const width = Number(input?.width);
    const height = Number(input?.height);
    const startMs = Number(range?.startMs);
    const endMs = Number(range?.endMs);
    const intervalMs = Number(range?.intervalMs);
    const expectedCount = Math.floor((endMs - startMs) / intervalMs) + 1;
    const requestKey = body?.requestKey;
    const projectId = body?.projectId ?? null;
    if (body?.consent !== true) return json({ error: 'Setujui pengunggahan video untuk pekerjaan cloud ini terlebih dahulu.' }, 400);
    if (!uuid.test(requestKey ?? '') || (projectId !== null && !uuid.test(projectId)) || !fileName || !['video/mp4', 'video/webm'].includes(mimeType)
        || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxUploadBytes
        || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 10 * 60 * 1000
        || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
        || !Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(intervalMs)
        || startMs < 0 || endMs <= startMs || endMs > durationMs || intervalMs < 100 || intervalMs > 10000
        || !Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 100) {
      return json({ error: 'Video atau rentang ekstraksi melewati batas teknis cloud.' }, 400);
    }
    const options = { startMs, endMs, intervalMs, expectedCount, sourceDurationMs: durationMs, sourceWidth: width, sourceHeight: height };
    const { data: reservations, error } = await admin.rpc('reserve_cloud_extract_job', {
      p_user_id: auth.user.id, p_request_key: requestKey, p_file_name: fileName, p_mime_type: mimeType,
      p_size_bytes: sizeBytes, p_duration_ms: durationMs, p_width: width, p_height: height, p_options: options,
      p_project_id: projectId,
    });
    if (error) {
      const message = error.message ?? '';
      if (message.includes('account_deletion_pending')) return json({ error: 'Akun sedang menunggu penghapusan; pekerjaan cloud baru dinonaktifkan.' }, 409);
      if (message.includes('plan_not_configured')) return json({ error: 'Kuota cloud belum disiapkan oleh pemilik layanan.' }, 503);
      if (message.includes('monthly_quota_exceeded')) return json({ error: 'Kuota pekerjaan cloud bulan ini sudah habis.' }, 429);
      if (message.includes('plan_limit_exceeded')) return json({ error: 'Video atau jumlah foto melewati batas paket akun.' }, 413);
      if (message.includes('account_not_found')) return json({ error: 'Akun tidak ditemukan.' }, 404);
      if (message.includes('project_not_found')) return json({ error: 'Proyek tidak ditemukan dalam akun ini.' }, 404);
      if (message.includes('idempotency_conflict')) return json({ error: 'Kunci permintaan sudah dipakai untuk video atau proyek berbeda.' }, 409);
      return json({ error: 'Pekerjaan cloud belum dapat dibuat.' }, 400);
    }
    const job = reservations?.[0];
    if (!job) return json({ error: 'Pekerjaan cloud belum dapat dibuat.' }, 500);
    if (job.status !== 'awaiting_upload') return json({ jobId: job.job_id, status: job.status, reused: true });
    const uploadExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000 + 5 * 60 * 1000);
    const { data: uploadReservation, error: reservationError } = await admin.from('jobs')
      .update({ upload_expires_at: uploadExpiresAt.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', job.job_id).eq('user_id', auth.user.id).eq('status', 'awaiting_upload').select('id').maybeSingle();
    if (reservationError || !uploadReservation) return json({ error: 'Pekerjaan tidak lagi menunggu unggahan.' }, 409);
    const { data: signedUpload, error: signError } = await admin.storage.from('jeda-private')
      .createSignedUploadUrl(job.storage_path, { upsert: false });
    if (signError || !signedUpload?.token) {
      await admin.rpc('cancel_cloud_job', { p_user_id: auth.user.id, p_job_id: job.job_id });
      return json({ error: 'Tautan unggah aman belum dapat dibuat.' }, 503);
    }
    return json({ jobId: job.job_id, status: job.status, path: signedUpload.path, token: signedUpload.token,
      uploadExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      limits: { maxFrames: job.max_frames, retentionDays: job.retention_days } }, 201);
  }

  if (body?.action === 'complete' || body?.action === 'cancel' || body?.action === 'delete') {
    const jobId = body?.jobId;
    if (!uuid.test(jobId ?? '')) return json({ error: 'ID pekerjaan tidak valid.' }, 400);
    if (body.action === 'cancel') {
      const { error } = await admin.rpc('cancel_cloud_job', { p_user_id: auth.user.id, p_job_id: jobId });
      if (error) {
        if (error.message?.includes('job_not_cancellable')) return json({ error: 'Pekerjaan ini sudah diproses dan tidak dapat dibatalkan.' }, 409);
        return json({ error: 'Pekerjaan tidak ditemukan.' }, 404);
      }
      const { data: jobState } = await admin.from('jobs').select('status,cancel_requested')
        .eq('id', jobId).eq('user_id', auth.user.id).maybeSingle();
      if (jobState?.status === 'processing' && jobState.cancel_requested) {
        return json({ cancelled: false, cancelRequested: true });
      }
      const { data: jobExpiry } = await admin.from('jobs').select('upload_expires_at')
        .eq('id', jobId).eq('user_id', auth.user.id).maybeSingle();
      if (jobExpiry?.upload_expires_at && Date.parse(jobExpiry.upload_expires_at) > Date.now()) {
        return json({ cancelled: true, cleanupPending: true, cleanupAfter: jobExpiry.upload_expires_at });
      }
      return json({ cancelled: true, cleanupPending: true });
    }
    if (body.action === 'delete') {
      const { error } = await admin.rpc('delete_cloud_job', { p_user_id: auth.user.id, p_job_id: jobId });
      if (error) {
        if (error.message?.includes('job_busy')) return json({ error: 'Batalkan pekerjaan sebelum diunggah, atau tunggu pemrosesan selesai.' }, 409);
        return json({ error: 'Pekerjaan tidak ditemukan.' }, 404);
      }
      const { data: jobExpiry } = await admin.from('jobs').select('upload_expires_at')
        .eq('id', jobId).eq('user_id', auth.user.id).maybeSingle();
      if (jobExpiry?.upload_expires_at && Date.parse(jobExpiry.upload_expires_at) > Date.now()) {
        return json({ deleted: false, cleanupPending: true, deleteAfter: jobExpiry.upload_expires_at });
      }
      return json({ deleted: false, cleanupPending: true });
    }

    const { data: inputs, error: inputError } = await admin.from('assets').select('storage_path,size_bytes,mime_type')
      .eq('job_id', jobId).eq('user_id', auth.user.id).in('mime_type', ['video/mp4', 'video/webm']).limit(1);
    if (inputError || !inputs?.[0]) return json({ error: 'Pekerjaan unggah tidak ditemukan.' }, 404);
    const inputAsset = inputs[0];
    const folder = inputAsset.storage_path.slice(0, inputAsset.storage_path.lastIndexOf('/'));
    const { data: files, error: listError } = await admin.storage.from('jeda-private').list(folder, { limit: 10 });
    const sourceName = inputAsset.storage_path.slice(inputAsset.storage_path.lastIndexOf('/') + 1);
    const uploaded = files?.find((item) => item.name === sourceName);
    const uploadedBytes = Number(uploaded?.metadata?.size ?? uploaded?.metadata?.contentLength);
    if (listError || !uploaded || !Number.isSafeInteger(uploadedBytes) || uploadedBytes !== inputAsset.size_bytes) {
      return json({ error: 'Unggah belum lengkap atau ukuran video tidak cocok.' }, 400);
    }
    const { data: state, error: activateError } = await admin.rpc('activate_cloud_job', {
      p_user_id: auth.user.id, p_job_id: jobId, p_uploaded_bytes: uploadedBytes,
    });
    if (activateError) return json({ error: 'Unggahan sudah kedaluwarsa atau tidak dapat diproses.' }, 409);
    return json({ jobId, status: state });
  }

  return json({ error: 'Aksi cloud tidak dikenal.' }, 400);
});
