# Menyiapkan Jeda Cloud

Mode offline tidak memerlukan akun cloud. SaaS aktif setelah database, fungsi, batas paket, worker, dan kredensial milik pemilik layanan dipasang.

## 1. Supabase

1. Buat proyek Supabase milikmu, pasang Supabase CLI, lalu jalankan `supabase login` dan `supabase link --project-ref <project-ref>` dari folder proyek.
2. Jalankan `supabase db push` untuk menerapkan semua migrasi di `supabase/migrations/`.
3. Pastikan email auth aktif. Tambahkan `jedastudio://auth/callback` sebagai redirect URL yang diizinkan agar tautan verifikasi kembali ke aplikasi Android.
4. Deploy fungsi `account-export`, `account-delete`, `verify-play-purchase`, `cloud-jobs`, dan `play-rtdn`. Empat fungsi pertama memerlukan JWT Supabase; `play-rtdn` memverifikasi JWT OIDC Google Pub/Sub sendiri.
5. Isi `.env.local` dari `.env.example` menggunakan `VITE_SUPABASE_URL` dan `VITE_SUPABASE_PUBLISHABLE_KEY`. Publishable key memang berada di aplikasi; jangan taruh service-role/secret key di file `VITE_*`.

### Kuota dan retensi

Migrasi sengaja tidak menetapkan harga atau angka paket. Tanpa baris aktif di `public.plan_limits`, pemrosesan cloud mengembalikan status belum dikonfigurasi. Atur paket `free` dan `pro` melalui SQL Editor sebelum mengaktifkan paket. Kolomnya `monthly_jobs`, `monthly_storage_bytes` (input + hasil yang diproses selama bulan berjalan), `max_upload_bytes`, `max_duration_ms`, `max_frames`, dan `retention_days`. Harga dan manfaat Pro harus sesuai produk yang kamu tetapkan.

Batas teknis keras saat ini: MP4/WebM maksimal 50 MB, durasi 10 menit, 100 frame per pekerjaan, total hasil 250 MB per pekerjaan, dan resolusi keluaran 40 MP. Retensi paket minimal satu hari dan maksimal 365 hari. Worker membaca ulang durasi/resolusi dari video, tidak hanya mempercayai metadata klien.

### Worker ekstraksi cloud

Worker memakai FFmpeg dan hanya membutuhkan secret di server worker.

1. Pasang Docker Engine/Compose pada server worker.
2. Salin `worker/.env.example` menjadi `worker/.env`; isi `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` dari proyek Supabase. Simpan file itu di server, jangan di repo, APK, atau chat.
3. Dari folder proyek jalankan `docker compose -f compose.worker.yml up --build -d`.
4. Periksa log dan status health container. Worker mengklaim job secara atomik, mencoba ulang kegagalan sementara sampai tiga kali, menghentikan pekerjaan yang dibatalkan, membersihkan unggahan kedaluwarsa, dan menyelesaikan permintaan hapus akun. Health check memastikan worker masih dapat membaca antrean Supabase.

Worker saat ini mengekstrak frame PNG. AI VDSR tetap berjalan offline di Android; worker cloud belum menjalankan AI upscale.

## 2. Google Play Billing

Sebelum langganan dapat dijual, buat produk langganan dan base plan di Play Console dengan product id milikmu. Hubungkan Play Console ke Google Play Developer API dan buat service account yang hanya mendapat izin yang diperlukan untuk membaca serta mengakui pembelian.

Atur rahasia fungsi Edge di Supabase:

- `GOOGLE_PLAY_PACKAGE_NAME` = `com.jedastudio.app`
- `GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_IDS` = daftar ID produk dipisah koma
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` = JSON service account dari Google Cloud
- `PLAY_RTDN_AUDIENCE` = audience persis yang dipakai push subscription Pub/Sub
- `PLAY_RTDN_SERVICE_ACCOUNT_EMAIL` = email service account yang menandatangani push OIDC Pub/Sub
- `PLAY_RTDN_SUBSCRIPTION_NAME` = nama resource lengkap subscription Pub/Sub, mis. `projects/<project-id>/subscriptions/<subscription-id>`

Buat topic Cloud Pub/Sub, tautkan topik RTDN pada Play Console, lalu buat push subscription terautentikasi ke `https://<project-ref>.supabase.co/functions/v1/play-rtdn`. Atur audience dan service account sesuai tiga secret di atas, serta beri Pub/Sub service agent izin membuat token untuk service account tersebut. Endpoint memeriksa tanda tangan, audience, email, identitas subscription, package name, lalu membaca ulang status pembelian melalui Google Play Developer API. Notifikasi tanpa token pembelian yang sudah dikaitkan dengan akun Jeda diabaikan; aplikasi tetap mengirim verifikasi setelah pembelian.

Tambahkan ID produk yang sama ke `.env.local` sebagai `VITE_GOOGLE_PLAY_MONTHLY_PRODUCT_ID` dan/atau `VITE_GOOGLE_PLAY_YEARLY_PRODUCT_ID`. Harga yang terlihat di Android berasal dari Play Billing. Jangan mengirim service account JSON ke aplikasi, repositori, atau chat.

Unggah APK/AAB bertanda tangan rilis ke closed testing Play Console sebelum menguji pembelian. APK debug sideload tidak dapat membuktikan transaksi Google Play sandbox.

## 3. Verifikasi dan privasi

- Klien tidak boleh menulis status langganan atau membuat job premium secara langsung.
- Verifikasi pembelian mengambil status langsung dari Google Play Developer API; token asli tidak disimpan di database, hanya hash SHA-256.
- Metadata ekspor tidak dikirim sampai pengguna mengaktifkan kotak sinkronisasi. Video hanya diunggah saat pengguna memilih pekerjaan cloud dan menyetujui checkbox khusus; bucket privat mengikuti batas retensi paket.
- Penghapusan akun menjadi permintaan server; worker menghapus objek privat dan akun setelah job berhenti dan token unggah terakhir kedaluwarsa. Token unggah Supabase berlaku dua jam; jadwal pembersihan menyimpan tambahan jeda lima menit dan diperbarui setiap tautan unggah dibuat ulang. Worker harus tetap berjalan.
- Jalankan `npm run test:db` setelah mengubah migrasi untuk memeriksa RLS dan isolasi proyek/storage antar-akun.

## 4. Layanan yang belum disediakan

Sumber fungsi dan worker belum berarti layanan live. Masih perlu proyek Supabase, konfigurasi paket/kuota, server Docker, kredensial Google Play, topic/push subscription RTDN, domain/web deployment, terms/privacy policy, dan listing Play. Jangan menjual fitur sebelum komponen milikmu di-deploy dan diuji.
