# Jeda — Spesifikasi Produk Android dan SaaS

**Status:** dokumen ini mencakup sasaran produk penuh; lihat `IMPLEMENTATION_STATUS.md` untuk fitur yang sudah benar-benar ada di sumber dan layanan yang belum aktif. SaaS belum live.
**Platform utama:** Android.
**Prinsip:** pengolahan video di perangkat sebagai jalur utama; akun dan cloud tidak boleh menjadi syarat untuk mengambil frame atau menyimpan foto.

## 1. Tujuan

Jeda membantu pengguna memilih momen dari video dan menyimpannya sebagai foto yang tajam pada resolusi sumber. Pengguna dapat mengambil satu frame atau satu rentang frame, memperbesar hasil, mengelola hasil di galeri internal, dan mengekspor ke penyimpanan perangkat. Jika produk dijalankan sebagai SaaS, akun, sinkronisasi, riwayat cloud, dan langganan menjadi layanan tambahan yang dapat diverifikasi oleh server.

## 2. Pengguna dan platform

- Pengguna utama: pemilik Android yang perlu mengambil foto dari video tanpa aplikasi desktop.
- Alur dasar tetap berfungsi tanpa akun, koneksi internet, atau unggahan video.
- Bahasa antarmuka awal: Bahasa Indonesia; tanggal, ukuran, dan durasi mengikuti locale perangkat.
- Target Android dan batas minimum SDK harus dipastikan saat proyek Android dibuat.

## 3. Alur utama

1. Pengguna memilih video dari pemilih berkas Android.
2. Aplikasi membaca durasi, rasio, resolusi, dan kemampuan decode yang tersedia.
3. Video ditampilkan dengan scrubber waktu, pemutaran, jeda, dan gerak frame.
4. Pengguna memilih satu momen atau mengatur rentang, interval, dan format untuk ekstraksi berurutan.
5. Aplikasi mengekstrak frame pada resolusi sumber, menerapkan opsi ukuran atau model super-resolution yang tersedia, lalu menampilkan pratinjau hasil.
6. Pengguna menyimpan hasil ke album Jeda di galeri, membagikannya, atau menghapus hasil dari riwayat Jeda.
7. Mode SaaS menambahkan sinkronisasi metadata, riwayat akun, kuota, dan pembelian langganan; file video tetap lokal kecuali pengguna secara sadar memilih pemrosesan cloud.

## 4. Spesifikasi fungsional

### 4.1 Video dan navigasi

- Pilih video lokal melalui Android Photo Picker atau Storage Access Framework.
- Tampilkan nama, durasi, resolusi, ukuran sumber jika tersedia, dan pesan codec tidak didukung.
- Putar, jeda, geser ke waktu tertentu, dan lompat frame maju/mundur tanpa menandai waktu sementara sebagai frame final sebelum decode selesai.
- Android mengambil frame ekspor dengan `MediaMetadataRetriever.OPTION_CLOSEST` dari sumber video, bukan dari gambar pratinjau browser. Pratinjau tetap memakai pemutar video; ekspor melewati decoder Android.
- Tampilkan pratinjau pada rasio aslinya; sediakan zoom pratinjau tanpa mengubah ekspor.
- Tangani video rotasi, resolusi portrait, durasi pendek, variable frame rate, dan frame pertama/terakhir.

### 4.2 Foto tunggal dan ekstraksi berurutan

- Ambil frame saat ini dengan satu tindakan.
- Ekstraksi berurutan berdasarkan waktu mulai, waktu akhir, dan jarak waktu.
- Sediakan mode setiap N frame jika frame rate dapat diketahui dengan aman; bila tidak, tampilkan waktu aktual yang diekstrak.
- Pratinjau ukuran dan jumlah file sebelum pemrosesan.
- Progress, jumlah berhasil/gagal, batalkan pekerjaan, dan lanjutkan hanya pekerjaan yang aman diinterupsi.
- Nama file konsisten berisi nama proyek, urutan, waktu, ukuran, dan ekstensi.

### 4.3 Kualitas dan ekspor

- Resolusi asli menjadi default; PNG menjadi format lossless default.
- Format ekspor: PNG, JPEG dengan pengaturan kualitas, dan WebP bila decoder Android mendukungnya.
- Pilihan ukuran 1×/2×/4× memakai interpolasi standar dan harus diberi label bahwa metode ini memperbesar piksel, bukan memulihkan detail.
- AI upscale VDSR 2×/4× tersedia offline di sumber Android dan model berlisensi MIT disertakan di APK. Model memperkirakan detail pada luminans; ini bukan pemulihan detail asli yang hilang. Hasil visual dan performa tetap perlu diperiksa pada perangkat target.
- Tampilkan dimensi sumber dan hasil, estimasi ukuran berkas, serta peringatan bila resolusi keluaran melebihi batas memori aman.
- Simpan melalui MediaStore ke album Jeda; gunakan URI konten Android, bukan path publik yang tidak aman.
- Bagikan hasil melalui Android Sharesheet.

### 4.4 Riwayat dan organisasi

- Daftar pekerjaan lokal berisi video sumber, waktu, parameter, pratinjau, status, dan lokasi hasil.
- Album, pencarian, sortir waktu, favorit, multi-select, ekspor ulang, dan hapus riwayat.
- Hapus metadata Jeda tidak boleh menghapus video sumber.
- Status file yang dipindahkan/dihapus dari perangkat harus ditampilkan tanpa merusak riwayat lain.

### 4.5 SaaS, bila dipilih

Sumber saat ini mengimplementasikan email/password, verifikasi email/deep link, pemulihan kata sandi, profil dan proyek cloud, sesi Android terenkripsi, sinkronisasi metadata ekspor opt-in per akun, ekspor/hapus akun, verifikasi billing, pembaruan langganan RTDN dengan JWT Pub/Sub terverifikasi, dan jalur cloud extraction dengan unggah signed URL, kuota per paket, antrean database, worker FFmpeg, status/unduh hasil, pembatalan, penghapusan, retry, dan pembersihan retensi. Cloud worker hanya mengekstrak frame; AI VDSR berjalan lokal di Android. Seluruh layanan masih perlu proyek Supabase, paket/kuota yang diputuskan pemilik, kredensial Google Play/Pub/Sub, server worker, dan uji deployment.

- Akun melalui email dengan verifikasi alamat, pemulihan akses, pengelolaan sesi, dan penghapusan akun.
- Sinkronkan metadata dan pengaturan; unggah video MP4/WebM hanya setelah konfirmasi khusus sebelum setiap pekerjaan cloud.
- Cloud history menyimpan metadata dan frame PNG di bucket privat dengan masa retensi paket; hapus job dan semua objeknya sesuai permintaan pengguna.
- Entitlement Free/Pro ditentukan server, bukan nilai lokal yang dapat diedit.
- Kuota memisahkan menit video, jumlah foto, penyimpanan, dan AI upscale; rincian harga/kuota harus diputuskan pemilik produk dan tidak boleh dikarang dalam UI.
- Langganan Android menggunakan Google Play Billing bila aplikasi dipublikasikan di Google Play; validasi pembelian dilakukan server-side. Web checkout adalah jalur terpisah dan tunduk pada kebijakan distribusi yang berlaku.
- Dashboard akun menampilkan penggunaan, perangkat, status langganan, faktur/riwayat transaksi yang diberikan provider, ekspor data, dan penutupan akun.
- Operasional SaaS memerlukan API terautentikasi, antrean job, penyimpanan objek privat, worker, idempotency, retry, rate limit, audit log, health check, pencatatan biaya, dan dukungan penghapusan. Source saat ini menyediakan jalur worker ekstraksi dengan batas teknis, tetapi belum live atau menjalankan cloud AI.

## 5. Privasi dan keamanan

- Tanpa akun, tidak ada permintaan jaringan yang membawa video, frame, atau metadata pribadi.
- Izin file diminta saat pengguna memilih video; tidak meminta akses seluruh penyimpanan.
- Pemrosesan cloud harus opt-in per pekerjaan, menampilkan data yang dikirim, tujuan, ukuran unggahan, dan retensi.
- Transfer HTTPS; penyimpanan objek privat; URL bertanda tangan berumur pendek.
- Password tidak pernah disimpan atau dicatat oleh aplikasi; token disimpan di Android Keystore melalui mekanisme penyimpanan aman.
- API membatasi akses objek per akun; pemeriksaan kuota dan status pembelian dilakukan server-side.
- Ada fungsi ekspor dan permintaan hapus akun/data; worker menghapus objek setelah pekerjaan dan token unggah aktif selesai/kedaluwarsa. Log tidak memuat token, isi video, atau frame.
- Crash/analitik non-esensial harus opt-in dan tidak membawa media.

## 6. Spesifikasi non-fungsional

- Aplikasi dapat dibuka dan mengekstrak frame tanpa jaringan.
- UI tetap responsif saat pemrosesan; pekerjaan besar menunjukkan progress dan dapat dibatalkan dengan aman.
- Tidak mengalokasikan bitmap berukuran tak terbatas; uji batas video resolusi tinggi dan tangani kegagalan memori tanpa kehilangan sumber.
- Dukungan aksesibilitas: label kontrol, target sentuh, kontras, ukuran teks sistem, dan umpan balik status.
- Perubahan orientasi/proses latar tidak boleh mengirim duplikat ekspor tanpa sepengetahuan pengguna.
- Semua status produk dibedakan: dibuat, diuji lokal, terhubung ke backend, diuji pembayaran sandbox, diuji pada emulator/perangkat, siap publikasi.

## 7. Entitas data SaaS

- `User`: id provider, email terverifikasi, locale, waktu pembuatan, status penghapusan.
- `Subscription`: provider, product id, status server, rentang aktif, token pembelian yang dienkripsi/dirahasiakan.
- `UsageLedger`: jenis pemakaian, jumlah, periode, idempotency key, job terkait.
- `Project`: pemilik, nama, metadata video tanpa berkas video wajib, parameter pemrosesan.
- `Job`: status, timestamps, idempotency key, opsi ekstraksi, opsi upscale, error aman, jumlah hasil.
- `Asset`: job/pemilik, jenis, dimensi, ukuran, checksum, storage key privat, waktu retensi.
- `DeletionRequest`: cakupan, status, penyelesaian semua objek dan cache terkait.

## 8. API awal SaaS

Kontrak minimal layanan SaaS:

- `GET /v1/me` — profil dan entitlement.
- `GET /v1/usage` — pemakaian dan sisa kuota yang dihitung server.
- `GET|POST /v1/projects` — daftar/buat proyek.
- `POST /v1/jobs` — validasi dan buat job; idempotency key wajib.
- `GET /v1/jobs/{id}` — status dan hasil job.
- `DELETE /v1/jobs/{id}` — hapus job, metadata, dan objek sesuai retensi.
- `POST /v1/billing/verify` — validasi notifikasi/pembelian dari provider; endpoint tidak menerima status premium dari klien sebagai bukti.
- `POST /v1/account/export` dan `DELETE /v1/account` — hak ekspor dan penghapusan akun.

## 9. Kriteria penerimaan

### Android offline

- Instalasi baru membuka aplikasi tanpa jaringan.
- Video kompatibel dapat dipilih dan diputar dari penyimpanan perangkat.
- Foto yang diekspor sama dengan dimensi video sumber pada 1×; isi gambar dapat dibuka di galeri.
- Seek menunggu frame selesai didekode; frame saat ini dan ekstraksi berurutan menghasilkan waktu/nama berkas yang konsisten.
- Upscale standar menghasilkan dimensi sesuai pilihan atau menolak dengan pesan aman bila di luar batas memori.
- Video asli tidak pernah diubah atau dihapus.

### SaaS

- Dua akun tidak dapat membaca proyek/aset satu sama lain.
- Pembelian valid diverifikasi server; status yang diubah di klien tidak membuka fitur premium.
- Retry job ber-idempotency tidak menggandakan pemakaian/hasil.
- Penghapusan akun menghapus atau menganonimkan seluruh data sesuai kebijakan dan mencatat hasil.
- Pekerjaan cloud tidak mengirim media tanpa persetujuan terpisah.
- Pembelian diuji di lingkungan sandbox; klaim live menunggu konfigurasi dan uji transaksi nyata yang diizinkan.

## 10. Fase implementasi

1. **Android offline:** proyek dan application id terpisah, pemilih video native, ekstraksi frame yang sinkron dengan decoder, simpan/share melalui Android, ukuran standar, riwayat lokal, APK debug dan bukti build.
2. **Kualitas dan ketahanan:** format/interval, pembatalan, batas memori, accessibility, berkas rusak/codec tidak didukung, uji emulator dan perangkat bila tersedia.
3. **SaaS backend:** baru setelah pilihan SaaS final; sediakan konfigurasi provider, auth, database, penyimpanan privat, job worker, kuota, ekspor/hapus data.
4. **Billing dan AI cloud/device:** setelah provider, model/lisensi, kuota, harga, kebijakan privasi, serta kredensial sandbox tersedia.
5. **Rilis publik:** signing key milik pemilik, branding final, kebijakan privasi/terms, listing Play, uji perangkat, dan persetujuan publikasi.

## 11. Konfigurasi yang masih dibutuhkan

- Pendaftaran akun dan metode login.
- Hosting/database/object storage dan domain.
- Harga, kuota, free trial, dan kebijakan pengembalian.
- Pemrosesan AI di perangkat atau cloud dan batas biaya.
- Lokasi data, retensi unggahan, syarat privasi, dan target negara pengguna.
- Nama final, application id final, ikon, dan kepemilikan signing key.
