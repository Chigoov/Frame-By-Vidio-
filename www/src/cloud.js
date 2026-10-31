import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { createClient } from '@supabase/supabase-js';

const $ = (id) => document.getElementById(id);
const status = $('cloudStatus');
const controls = $('cloudControls');
const form = $('accountForm');
const signedInActions = $('signedInActions');
const resetPasswordForm = $('resetPasswordForm');
const syncToggle = $('syncMetadata');
const cloudJobsCard = $('cloudJobsCard');
const cloudPlanSummary = $('cloudPlanSummary');
const cloudJobStatus = $('cloudJobStatus');
const cloudJobList = $('cloudJobList');
const startCloudJob = $('startCloudJob');
const cloudConsent = $('cloudConsent');
const isNative = Capacitor.isNativePlatform();
syncToggle.checked = false;

const { VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key } = import.meta.env;
if (!url || !key) {
  status.textContent = 'Cloud belum dikonfigurasi. Semua fitur pengambilan dan penyimpanan foto berjalan 100% lokal offline di perangkat.';
} else {
  const secureSession = registerPlugin('SecureSession');
  const billing = registerPlugin('JedaBilling');
  const storage = isNative ? {
    getItem: async () => (await secureSession.get())?.value ?? null,
    setItem: async (_key, value) => secureSession.set({ value }),
    removeItem: async () => secureSession.remove(),
  } : localStorage;
  const supabase = createClient(url, key, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' },
  });
  let activeUser = null;
  let recoveringPassword = false;
  let cloudPlan = null;
  let selectedVideo = null;
  let refreshTimer = null;
  let selectedProjectId = null;
  let displayedUserId = null;
  syncToggle.onchange = () => {
    if (activeUser) localStorage.setItem(`jeda.sync-metadata.${activeUser.id}`, String(syncToggle.checked));
  };
  const projectCard = document.createElement('section');
  projectCard.className = 'card hidden';
  projectCard.innerHTML = `<h2 class="section-title">Proyek cloud</h2>
    <p class="account-note">Proyek membantu mengelompokkan metadata ekspor dan pekerjaan cloud. Saat kamu membuat proyek dengan video terpilih, nama, durasi, dan resolusinya disimpan ke akun.</p>
    <form id="projectForm" class="account-actions"><input id="projectName" type="text" maxlength="120" required aria-label="Nama proyek" placeholder="Nama proyek"><button class="button" type="submit">Buat proyek</button></form>
    <div class="settings"><label for="projectSelect">Proyek aktif<select id="projectSelect"><option value="">Tanpa proyek</option></select></label><button id="deleteProject" class="button secondary" type="button" disabled>Hapus proyek</button></div>
    <p id="projectStatus" class="status" aria-live="polite">Belum ada proyek cloud.</p>
    <h3 class="section-title">Riwayat metadata akun</h3><p class="account-note">Berisi catatan foto yang kamu pilih untuk disinkronkan. Isi foto tetap di perangkat.</p>
    <div id="syncedExportList" aria-live="polite"></div><button id="moreSyncedExports" class="button secondary hidden" type="button">Muat berikutnya</button>`;
  cloudJobsCard.before(projectCard);
  const projectName = projectCard.querySelector('#projectName');
  const projectSelect = projectCard.querySelector('#projectSelect');
  const projectStatus = projectCard.querySelector('#projectStatus');
  const deleteProject = projectCard.querySelector('#deleteProject');
  const syncedExportList = projectCard.querySelector('#syncedExportList');
  const moreSyncedExports = projectCard.querySelector('#moreSyncedExports');
  let syncedExportOffset = 0;
  let syncedExportRequest = 0;
  const profileForm = document.createElement('form');
  profileForm.className = 'account-actions hidden';
  profileForm.innerHTML = '<input id="displayName" type="text" maxlength="80" aria-label="Nama tampilan" placeholder="Nama tampilan"><button class="button secondary" type="submit">Simpan nama</button>';
  signedInActions.before(profileForm);
  const displayName = profileForm.querySelector('#displayName');
  profileForm.onsubmit = async (event) => {
    event.preventDefault(); if (!activeUser) return;
    const button = event.submitter || profileForm.querySelector('button'); button.disabled = true;
    try {
      const { error } = await supabase.from('profiles').update({ display_name: displayName.value.trim() })
        .eq('user_id', activeUser.id).select('display_name').single();
      if (error) throw error;
      await refreshAccount(); status.textContent += ' · nama tampilan disimpan';
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
  };

  const refreshProjects = async () => {
    if (!activeUser) return;
    const userId = activeUser.id;
    const { data, error } = await supabase.from('projects')
      .select('id,name,source_name,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    if (activeUser?.id !== userId) return;
    projectSelect.replaceChildren(new Option('Tanpa proyek', ''));
    for (const project of data ?? []) projectSelect.add(new Option(project.name, project.id));
    if (!(data ?? []).some((project) => project.id === selectedProjectId)) selectedProjectId = null;
    projectSelect.value = selectedProjectId ?? '';
    deleteProject.disabled = !selectedProjectId;
    projectStatus.textContent = data?.length ? `${data.length} proyek tersedia. Proyek aktif dipakai untuk metadata ekspor dan pekerjaan cloud berikutnya.` : 'Belum ada proyek cloud.';
  };
  const refreshSyncedExports = async (reset = true) => {
    if (!activeUser) return;
    const userId = activeUser.id, projectId = selectedProjectId, request = ++syncedExportRequest;
    if (reset) { syncedExportOffset = 0; syncedExportList.replaceChildren(); }
    moreSyncedExports.disabled = true;
    let query = supabase.from('local_exports')
      .select('id,file_name,source_time_ms,width,height,output_format,created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).range(syncedExportOffset, syncedExportOffset + 49);
    if (projectId) query = query.eq('project_id', projectId);
    const { data, error } = await query;
    if (request === syncedExportRequest) moreSyncedExports.disabled = false;
    if (error) throw error;
    if (activeUser?.id !== userId || selectedProjectId !== projectId || syncedExportRequest !== request) return;
    if (!data?.length && syncedExportOffset === 0) {
      const empty = document.createElement('p'); empty.className = 'status'; empty.textContent = 'Belum ada metadata foto tersinkron untuk pilihan ini.';
      syncedExportList.append(empty);
    }
    for (const item of data ?? []) {
      const row = document.createElement('div'); row.className = 'cloud-job';
      const title = document.createElement('strong'); title.textContent = item.file_name;
      const detail = document.createElement('span'); detail.className = 'account-note';
      detail.textContent = ` · ${(item.source_time_ms / 1000).toFixed(2)} dtk · ${item.width} × ${item.height} ${item.output_format.toUpperCase()} · ${new Date(item.created_at).toLocaleString('id-ID')}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button secondary'; remove.textContent = 'Hapus metadata';
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          const { error: deleteError } = await supabase.from('local_exports').delete().eq('id', item.id).eq('user_id', userId);
          if (deleteError) throw deleteError;
          await refreshSyncedExports();
          projectStatus.textContent = 'Metadata akun dihapus. Foto di perangkat tetap tersedia.';
        } catch (deleteError) { projectStatus.textContent = deleteError.message || 'Metadata tidak dapat dihapus.'; remove.disabled = false; }
      };
      row.append(title, detail, remove); syncedExportList.append(row);
    }
    syncedExportOffset += data?.length ?? 0;
    moreSyncedExports.classList.toggle('hidden', (data?.length ?? 0) < 50);
  };
  moreSyncedExports.onclick = () => refreshSyncedExports(false).catch((error) => { projectStatus.textContent = error.message || 'Riwayat tidak dapat dimuat.'; });
  projectSelect.onchange = () => {
    selectedProjectId = projectSelect.value || null; deleteProject.disabled = !selectedProjectId;
    refreshSyncedExports().catch((error) => { projectStatus.textContent = error.message || 'Riwayat tidak dapat dimuat.'; });
  };
  projectCard.querySelector('#projectForm').onsubmit = async (event) => {
    event.preventDefault();
    const name = projectName.value.trim();
    if (!activeUser || !name || name.length > 120) return;
    const button = event.submitter || event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      const row = { user_id: activeUser.id, name };
      if (selectedVideo) Object.assign(row, { source_name: (selectedVideo.fileName || 'video').slice(0, 255),
        source_duration_ms: selectedVideo.durationMs, source_width: selectedVideo.width, source_height: selectedVideo.height });
      const { data, error } = await supabase.from('projects').insert(row).select('id').single();
      if (error) throw error;
      selectedProjectId = data.id; projectName.value = '';
      await refreshProjects();
      await refreshSyncedExports();
      projectStatus.textContent = 'Proyek cloud dibuat dan dipilih.';
    } catch (error) { projectStatus.textContent = error.message || 'Proyek tidak dapat dibuat.'; }
    finally { button.disabled = false; }
  };
  deleteProject.onclick = async () => {
    if (!selectedProjectId || !confirm('Hapus proyek ini? Foto di galeri dan pekerjaan yang sudah dibuat tetap tersedia.')) return;
    deleteProject.disabled = true;
    const projectId = selectedProjectId;
    try {
      const { error } = await supabase.from('projects').delete().eq('id', projectId).eq('user_id', activeUser.id);
      if (error) throw error;
      selectedProjectId = null; await refreshProjects(); await refreshSyncedExports();
      projectStatus.textContent = 'Proyek dihapus. Foto dan pekerjaan tetap tersedia.';
    } catch (error) { projectStatus.textContent = error.message || 'Proyek tidak dapat dihapus.'; deleteProject.disabled = false; }
  };

  const showError = (error) => {
    status.textContent = error?.message || 'Permintaan cloud gagal. Periksa koneksi dan coba lagi.';
    status.classList.add('error');
  };
  const setCloudJobStatus = (message, error = false) => {
    cloudJobStatus.textContent = message;
    cloudJobStatus.classList.toggle('error', error);
  };
  const updateCloudButton = () => {
    startCloudJob.disabled = !activeUser || !selectedVideo || !cloudConsent.checked || !cloudPlan?.enabled;
  };
  const callCloud = async (body) => {
    const { data, error } = await supabase.functions.invoke('cloud-jobs', { body });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  };
  const sizeLabel = (bytes) => {
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };
  const refreshCloudSummary = async () => {
    const userId = activeUser?.id;
    const data = await callCloud({ action: 'summary' });
    if (activeUser?.id !== userId) return;
    cloudPlan = data.deletionRequest ? { ...data.plan, enabled: false } : data.plan;
    if (data.deletionRequest) {
      cloudPlanSummary.textContent = `Permintaan penghapusan akun diterima. Cloud baru dinonaktifkan; penghapusan dijalankan setelah ${new Date(data.deletionRequest.delete_after).toLocaleString('id-ID')} dan pekerjaan yang sedang berjalan berhenti.`;
    } else if (!data.plan?.enabled) {
      cloudPlanSummary.textContent = `Paket ${data.planCode === 'pro' ? 'Pro' : 'Gratis'} · pemrosesan cloud belum diaktifkan atau kuotanya belum diatur.`;
    } else {
      cloudPlanSummary.textContent = `Paket ${data.planCode === 'pro' ? 'Pro' : 'Gratis'} · ${data.used.jobs}/${data.plan.monthly_jobs} pekerjaan bulan ini · ${sizeLabel(data.used.storageBytes)} dari ${sizeLabel(data.plan.monthly_storage_bytes)} data cloud bulan ini · batas ${sizeLabel(data.plan.max_upload_bytes)} dan ${(data.plan.max_duration_ms / 60000).toFixed(0)} menit per video · ${data.plan.max_frames} frame per pekerjaan · hasil disimpan ${data.plan.retention_days} hari.`;
    }
    updateCloudButton();
  };
  const friendlyJobStatus = (job) => ({
    awaiting_upload: 'Menunggu unggahan video', queued: 'Dalam antrean', processing: job.cancel_requested ? 'Sedang membatalkan pekerjaan' : 'Sedang mengambil frame',
    completed: `${job.output_count} frame siap diunduh`, failed: `Gagal · ${job.error_code || 'periksa file dan coba kembali'}`,
    cancelled: 'Dibatalkan', deleting: 'Menghapus data cloud',
  }[job.status] || job.status);
  const downloadCloudFrame = async (asset) => {
    const { data, error } = await supabase.storage.from('jeda-private').createSignedUrl(asset.storage_path, 300);
    if (error || !data?.signedUrl) throw new Error('Tautan unduh foto belum dapat dibuat.');
    if (isNative) {
      // ponytail: GallerySaver streams up to 50 MB into MediaStore; the WebView never holds a Base64 copy.
      await registerPlugin('GallerySaver').saveImage({ downloadUrl: data.signedUrl, filename: `jeda-cloud-${asset.id}.png`, mimeType: 'image/png' });
      return;
    }
    const response = await fetch(data.signedUrl);
    if (!response.ok) throw new Error('Foto cloud gagal diunduh.');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `jeda-cloud-${asset.id}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 15000);
  };
  const refreshCloudJobs = async () => {
    if (!activeUser) return;
    const userId = activeUser.id;
    const { data: jobs, error } = await supabase.from('jobs')
      .select('id,status,cancel_requested,output_count,error_code,created_at,updated_at')
      .eq('kind', 'cloud_extract').order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    if (activeUser?.id !== userId) return;
    cloudJobList.replaceChildren();
    if (!jobs?.length) {
      const empty = document.createElement('p'); empty.className = 'account-note'; empty.textContent = 'Belum ada pekerjaan cloud.';
      cloudJobList.append(empty);
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      return;
    }
    const activeJobs = jobs.some((job) => ['awaiting_upload', 'queued', 'processing', 'deleting'].includes(job.status));
    if (activeJobs && !refreshTimer) refreshTimer = setInterval(() => refreshCloudJobs().catch(() => {}), 6000);
    if (!activeJobs && refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    const jobIds = jobs.map((job) => job.id);
    const { data: assets, error: assetsError } = await supabase.from('assets')
      .select('id,job_id,storage_path,mime_type,expires_at,size_bytes')
      .in('job_id', jobIds).eq('mime_type', 'image/png').gt('expires_at', new Date().toISOString()).order('created_at');
    if (assetsError) throw assetsError;
    if (activeUser?.id !== userId) return;
    for (const job of jobs) {
      const row = document.createElement('div'); row.className = 'cloud-job';
      const label = document.createElement('strong'); label.textContent = friendlyJobStatus(job);
      const date = document.createElement('span'); date.className = 'account-note'; date.textContent = ` · ${new Date(job.created_at).toLocaleString('id-ID')}`;
      row.append(label, date);
      for (const asset of (assets ?? []).filter((item) => item.job_id === job.id)) {
        const button = document.createElement('button'); button.className = 'button secondary'; button.type = 'button';
        button.textContent = `Simpan frame · ${sizeLabel(asset.size_bytes)}`;
        button.onclick = async () => { button.disabled = true; try { await downloadCloudFrame(asset); } catch (error) { setCloudJobStatus(error.message, true); } finally { button.disabled = false; } };
        row.append(button);
      }
      if (['awaiting_upload', 'queued', 'processing'].includes(job.status)) {
        const button = document.createElement('button'); button.className = 'button secondary'; button.type = 'button'; button.textContent = 'Batalkan';
        if (job.cancel_requested) { button.textContent = 'Pembatalan diminta'; button.disabled = true; }
        button.onclick = async () => {
          button.disabled = true;
          try { const result = await callCloud({ action: 'cancel', jobId: job.id }); setCloudJobStatus(result.cancelRequested ? 'Permintaan pembatalan dikirim; worker sedang menghentikan pekerjaan.' : result.cleanupAfter ? `Pekerjaan dibatalkan. Berkas dibersihkan setelah token unggah kedaluwarsa (${new Date(result.cleanupAfter).toLocaleTimeString('id-ID')}).` : result.cleanupPending ? 'Pekerjaan dibatalkan; worker akan mencoba membersihkan berkas lagi.' : 'Pekerjaan dibatalkan.'); await refreshCloudJobs(); await refreshCloudSummary(); }
          catch (error) { setCloudJobStatus(error.message, true); button.disabled = false; }
        };
        row.append(button);
      } else if (['completed', 'failed', 'cancelled', 'deleting'].includes(job.status)) {
        const button = document.createElement('button'); button.className = 'button secondary'; button.type = 'button'; button.textContent = 'Hapus pekerjaan';
        button.onclick = async () => {
          button.disabled = true;
          try { const result = await callCloud({ action: 'delete', jobId: job.id }); setCloudJobStatus(result.deleteAfter ? `Penghapusan dijadwalkan setelah token unggah kedaluwarsa (${new Date(result.deleteAfter).toLocaleTimeString('id-ID')}).` : result.cleanupPending ? 'Penghapusan diproses; worker akan mencoba membersihkan cloud lagi.' : 'Pekerjaan dan hasil cloud dihapus.'); await refreshCloudJobs(); await refreshCloudSummary(); }
          catch (error) { setCloudJobStatus(error.message, true); button.disabled = false; }
        };
        row.append(button);
      }
      cloudJobList.append(row);
    }
  };

  window.addEventListener('jeda:video-selected', () => {
    selectedVideo = null;
    cloudConsent.checked = false;
    setCloudJobStatus('Membaca informasi video…');
    updateCloudButton();
  });
  window.addEventListener('jeda:video-ready', (event) => {
    selectedVideo = event.detail;
    if (!projectName.value) projectName.value = (event.detail.fileName || 'Video').replace(/\.[^.]+$/, '').slice(0, 120);
    const name = event.detail.fileName || event.detail.file?.name || 'video';
    const bytes = event.detail.sizeBytes ?? event.detail.file?.size ?? -1;
    setCloudJobStatus(`${name} · ${bytes >= 0 ? sizeLabel(bytes) : 'ukuran belum diketahui'} · video ini hanya diunggah setelah persetujuan khusus.`);
    updateCloudButton();
  });
  cloudConsent.onchange = updateCloudButton;
  $('refreshCloudJobs').onclick = async () => {
    try { await refreshCloudSummary(); await refreshCloudJobs(); setCloudJobStatus('Daftar pekerjaan sudah diperbarui.'); }
    catch (error) { setCloudJobStatus(error.message, true); }
  };
  startCloudJob.onclick = async () => {
    if (!selectedVideo || !cloudConsent.checked) return;
    startCloudJob.disabled = true;
    let jobId;
    try {
      const { durationMs, width, height } = selectedVideo;
      let file = selectedVideo.file;
      if (!file && selectedVideo.playableUrl) {
        if (selectedVideo.sizeBytes > 50 * 1024 * 1024) throw new Error('Video lebih besar dari batas unggah cloud 50 MB.');
        setCloudJobStatus('Membaca video terpilih untuk unggahan cloud yang kamu setujui…');
        const source = await fetch(selectedVideo.playableUrl);
        if (!source.ok) throw new Error('Video tidak dapat dibaca untuk pemrosesan cloud.');
        const blob = await source.blob();
        file = new File([blob], selectedVideo.fileName || 'video.mp4', { type: selectedVideo.mimeType || blob.type });
      }
      if (!file) throw new Error('Pilih video terlebih dahulu.');
      const mimeType = file.type || (/\.webm$/i.test(file.name) ? 'video/webm' : /\.mp4$/i.test(file.name) ? 'video/mp4' : '');
      if (!['video/mp4', 'video/webm'].includes(mimeType)) throw new Error('Pemrosesan cloud saat ini mendukung video MP4 dan WebM.');
      const startMs = Math.round(Number($('start').value) * 1000);
      const endMs = Math.round(Number($('end').value) * 1000);
      const intervalMs = Math.round(Number($('interval').value) * 1000);
      setCloudJobStatus('Memeriksa batas paket dan menyiapkan unggahan aman…');
      const created = await callCloud({ action: 'create', consent: true, requestKey: crypto.randomUUID(),
        projectId: selectedProjectId,
        video: { fileName: file.name, mimeType, sizeBytes: file.size, durationMs, width, height },
        range: { startMs, endMs, intervalMs },
      });
      if (created.reused) { setCloudJobStatus('Pekerjaan ini sudah terdaftar.'); await refreshCloudJobs(); return; }
      jobId = created.jobId;
      setCloudJobStatus('Mengunggah video ke bucket privat Jeda…');
      const { error: uploadError } = await supabase.storage.from('jeda-private').uploadToSignedUrl(
        created.path, created.token, file, { contentType: mimeType, upsert: false },
      );
      if (uploadError) throw uploadError;
      setCloudJobStatus('Memverifikasi unggahan dan memasukkan pekerjaan ke antrean…');
      await callCloud({ action: 'complete', jobId });
      setCloudJobStatus(`Video masuk antrean. Hasil disimpan privat selama ${created.limits.retentionDays} hari.`);
      await refreshCloudSummary();
      await refreshCloudJobs();
    } catch (error) {
      if (jobId) await callCloud({ action: 'cancel', jobId }).catch(() => {});
      setCloudJobStatus(error.message || 'Pekerjaan cloud gagal dibuat.', true);
    } finally { cloudConsent.checked = false; updateCloudButton(); }
  };
  const refreshAccount = async () => {
    if (!activeUser) return;
    const userId = activeUser.id;
    const [profile, subscription] = await Promise.all([
      supabase.from('profiles').select('display_name').eq('user_id', userId).maybeSingle(),
      supabase.from('subscriptions').select('product_id,state,current_period_end').eq('user_id', userId).maybeSingle(),
    ]);
    if (profile.error) throw profile.error;
    if (subscription.error) throw subscription.error;
    if (activeUser?.id !== userId) return;
    displayName.value = profile.data?.display_name ?? '';
    const plan = subscription.data && ['active', 'in_grace_period', 'cancelled'].includes(subscription.data.state)
      && Boolean(subscription.data.current_period_end) && Date.parse(subscription.data.current_period_end) > Date.now()
      ? `Pro · ${subscription.data.state.replaceAll('_', ' ')}` : 'Gratis';
    status.classList.remove('error');
    status.textContent = `${displayName.value.trim() ? `${displayName.value.trim()} · ` : ''}${activeUser.email} · paket ${plan}${subscription.data?.current_period_end ? ` · berakhir ${new Date(subscription.data.current_period_end).toLocaleDateString('id-ID')}` : ''}`;
  };
  const renderSession = async (session) => {
    activeUser = session?.user ?? null;
    if (displayedUserId !== (activeUser?.id ?? null)) {
      displayedUserId = activeUser?.id ?? null;
      selectedProjectId = null; cloudPlan = null; cloudConsent.checked = false;
      syncToggle.checked = activeUser ? localStorage.getItem(`jeda.sync-metadata.${activeUser.id}`) === 'true' : false;
      projectSelect.replaceChildren(new Option('Tanpa proyek', ''));
      projectName.value = ''; displayName.value = ''; deleteProject.disabled = true;
      projectStatus.textContent = 'Memuat proyek akun…';
      syncedExportList.replaceChildren(); cloudJobList.replaceChildren();
      cloudPlanSummary.textContent = 'Memuat paket dan kuota cloud…';
      status.textContent = 'Memuat status akun…';
      moreSyncedExports.classList.add('hidden');
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    }
    form.classList.toggle('hidden', Boolean(activeUser));
    profileForm.classList.toggle('hidden', !activeUser);
    signedInActions.classList.toggle('hidden', !activeUser);
    projectCard.classList.toggle('hidden', !activeUser);
    if (!activeUser) {
      selectedProjectId = null;
      syncedExportList.replaceChildren(); moreSyncedExports.classList.add('hidden');
      cloudJobsCard.classList.add('hidden');
      cloudPlan = null;
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      status.classList.remove('error');
      status.textContent = 'Cloud aktif. Masuk untuk menyinkronkan metadata dan memilih pemrosesan video cloud secara terpisah.';
      return;
    }
    cloudJobsCard.classList.remove('hidden');
    const userId = activeUser.id;
    try {
      await Promise.all([refreshAccount(), refreshCloudSummary(), refreshCloudJobs()]);
      await refreshProjects(); await refreshSyncedExports();
    }
    catch (error) { if (activeUser?.id === userId) showError(error); }
  };
  const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') recoveringPassword = true;
    queueMicrotask(async () => {
      await renderSession(session);
      resetPasswordForm.classList.toggle('hidden', !recoveringPassword);
      if (recoveringPassword) status.textContent = 'Tautan pemulihan aktif. Buat kata sandi baru untuk akun ini.';
    });
  });
  window.addEventListener('pagehide', () => {
    authListener.subscription.unsubscribe();
    if (refreshTimer) clearInterval(refreshTimer);
  }, { once: true });

  const handleAuthUrl = async (value) => {
    try {
      const link = new URL(value);
      const code = link.searchParams.get('code');
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
      }
    } catch (error) { showError(error); }
  };
  if (isNative) {
    App.addListener('appUrlOpen', ({ url: link }) => handleAuthUrl(link));
    App.getLaunchUrl().then((launch) => { if (launch?.url) handleAuthUrl(launch.url); }).catch(showError);
  }

  const credentials = () => ({
    email: $('accountEmail').value.trim(),
    password: $('accountPassword').value,
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $('signIn'); button.disabled = $('signUp').disabled = true;
    try {
      const { error } = await supabase.auth.signInWithPassword(credentials());
      if (error) throw error;
      $('accountPassword').value = '';
    } catch (error) { showError(error); }
    finally { button.disabled = $('signUp').disabled = false; }
  };
  $('signUp').onclick = async () => {
    if (!form.reportValidity()) return;
    const button = $('signUp'); button.disabled = $('signIn').disabled = true;
    try {
      const { email, password } = credentials();
      const { data, error } = await supabase.auth.signUp({
        email, password, options: { emailRedirectTo: 'jedastudio://auth/callback' },
      });
      if (error) throw error;
      if (!data.session) status.textContent = 'Akun dibuat. Buka tautan verifikasi di email untuk menyelesaikan pendaftaran.';
      $('accountPassword').value = '';
    } catch (error) { showError(error); }
    finally { button.disabled = $('signIn').disabled = false; }
  };
  $('forgotPassword').onclick = async () => {
    try {
      const email = $('accountEmail').value.trim();
      if (!$('accountEmail').checkValidity()) throw new Error('Masukkan alamat email yang valid terlebih dahulu.');
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: 'jedastudio://auth/callback' });
      if (error) throw error;
      status.textContent = 'Jika email terdaftar, tautan pemulihan akan dikirim ke kotak masukmu.';
    } catch (error) { showError(error); }
  };
  resetPasswordForm.onsubmit = async (event) => {
    event.preventDefault();
    try {
      const { error } = await supabase.auth.updateUser({ password: $('newPassword').value });
      if (error) throw error;
      $('newPassword').value = '';
      recoveringPassword = false;
      resetPasswordForm.classList.add('hidden');
      setBillingStatus('Kata sandi akun berhasil diperbarui.');
    } catch (error) { showError(error); }
  };
  $('signOut').onclick = async () => {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) showError(error);
  };
  const signOutOtherDevices = document.createElement('button');
  signOutOtherDevices.type = 'button'; signOutOtherDevices.className = 'button secondary';
  signOutOtherDevices.textContent = 'Keluar dari perangkat lain';
  signedInActions.insertBefore(signOutOtherDevices, $('deleteAccount'));
  signOutOtherDevices.onclick = async () => {
    signOutOtherDevices.disabled = true;
    try {
      const { error } = await supabase.auth.signOut({ scope: 'others' });
      if (error) throw error;
      status.classList.remove('error');
      status.textContent = 'Sesi perangkat lain dicabut. Perangkat tersebut akan keluar saat tokennya diperbarui.';
    } catch (error) { showError(error); }
    finally { signOutOtherDevices.disabled = false; }
  };
  $('refreshAccount').onclick = () => refreshAccount().catch(showError);

  const monthlyId = import.meta.env.VITE_GOOGLE_PLAY_MONTHLY_PRODUCT_ID;
  const yearlyId = import.meta.env.VITE_GOOGLE_PLAY_YEARLY_PRODUCT_ID;
  const productIds = [monthlyId, yearlyId].filter(Boolean);
  const billingActions = $('billingActions');
  const setBillingStatus = (message) => { status.textContent = message; status.classList.remove('error'); };
  if (isNative) billing.addListener('purchaseUpdated', async ({ purchases }) => {
    if (!activeUser) return;
    try { for (const purchase of purchases ?? []) await sendPurchaseToServer(purchase); }
    catch (error) { showError(error); }
  });
  const sendPurchaseToServer = async (purchase) => {
    if (purchase.purchaseState !== 1) { setBillingStatus('Pembayaran masih menunggu konfirmasi Google Play. Fitur Pro belum diaktifkan.'); return; }
    for (const productId of purchase.productIds ?? []) {
      const { data, error } = await supabase.functions.invoke('verify-play-purchase', {
        body: { productId, purchaseToken: purchase.purchaseToken },
      });
      if (error) throw error;
      if (data?.entitled !== true) throw new Error('Google Play belum mengonfirmasi langganan aktif.');
    }
    await refreshAccount();
  };
  const renderBilling = async () => {
    if (!isNative || productIds.length === 0) return;
    billingActions.classList.remove('hidden');
    try {
      const { products } = await billing.getProducts({ productIds });
      for (const product of products ?? []) {
        const button = document.createElement('button');
        button.className = 'button'; button.type = 'button';
        const periods = { P1W: 'per minggu', P1M: 'per bulan', P3M: 'per 3 bulan', P6M: 'per 6 bulan', P1Y: 'per tahun' };
        button.textContent = `Jeda Pro · ${product.price ?? 'Lihat harga di Google Play'} ${periods[product.billingPeriod] ?? ''}`.trim();
        button.onclick = async () => {
          if (!activeUser) { showError(new Error('Masuk ke akun Jeda sebelum membeli langganan.')); return; }
          button.disabled = true;
          try {
            const result = await billing.purchase({ productId: product.productId, userId: activeUser.id });
            if (result.cancelled) { setBillingStatus('Pembelian dibatalkan.'); return; }
            for (const item of result.purchases ?? []) await sendPurchaseToServer(item);
            if (!result.purchases?.length) setBillingStatus('Google Play belum mengirim pembelian.');
          } catch (error) { showError(error); }
          finally { button.disabled = false; }
        };
        billingActions.insertBefore(button, $('restorePurchases'));
      }
    } catch (error) { showError(error); }
  };
  $('restorePurchases').onclick = async () => {
    try {
      const { purchases } = await billing.restore();
      let restored = 0;
      for (const purchase of purchases ?? []) {
        if (purchase.purchaseState === 1) { await sendPurchaseToServer(purchase); restored++; }
      }
      if (!restored) setBillingStatus('Tidak ada langganan aktif yang ditemukan di Google Play.');
    } catch (error) { showError(error); }
  };
  $('exportAccount').onclick = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('account-export');
      if (error) throw error;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = 'jeda-data-akun.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 15000);
      status.textContent = 'Salinan data akun berhasil diunduh.';
    } catch (error) { showError(error); }
  };
  $('deleteAccount').onclick = async () => {
    if (prompt('Tindakan ini menghapus akun dan data cloud secara permanen. Ketik HAPUS untuk melanjutkan:') !== 'HAPUS') return;
    try {
      const { data, error } = await supabase.functions.invoke('account-delete', { body: { confirmation: 'HAPUS' } });
      if (error) throw error;
      if (data?.deleted !== true) {
        status.textContent = data?.deleteAfter ? `Permintaan hapus diterima. Token unggah terakhir berakhir ${new Date(data.deleteAfter).toLocaleString('id-ID')}; worker akan menghapus akun setelah unggahan dan pekerjaan berhenti.` : 'Permintaan penghapusan akun diterima dan menunggu worker.';
        await refreshCloudSummary().catch(() => {});
        return;
      }
      await supabase.auth.signOut({ scope: 'local' });
      status.textContent = 'Akun dan data cloud telah dihapus.';
    } catch (error) { showError(error); }
  };

  document.addEventListener('jeda:exported', async (event) => {
    if (!activeUser || !syncToggle.checked) return;
    const userId = activeUser.id;
    const entries = Array.isArray(event.detail) ? event.detail : [event.detail];
    try {
      const { error } = await supabase.from('local_exports').insert(entries.map((item) => ({
        user_id: userId,
        project_id: selectedProjectId,
        file_name: item.fileName,
        source_time_ms: Math.round(item.time * 1000),
        width: item.width,
        height: item.height,
        output_format: item.format,
        scale: item.scale,
        file_size_bytes: item.bytes,
      })));
      if (error) throw error;
      if (activeUser?.id !== userId) return;
      status.textContent = `${entries.length} metadata ekspor disinkronkan. Video dan foto tetap di perangkat.`;
      await refreshSyncedExports();
    } catch (error) { showError(error); }
  });

  renderSession((await supabase.auth.getSession()).data.session);
  controls.classList.remove('hidden');
  await renderBilling();
}
