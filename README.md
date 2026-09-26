# Jeda Android

Jeda mengambil foto dari video. Pemrosesan lokal tersedia tanpa akun; pemrosesan cloud, akun, sinkronisasi metadata, dan billing bersifat opsional.

## Buat APK debug

```powershell
npm install
npm run android:debug
```

APK lokal: `artifacts/Jeda-Android-debug.apk`. Ini APK debug untuk pemasangan dan pemeriksaan lokal, bukan rilis Google Play.

## Fitur yang tersedia di sumber

- Pilih video, putar/jeda, geser posisi, perbesar pratinjau, dan maju/mundur sekitar 1/30 detik.
- Simpan satu frame atau rentang frame ke album Android `Pictures/Jeda`.
- Ekspor PNG, JPEG, atau WebP; atur kualitas JPEG/WebP, lihat perkiraan ukuran batch, dan kelola riwayat lokal foto.
- Ukuran asli, interpolasi 2×/4×, dan VDSR AI offline 2×/4× di Android. Model memperkirakan detail luminans; hasilnya tidak dapat memulihkan detail asli yang hilang dan bergantung pada sumber/perangkat.
- Daftar akun Supabase opsional, verifikasi email lewat deep link, profil, proyek cloud, dan penyimpanan sesi Android dengan Android Keystore.
- Sinkronisasi metadata ekspor hanya setelah pengguna masuk dan mencentang persetujuannya.
- Sumber pemrosesan cloud: unggah video bertanda tangan setelah persetujuan khusus, reservasi kuota server, antrean, worker FFmpeg, status hasil, unduh privat, pembatalan, penghapusan, retry, dan pembersihan retensi.
- Ekspor dan penghapusan akun/data cloud melalui Supabase Edge Functions.
- Integrasi Play Billing untuk harga lokal, pembelian, pulihkan pembelian, verifikasi backend, dan pengakuan transaksi.
- Pembaruan status langganan otomatis lewat RTDN Google Play dengan tanda tangan Pub/Sub diverifikasi server-side.
- Model VDSR berlisensi MIT disertakan di APK dan berjalan lokal melalui LiteRT; atribusi ada di [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md).
- Migrasi skema Supabase dengan Row Level Security; `npm run test:db` menjalankan pemeriksaan isolasi akun dan hak tulis.

## Menyiapkan layanan cloud

Ikuti [`docs/SUPABASE_SETUP.md`](docs/SUPABASE_SETUP.md) untuk memasang migrasi/fungsi dan menjalankan worker. Proyek ini tidak membawa URL, service key, kuota bisnis, atau kredensial Play milikmu. Untuk APK offline saja, kosongkan variabel `VITE_*` cloud di `.env.example`.

## Batas status saat ini

Backend cloud jobs, worker, dan RTDN tersedia di sumber, tetapi belum live: proyek Supabase, server worker, kuota/harga, rahasia Google Play/Pub/Sub, ID produk, listing Play, dan uji transaksi sandbox belum dikonfigurasi. Cloud worker saat ini mengambil frame MP4/WebM; AI VDSR berjalan offline di Android, bukan di cloud. Status build dan hash APK terakhir dicatat di [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

Perubahan versi Android dicatat di [`docs/CHANGELOG.md`](docs/CHANGELOG.md).
