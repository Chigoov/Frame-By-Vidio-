# Catatan Perubahan Jeda

## 1.5.0

- Penyelarasan identitas rilis: `versionName "1.5.0"` dan `versionCode 6` pada konfigurasi Android Gradle `build.gradle` dan `package.json`.
- Integrasi logo resmi Jeda (simbol jeda/pause dalam bingkai foto dan siluet alam) menggantikan ikon huruf 'J' awal. Logo dibersihkan dari stray pixels dan dipusatkan secara presisi.
- Ikon Android adaptive icon (`ic_launcher_foreground.png`) disesuaikan ke safe-zone OEM (60dp dari 108dp kanvas) dengan latar gelap `#10120F`, disertai ikon legacy square/round pada 5 densitas (`mdpi`, `hdpi`, `xhdpi`, `xxhdpi`, `xxxhdpi`) dan 11 varian splash screen.
- Mode editor kompak otomatis (`.has-video`): menyembunyikan header hero saat video dimuat sehingga pratinjau, penggeser waktu, dan tombol simpan dapat terlihat bersamaan pada layar ponsel (mis. 390 × 844) tanpa harus menggulir berlebih.
- Kotak pemilihan video bertransformasi menjadi bar informasi video yang ramping dengan nama file, durasi, resolusi, ukuran, dan tombol "Ganti video".
- Area pratinjau video fleksibel (`object-fit: contain`) untuk video landscape (16:9) maupun portrait vertikal ponsel (9:16) tanpa distorsi/cropping.
- Tombol aksi utama **"Simpan momen ini"** diposisikan dominan sebagai primary CTA dengan warna hijau aksen Jeda yang mencolok.
- Pengambilan banyak foto (batch) dikelompokkan ke dalam accordion rapi agar tidak mendominasi alur simpan foto tunggal, lengkap dengan tombol "Posisi saat ini", estimasi ukuran total, dan pembatalan aman.
- Pengujian otomatis ditingkatkan (`tests/ui-flow.test.mjs`) untuk mengevaluasi kode dan perilaku interaktif DOM aplikasi nyata (event dispatching, pergeseran waktu ~1/30s, perubahan pengaturan, alur simpan dan trigger plugin galeri).
- Perbaikan bug handler galeri: perbaikan referensi variabel `id` yang tidak terdefinisi pada fallback antrean thumbnail riwayat.

## 1.4.0

- Ikon dan layar pembuka memakai identitas Jeda.
- Pratinjau video dapat diperbesar; informasi video dan perkiraan ukuran ekstraksi berurutan tampil sebelum proses dimulai.
- Navigasi waktu Android menggunakan posisi target yang dipilih. Nama hasil menjelaskan bahwa decoder mengambil frame terdekat, sehingga tidak menyatakan waktu frame yang tidak diketahui.
- Pemrosesan berurutan menahan pergantian video sampai selesai, dan riwayat menandai foto galeri yang tidak lagi dapat dibaca.
- Batas memori upscale mengikuti kapasitas heap perangkat agar proses menolak resolusi yang terlalu besar sebelum alokasi.
- Sumber akun cloud kini memuat profil, proyek, riwayat metadata, dan kendali sesi. Persetujuan sinkronisasi disimpan per akun, dan persetujuan unggah diulang saat video berubah.
- Sumber worker menambah pemeriksaan kesehatan, pengamanan terhadap worker lama, dan pembersihan berkas cloud setelah pembatalan atau penghapusan. Unduhan hasil cloud di Android mengalir langsung ke galeri.

## 1.3.0

- Ekspor Android mendukung PNG, JPEG, dan WebP; kualitas JPEG/WebP dapat diatur.
- Foto tersimpan tampil di riwayat lokal dengan pratinjau, pencarian, favorit, pilih banyak, berbagi Android, dan ekspor ulang dari video sumber bila izinnya masih berlaku.
- Ekstraksi berurutan menampilkan progres dan dapat dihentikan tanpa menghapus foto yang sudah tersimpan.
- Hapus riwayat hanya menghapus catatan di Jeda; foto galeri dan video sumber tetap aman.

## 1.2.0

- Android mengambil foto langsung dari decoder video sistem pada resolusi frame sumber.
- Penyimpanan foto dan alur AI upscale memakai file sementara lokal agar tidak menyalin gambar besar lewat bridge Base64.
- Pemilih video memakai pemilih dokumen Android dan menyimpan izin baca berkas saat provider mendukungnya.
- Proyek dan layanan cloud tetap opsional; pemrosesan lokal tidak membutuhkan akun atau koneksi internet.
