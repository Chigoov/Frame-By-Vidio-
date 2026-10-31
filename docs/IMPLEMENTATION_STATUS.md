# Status Implementasi Jeda

## Ada di sumber aplikasi

- Aplikasi Android `com.jedastudio.app`, min SDK 24 dan target/compile SDK 36.
- Android memakai pemilih berkas sistem dan `MediaMetadataRetriever` untuk mengambil frame terdekat langsung dari video sumber. Foto disalin streaming ke Pictures/Jeda melalui MediaStore tanpa mengodekan gambar besar ke Base64.
- Ekspor PNG, JPEG, atau WebP; kualitas JPEG/WebP dapat diatur. Pembesaran interpolasi 2×/4× dan AI VDSR offline 2×/4× melalui LiteRT.
- Ekstraksi berurutan menampilkan progres dan dapat dibatalkan pada batas antar-frame; foto yang sudah tersimpan tetap aman.
- Riwayat perangkat menyimpan hingga 200 catatan lokal dengan pratinjau, pencarian, favorit, pilih banyak, bagikan melalui Android Sharesheet, dan ekspor ulang bila izin video sumber masih berlaku. Menghapus catatan tidak menghapus foto galeri atau video asli.
- Pratinjau dapat diperbesar 1×/2×/3×. Informasi durasi, resolusi, dan ukuran video serta perkiraan rentang ukuran batch tampil sebelum ekspor. Tombol maju/mundur mengubah waktu target sekitar 1/30 detik; decoder dapat memilih frame terdekat dan waktu frame sebenarnya tidak diklaim.
- Akun Supabase opsional, profil dan proyek cloud, sesi Android terenkripsi, sinkronisasi metadata ekspor opt-in per akun, daftar metadata akun, ekspor data akun, dan permintaan hapus akun.
- SaaS cloud source: persetujuan per unggahan dan per video, unggah signed URL privat, antrean atomik, kuota server, status dan unduhan hasil, pembatalan, hapus pekerjaan, retry, penghapusan retensi, dan pemeriksaan kesehatan worker FFmpeg. Unduhan hasil Android disalin streaming ke galeri.
- Google Play Billing, verifikasi langganan server-side, dan endpoint RTDN yang memeriksa JWT Pub/Sub tersedia sebagai source. Produk, service account, dan Pub/Sub belum dikonfigurasi.
- Pekerjaan cloud saat ini hanya mengekstrak frame PNG. AI VDSR tetap berjalan di perangkat; cloud AI upscale belum tersedia.
- Paket dan retensi tidak diberi angka harga/kuota bawaan; pemilik layanan perlu memilih angka sebelum fitur cloud aktif.
- Model `vdsr_256.tflite` (2.677.860 byte; SHA-256 `5827E594CB4ADEA9BC19758536D1927C1C3C1EF7600542EF57054E8367958AFE`) disertakan; lisensi dan atribusi ada di `THIRD_PARTY_NOTICES.md` dan `LICENSE-VDSR-MIT.txt`.

## Belum tersedia di sumber aplikasi

- Proyek lokal offline, daftar perangkat aktif, faktur dari provider, dashboard operasional SaaS, dan sinkronisasi isi foto antargawai belum dibuat. Proyek cloud dan metadata tersedia di sumber, tetapi memerlukan layanan yang aktif.
- Pemilihan frame berbasis metadata FPS dan pemulihan otomatis batch yang terputus belum tersedia. Perkiraan ukuran batch bersifat kisaran, bukan ukuran final.
- SaaS bukan layanan aktif: belum ada Supabase project, migrasi terpasang, paket berbayar, server worker, domain, atau transaksi sandbox.
- Rilis publik belum disiapkan: belum ada signing key rilis pemilik, AAB, kebijakan dan listing final Play, atau uji penerimaan pada ponsel.

## Pemeriksaan pada 28 Oktober 2026 (Penyempurnaan UI, UX, Logo & Kesiapan Uji)

- `npm run test:ui`: lulus; pengujian interaktif DOM & VM menguji alur aplikasi asli, termasuk pemuatan video, mode editor ringkas, ketelitian waktu seperseratus detik `00:00.00`, pergeseran tombol ~1/30 detik, interaksi pengaturan format/resolusi, tombol rentang batch posisi saat ini, pemanggilan aksi simpan, kartu konfirmasi visual, pemanggilan plugin galeri `viewImage` & `shareImage`, serta integritas seluruh berkas branding.
- `npm run test:db`: lulus; pengujian PostgreSQL RLS via PGlite mencakup hak akses, kuota, pembatalan, dan hapus akun.
- `npm test`: seluruh test suite otomatis (UI flow + DB RLS) lulus 100%.
- `npm run build`: lulus (Vite v7.3.6 membuild aset web ke `dist/` dengan aset logo Jeda).
- `npx cap sync android`: berhasil menyalin aset web terbaru dan konfigurasi plugin Android.
- `gradlew.bat assembleDebug`: berhasil dikompilasi dengan OpenJDK 21 dan Android SDK 36.
- APK debug baru: `artifacts/Jeda-Android-debug.apk`; 37.546.045 byte; SHA-256 `a207828420141f1df6b417d7e6e8c1767f45f3e8723798c048246201799ba87a`.
- Identitas APK: `com.jedastudio.app`, versionCode 6, versionName 1.5.0, min SDK 24, target SDK 36 (terkonfirmasi via `aapt dump badging`).
- Tanda tangan APK: Skema V2 terverifikasi via `apksigner`.
- Logo & Branding baru: logo konsep resmi dibersihkan dari stray alpha pixels, dipusatkan presisi, dan diterapkan pada Web UI mark, ikon adaptive foreground safe-zone (60/108dp), ikon legacy round/square pada 5 densitas (`mdpi` hingga `xxxhdpi`), serta 11 varian splash screen latar gelap `#10120f`.
- Tidak ada emulator atau perangkat fisik Android yang terhubung (`adb devices -l` kosong). Kompilasi native Java, intent galeri, dan aset grafis terverifikasi, namun interaksi hardware/decoder langsung di ponsel fisik belum diuji.

## Pemeriksaan pada 27 September 2026

- `npm run test:db`: lulus; mencakup RLS, reservasi/idempotensi, kuota, pencocokan ukuran unggahan, antrean/penyelesaian, batal, hapus, dan permintaan hapus akun.
- `npm run build`: lulus.
- Parser Node menerima inline JavaScript aplikasi, modul cloud, dan worker.
- Esbuild menerima kelima sumber Edge Function: `cloud-jobs`, `account-delete`, `account-export`, `verify-play-purchase`, dan `play-rtdn`.
- `node --check worker/index.mjs`: lulus.
- `npm audit --omit=dev`: 0 kerentanan dependensi runtime.
- `npm run android:debug`: berhasil; APK debug ditandatangani dan diverifikasi dengan apksigner (skema V2).
- APK: `artifacts/Jeda-Android-debug.apk`; 37.219.986 byte; SHA-256 `F451199E58FE641DD3D9BEC228337206D4D000C7A5D0AD545825C0785C6D8966`.
- Identitas: `com.jedastudio.app`, versionCode 5, versionName 1.4.0, min SDK 24, target SDK 36.
- Sertifikat debug: SHA-256 `d4fdeb3f61eea56df127d25129c66d3f3968634c805dac1844d585fa4f679377`. Ini bukan kunci rilis.
- Isi APK memuat model VDSR dan pustaka LiteRT untuk arm64-v8a serta x86_64.
- Tidak ada emulator atau perangkat Android yang terhubung. Kompilasi native berhasil, tetapi tampilan dan alur baru, pemilihan file, hasil frame, kualitas upscale, kompatibilitas codec, berbagi, serta performa belum diuji saat berjalan di perangkat.
- Worker berhasil diperiksa sintaks, tetapi belum dijalankan end-to-end; Docker/FFmpeg dan proyek cloud tidak tersedia pada lingkungan ini.

## Belum live / belum siap dirilis

- Supabase project, kredensial, migrasi terpasang, bucket, Edge Functions yang dideploy, dan host worker belum tersedia. UI cloud belum dapat memproses pekerjaan sebelum konfigurasi ini dibuat.
- Pemilik produk masih harus menetapkan harga, kuota paket Free/Pro, masa retensi, dan kebijakan biaya penyimpanan.
- Google Play Console product IDs, service account/API access, topic/push subscription RTDN, transaksi sandbox, listing, dan AAB bertanda tangan rilis belum disiapkan.
- Domain/deployment web, terms, privacy policy final, kunci signing rilis, uji perangkat, serta proses rilis Play belum tersedia.

Lihat `PRODUCT_SPEC.md` untuk sasaran produk dan `SUPABASE_SETUP.md` untuk langkah konfigurasi SaaS. Build dan pemeriksaan lokal bukan bukti bahwa backend aktif atau aplikasi siap diterbitkan.
