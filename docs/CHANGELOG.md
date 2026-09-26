# Catatan Perubahan Jeda

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
