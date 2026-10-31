import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

// 1. Baca berkas HTML asli aplikasi Jeda
const htmlPath = new URL('../www/index.html', import.meta.url);
const html = await readFile(htmlPath, 'utf8');

// Ekstrak kode JavaScript inline yang sesungguhnya dari www/index.html
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'Script inline aplikasi Jeda harus ditemukan di www/index.html');
const appCode = scriptMatch[1];

// 2. Buat simulasi DOM interaktif yang memodelkan perilaku elemen aplikasi nyata
class MockClassList {
  constructor() { this.classes = new Set(); }
  add(...names) { names.forEach(n => this.classes.add(n)); }
  remove(...names) { names.forEach(n => this.classes.delete(n)); }
  toggle(name, force) {
    if (force === undefined) {
      if (this.classes.has(name)) { this.classes.delete(name); return false; }
      this.classes.add(name); return true;
    }
    if (force) this.classes.add(name); else this.classes.delete(name);
    return force;
  }
  contains(name) { return this.classes.has(name); }
}

class MockElement {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.classList = new MockClassList();
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.style = {
      _props: {},
      setProperty(k, v) { this._props[k] = String(v); },
      getPropertyValue(k) { return this._props[k] || ''; }
    };
    this._listeners = {};
    this.children = [];
    this.dataset = {};
  }
  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
  removeEventListener(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
    }
  }
  dispatchEvent(event) {
    const list = this._listeners[event.type] || [];
    list.forEach(fn => fn(event));
    if (typeof this[`on${event.type}`] === 'function') this[`on${event.type}`](event);
    return true;
  }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  removeAttribute(k) { delete this[k]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  click() { if (typeof this.onclick === 'function') return this.onclick(); }
}

// Koleksi elemen DOM aplikasi
const elements = new Map();
function getOrCreateElement(id) {
  if (!elements.has(id)) {
    const el = new MockElement(id);
    elements.set(id, el);
  }
  return elements.get(id);
}

// Setup elemen-elemen bawaan form Jeda
const elementIds = [
  'mainContainer', 'heroSection', 'editorCard', 'uploadBar', 'uploadTitle', 'fileName', 'videoMeta',
  'choose', 'file', 'editor', 'video', 'placeholder', 'current', 'seek', 'duration', 'seekHint',
  'settingsDetails', 'activeSettingsSummary', 'scale', 'format', 'quality', 'qualityControl',
  'qualityValue', 'scaleHint', 'back', 'forward', 'zoom', 'save', 'status',
  'saveConfirmCard', 'dismissSavedBtn', 'savedThumbImg', 'savedFileName', 'savedMetaDetail',
  'savedLocationBadge', 'viewSavedBtn', 'shareSavedBtn', 'batchCard', 'start', 'setStartCurrent',
  'end', 'setEndCurrent', 'interval', 'batch', 'batchEstimate', 'batchProgress', 'batchStatus',
  'historyCard', 'historySearch', 'favoritesOnly', 'deleteSelected', 'historyWarning', 'historyList',
  'cloudStatus', 'cloudControls'
];

elementIds.forEach(id => {
  const el = getOrCreateElement(id);
  // Inisialisasi textContent dari HTML asli jika ada
  const m = html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)<\\/`));
  if (m) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) el.textContent = text;
  }
});

// Set initial states
getOrCreateElement('format').value = 'png';
getOrCreateElement('scale').value = '1';
getOrCreateElement('quality').value = '92';
getOrCreateElement('editor').classList.add('hidden');
getOrCreateElement('saveConfirmCard').classList.add('hidden');
getOrCreateElement('batchCard').classList.add('hidden');
getOrCreateElement('video').videoWidth = 1920;
getOrCreateElement('video').videoHeight = 1080;
getOrCreateElement('video').duration = 10.0;
getOrCreateElement('video').currentTime = 0;
getOrCreateElement('video').readyState = 4;
getOrCreateElement('video').pause = () => {};

// Mock Capacitor Plugins
let viewedUri = null;
let sharedUri = null;

const mockGallery = {
  saveImage: async ({ filename, mimeType }) => ({ uri: `content://media/external/images/media/999`, filename }),
  getThumbnail: async () => ({ dataUrl: 'data:image/jpeg;base64,mockthumb' }),
  viewImage: async ({ uri }) => { viewedUri = uri; return true; },
  shareImage: async ({ uri }) => { sharedUri = uri; return true; }
};

const mockVideoFrames = {
  extractFrame: async ({ timeMs, scale, format, quality }) => ({
    uri: 'file:///cache/jeda-frames/mock.png',
    width: 1920 * scale,
    height: 1080 * scale,
    sizeBytes: 150000,
    targetTimeMs: timeMs,
    format,
    mimeType: `image/${format}`
  }),
  cleanupTemp: async () => true
};

const mockDocument = {
  getElementById: (id) => getOrCreateElement(id),
  createElement: (tag) => new MockElement('', tag),
  querySelectorAll: () => [],
  addEventListener: () => {},
  dispatchEvent: () => {},
  body: new MockElement('body', 'body')
};

const mockWindow = {
  document: mockDocument,
  Capacitor: {
    getPlatform: () => 'android',
    convertFileSrc: (uri) => uri,
    registerPlugin: (name) => {
      if (name === 'GallerySaver') return mockGallery;
      if (name === 'VideoFrames') return mockVideoFrames;
      return {};
    }
  },
  URL: {
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {}
  },
  localStorage: {
    getItem: () => '[]',
    setItem: () => {}
  },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  dispatchEvent: () => {},
  crypto: { randomUUID: () => '0000-uuid' }
};

// 3. Eksekusi kode aplikasi nyata di dalam sandbox VM
const context = vm.createContext({
  window: mockWindow,
  document: mockDocument,
  navigator: {},
  console,
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i?.detail; } },
  crypto: { randomUUID: () => '0000-uuid' },
  setTimeout,
  clearTimeout,
  Intl,
  Math,
  Number,
  String,
  Set,
  Map,
  Date,
  Array,
  Promise
});

vm.runInContext(appCode, context);

// ============================================================================
// VERIFIKASI PENGUJIAN 1: Halaman awal sebelum video dipilih
// ============================================================================
console.log('Test 1: Memverifikasi tampilan awal sebelum video dipilih...');
assert.equal(mockDocument.body.classList.contains('has-video'), false, 'Body tidak boleh berstatus has-video pada awal');
assert.ok(getOrCreateElement('editor').classList.contains('hidden'), 'Editor harus tersembunyi sebelum video dipilih');
assert.equal(getOrCreateElement('uploadTitle').textContent.includes('Pilih video'), true, 'Judul upload awal meminta pilih video');

// ============================================================================
// VERIFIKASI PENGUJIAN 2: Memilih video & peralihan ke mode editor compact
// ============================================================================
console.log('Test 2: Memilih video dan memverifikasi aktivasi mode editor...');
const sampleNativeVideo = {
  uri: 'content://com.android.providers.media.documents/document/video%3A123',
  fileName: 'liburan-pantai.mp4',
  sizeBytes: 25000000,
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  durationMs: 12500 // 12.5 detik
};

// Panggil fungsi showVideo nyata di context
context.showVideo(null, sampleNativeVideo);

assert.equal(mockDocument.body.classList.contains('has-video'), true, 'Body harus mengaktifkan class has-video saat video dipilih');
assert.equal(getOrCreateElement('editor').classList.contains('hidden'), false, 'Editor harus tampil');
assert.equal(getOrCreateElement('fileName').textContent, 'liburan-pantai.mp4', 'Nama file harus cocok');
assert.equal(getOrCreateElement('choose').textContent, 'Ganti video', 'Tombol choose harus berubah menjadi Ganti video');
assert.equal(getOrCreateElement('save').disabled, false, 'Tombol simpan harus aktif setelah video siap');

// ============================================================================
// VERIFIKASI PENGUJIAN 3: Penggeser waktu & pergeseran presisi ~1/30 detik
// ============================================================================
console.log('Test 3: Memverifikasi ketelitian waktu seperseratus detik & kontrol 1/30s...');
// Set slider waktu ke 2.50 detik
getOrCreateElement('seek').value = '250';
getOrCreateElement('seek').oninput();
assert.equal(getOrCreateElement('current').textContent, '00:02.50', 'Format waktu harus memiliki ketelitian 2 desimal seperseratus detik');

// Klik tombol maju ~1/30 detik
await getOrCreateElement('forward').onclick();
const timeAfterForward = getOrCreateElement('current').textContent;
assert.notEqual(timeAfterForward, '00:02.50', 'Waktu harus berubah setelah tombol maju ditekan');
assert.equal(timeAfterForward, '00:02.53', '2.50 + 1/30s (~0.0333s) harus menghasilkan 00:02.53');

// Klik tombol mundur ~1/30 detik
await getOrCreateElement('back').onclick();
const timeAfterBack = getOrCreateElement('current').textContent;
assert.equal(timeAfterBack, '00:02.50', 'Waktu harus kembali ke 00:02.50 setelah mundur');

// ============================================================================
// VERIFIKASI PENGUJIAN 4: Pengaturan foto & ringkasan aktif
// ============================================================================
console.log('Test 4: Memverifikasi interaksi pengaturan foto & ringkasan...');
assert.equal(getOrCreateElement('activeSettingsSummary').textContent, 'Asli · 1× · PNG (lossless)', 'Default summary harus Asli 1x PNG');

// Ubah ke JPEG kualitas 85%
getOrCreateElement('format').value = 'jpeg';
getOrCreateElement('quality').value = '85';
getOrCreateElement('format').onchange();
getOrCreateElement('quality').oninput();

assert.equal(getOrCreateElement('qualityControl').classList.contains('hidden'), false, 'Slider kualitas harus muncul untuk JPEG');
assert.equal(getOrCreateElement('activeSettingsSummary').textContent, 'Asli · 1× · JPEG (85%)', 'Ringkasan harus diperbarui ke JPEG 85%');

// ============================================================================
// VERIFIKASI PENGUJIAN 5: Tombol rentang awal/akhir batch dari posisi saat ini
// ============================================================================
console.log('Test 5: Memverifikasi tombol gunakan posisi saat ini pada batch...');
getOrCreateElement('setStartCurrent').onclick();
assert.equal(getOrCreateElement('start').value, '2.50', 'Waktu mulai harus mengambil posisi saat ini (2.50s)');

// Geser video ke 5.80s lalu set akhir
getOrCreateElement('seek').value = '580';
getOrCreateElement('seek').oninput();
getOrCreateElement('setEndCurrent').onclick();
assert.equal(getOrCreateElement('end').value, '5.80', 'Waktu akhir harus mengambil posisi saat ini (5.80s)');

// ============================================================================
// VERIFIKASI PENGUJIAN 6: Alur simpan momen, konfirmasi visual & aksi Lihat/Bagikan
// ============================================================================
console.log('Test 6: Memverifikasi alur simpan momen & aksi konfirmasi...');
await getOrCreateElement('save').onclick();
console.log('Status after save:', getOrCreateElement('status').textContent);
console.log('Save confirm card classes:', [...getOrCreateElement('saveConfirmCard').classList.classes]);

assert.equal(getOrCreateElement('saveConfirmCard').classList.contains('hidden'), false, 'Kartu konfirmasi harus tampil setelah simpan');
assert.equal(getOrCreateElement('savedLocationBadge').textContent.includes('Pictures/Jeda'), true, 'Lokasi harus mengonfirmasi album Pictures/Jeda');

// Uji klik tombol Lihat foto
await getOrCreateElement('viewSavedBtn').onclick();
assert.equal(viewedUri, 'content://media/external/images/media/999', 'Tombol Lihat foto harus memanggil plugin galeri viewImage dengan URI yang tepat');

// Uji klik tombol Bagikan
await getOrCreateElement('shareSavedBtn').onclick();
assert.equal(sharedUri, 'content://media/external/images/media/999', 'Tombol Bagikan harus memanggil plugin galeri shareImage dengan URI yang tepat');

// ============================================================================
// VERIFIKASI PENGUJIAN 7: Kejelasan status offline bawaan
// ============================================================================
console.log('Test 7: Memverifikasi pesan status offline tanpa konfigurasi cloud...');
const cloudStatus = getOrCreateElement('cloudStatus').textContent;
assert.ok(cloudStatus.includes('Cloud belum dikonfigurasi'), 'Status cloud harus transparan');
assert.ok(cloudStatus.includes('100% lokal offline'), 'Status harus menegaskan operasi lokal offline');

// ============================================================================
// VERIFIKASI PENGUJIAN 8: Keberadaan aset logo bersih, ikon Android & splash
// ============================================================================
console.log('Test 8: Memverifikasi keberadaan fisik file logo dan ikon Android...');
const currentFilePath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(currentFilePath), '..');

const checkFiles = [
  'artifacts/branding/logo-jeda-konsep-asli.png',
  'artifacts/branding/logo-jeda-clean-1024.png',
  'www/assets/logo-jeda.png',
  'www/assets/logo-jeda-128.png',
  'android/app/src/main/res/mipmap-mdpi/ic_launcher.png',
  'android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png',
  'android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png',
  'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
  'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png',
  'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png',
  'android/app/src/main/res/drawable/splash.png'
];

for (const rel of checkFiles) {
  const fPath = path.resolve(root, rel);
  const s = await stat(fPath);
  assert.ok(s.size > 0, `Berkas aset ${rel} harus ada dan berukuran > 0`);
}

console.log('Seluruh pengujian perilaku nyata aplikasi Jeda, DOM interaktif, dan aset branding BERHASIL LULUS (PASS)!');
