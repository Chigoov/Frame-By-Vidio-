package com.jedastudio.app;

import android.Manifest;
import android.content.ContentValues;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(
    name = "GallerySaver",
    permissions = {
        @Permission(alias = "legacyStorage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class GallerySaverPlugin extends Plugin {
    private static final long MAX_IMAGE_BYTES = 50L * 1024 * 1024;

    @PluginMethod
    public void shareImage(PluginCall call) {
        String value = call.getString("uri");
        String mimeType = safeMimeType(call.getString("mimeType"));
        Uri uri = value == null ? null : Uri.parse(value);
        if (uri == null || !"content".equals(uri.getScheme())) {
            call.reject("Foto galeri tidak dapat dibagikan.");
            return;
        }
        try (InputStream source = getContext().getContentResolver().openInputStream(uri)) {
            if (source == null) throw new IllegalArgumentException("Foto tidak ditemukan.");
        } catch (Exception error) {
            call.reject("Foto galeri tidak tersedia untuk dibagikan.", error);
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                Intent share = new Intent(Intent.ACTION_SEND).setType(mimeType).putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                share.setClipData(ClipData.newUri(getContext().getContentResolver(), "Foto Jeda", uri));
                getActivity().startActivity(Intent.createChooser(share, "Bagikan foto"));
                call.resolve();
            } catch (Exception error) { call.reject("Menu berbagi tidak dapat dibuka.", error); }
        });
    }

    @PluginMethod
    public void getThumbnail(PluginCall call) {
        String value = call.getString("uri");
        Uri uri = value == null ? null : Uri.parse(value);
        if (uri == null || !"content".equals(uri.getScheme())) {
            call.reject("Pratinjau foto tidak tersedia.");
            return;
        }
        try (InputStream boundsStream = getContext().getContentResolver().openInputStream(uri)) {
            if (boundsStream == null) throw new IllegalArgumentException("Foto galeri tidak dapat dibaca.");
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeStream(boundsStream, null, bounds);
            if (bounds.outWidth < 1 || bounds.outHeight < 1) throw new IllegalArgumentException("Foto galeri tidak valid.");
            int sample = 1;
            while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > 320) sample *= 2;
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            try (InputStream imageStream = getContext().getContentResolver().openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                if (imageStream == null) throw new IllegalArgumentException("Foto galeri tidak dapat dibaca.");
                Bitmap thumbnail = BitmapFactory.decodeStream(imageStream, null, options);
                if (thumbnail == null) throw new IllegalArgumentException("Pratinjau foto tidak dapat dibuat.");
                try {
                    if (!thumbnail.compress(Bitmap.CompressFormat.JPEG, 76, output)) throw new IllegalArgumentException("Pratinjau foto tidak dapat dibuat.");
                } finally { thumbnail.recycle(); }
                call.resolve(new JSObject().put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)));
            }
        } catch (Exception error) { call.reject("Pratinjau foto tidak tersedia.", error); }
    }

    @PluginMethod
    public void saveImage(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("legacyStorage", call, "legacyStorageCallback");
            return;
        }
        saveImageNow(call);
    }

    @PermissionCallback
    private void legacyStorageCallback(PluginCall call) {
        if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            call.reject("Izin penyimpanan diperlukan untuk menyimpan foto ke galeri.");
            return;
        }
        saveImageNow(call);
    }

    private void saveImageNow(PluginCall call) {
        Uri imageUri = null;
        InputStream sourceStream = null;
        HttpsURLConnection download = null;
        long bytesWritten = 0;
        try {
            String dataUrl = call.getString("dataUrl");
            String sourceUri = call.getString("sourceUri");
            String downloadUrl = call.getString("downloadUrl");
            String filename = safeFilename(call.getString("filename"));
            String mimeType = safeMimeType(call.getString("mimeType"));
            byte[] bytes = null;
            if (sourceUri != null && sourceUri.length() <= 2048) {
                Uri source = Uri.parse(sourceUri);
                if (!"file".equals(source.getScheme())) throw new IllegalArgumentException("File foto sementara tidak valid.");
                File frameFolder = new File(getContext().getCacheDir(), "jeda-frames").getCanonicalFile();
                File sourceFile = new File(source.getPath()).getCanonicalFile();
                if (!sourceFile.getPath().startsWith(frameFolder.getPath() + File.separator)) throw new IllegalArgumentException("File foto berada di luar folder sementara Jeda.");
                if (!sourceFile.isFile() || sourceFile.length() < 1 || sourceFile.length() > MAX_IMAGE_BYTES) throw new IllegalArgumentException("Ukuran foto kosong atau melebihi batas 50 MB.");
                sourceStream = getContext().getContentResolver().openInputStream(source);
                if (sourceStream == null) throw new IllegalArgumentException("File foto sementara tidak dapat dibaca.");
            } else if (downloadUrl != null) {
                URL remote = new URL(downloadUrl);
                if (!"https".equals(remote.getProtocol()) || !remote.getPath().contains("/storage/v1/object/sign/")) {
                    throw new IllegalArgumentException("Tautan foto cloud tidak valid.");
                }
                download = (HttpsURLConnection) remote.openConnection();
                download.setInstanceFollowRedirects(false);
                download.setConnectTimeout(15_000);
                download.setReadTimeout(30_000);
                if (download.getResponseCode() != 200 || download.getContentLengthLong() > MAX_IMAGE_BYTES
                    || !"image/png".equals(download.getContentType().split(";", 2)[0].trim())) {
                    throw new IllegalArgumentException("Foto cloud tidak tersedia atau melebihi batas 50 MB.");
                }
                sourceStream = download.getInputStream();
            } else if (dataUrl != null) {
                int separator = dataUrl.indexOf(',');
                String encoded = separator >= 0 ? dataUrl.substring(separator + 1) : dataUrl;
                if (encoded.length() > (MAX_IMAGE_BYTES * 4 / 3) + 8) throw new IllegalArgumentException("File foto melebihi batas 50 MB.");
                bytes = Base64.decode(encoded, Base64.DEFAULT);
                if (bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES) throw new IllegalArgumentException("Ukuran foto kosong atau melebihi batas 50 MB.");
            } else {
                call.reject("Data foto kosong.");
                return;
            }

            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
            values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Jeda");
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
            } else {
                File folder = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Jeda");
                if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException("Folder Jeda tidak dapat dibuat.");
                values.put(MediaStore.Images.Media.DATA, new File(folder, filename).getAbsolutePath());
            }

            imageUri = getContext().getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (imageUri == null) throw new IllegalStateException("Galeri tidak dapat menyiapkan lokasi foto.");
            try (OutputStream output = getContext().getContentResolver().openOutputStream(imageUri, "w")) {
                if (output == null) throw new IllegalStateException("Foto tidak dapat ditulis ke galeri.");
                if (bytes != null) {
                    bytesWritten = bytes.length;
                    output.write(bytes);
                } else {
                    byte[] chunk = new byte[16 * 1024];
                    for (int read; (read = sourceStream.read(chunk)) >= 0;) {
                        bytesWritten += read;
                        if (bytesWritten > MAX_IMAGE_BYTES) throw new IllegalArgumentException("File foto melebihi batas 50 MB.");
                        output.write(chunk, 0, read);
                    }
                }
                output.flush();
                if (bytesWritten < 1) throw new IllegalArgumentException("File foto kosong.");
            }
            if (sourceStream != null) { sourceStream.close(); sourceStream = null; }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.Images.Media.IS_PENDING, 0);
                getContext().getContentResolver().update(imageUri, ready, null, null);
            }
            JSObject result = new JSObject();
            result.put("uri", imageUri.toString());
            result.put("filename", filename);
            result.put("bytes", bytesWritten);
            call.resolve(result);
        } catch (Exception error) {
            if (imageUri != null) getContext().getContentResolver().delete(imageUri, null, null);
            call.reject("Foto gagal disimpan ke galeri.", error);
        } finally {
            if (sourceStream != null) try { sourceStream.close(); } catch (Exception ignored) {}
            if (download != null) download.disconnect();
        }
    }

    private String safeFilename(String filename) {
        String safe = filename == null ? "jeda-foto.png" : filename.replaceAll("[^A-Za-z0-9._-]", "_");
        return safe.isEmpty() ? "jeda-foto.png" : safe;
    }

    private String safeMimeType(String mimeType) {
        if ("image/jpeg".equals(mimeType) || "image/webp".equals(mimeType)) return mimeType;
        return "image/png";
    }
}
