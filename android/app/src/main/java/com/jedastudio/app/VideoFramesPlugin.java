package com.jedastudio.app;

import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.UUID;

@CapacitorPlugin(name = "VideoFrames")
public class VideoFramesPlugin extends Plugin {
    private static final long MAX_SOURCE_PIXELS = 40_000_000L;
    private static final long MAX_OUTPUT_PIXELS = 40_000_000L;
    private static final int MAX_IMAGE_BYTES = 50 * 1024 * 1024;

    @PluginMethod
    public void pickVideo(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "videoPicked");
    }

    @ActivityCallback
    private void videoPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        Uri uri = result.getData().getData();
        int flags = result.getData().getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
        try {
            if (flags != 0) getContext().getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (SecurityException ignored) {
            // Some document providers grant only a temporary read permission.
        }
        execute(() -> {
            try { call.resolve(readVideoInfo(uri)); }
            catch (Exception error) { call.reject("Video tidak dapat dibaca oleh decoder Android.", error); }
        });
    }

    @PluginMethod
    public void extractFrame(PluginCall call) {
        String source = call.getString("uri");
        Long requestedTimeMs = call.getLong("timeMs");
        Integer scale = call.getInt("scale", 1);
        String format = call.getString("format", "png");
        Integer quality = call.getInt("quality", 92);
        if (source == null || requestedTimeMs == null || requestedTimeMs < 0 || scale == null || (scale != 1 && scale != 2 && scale != 4)
            || !validFormat(format) || quality == null || quality < 1 || quality > 100) {
            call.reject("Video, waktu, atau ukuran frame tidak valid.");
            return;
        }
        execute(() -> {
            try { call.resolve(writeFrame(Uri.parse(source), requestedTimeMs, scale, format, quality)); }
            catch (OutOfMemoryError error) { call.reject("Memori perangkat tidak cukup untuk mengambil frame ini."); }
            catch (Exception error) { call.reject(error.getMessage() == null ? "Frame tidak dapat diekstrak dari video." : error.getMessage(), error); }
        });
    }

    @PluginMethod
    public void cleanupTemp(PluginCall call) {
        String value = call.getString("uri");
        try {
            if (value != null) {
                File file = tempFile(Uri.parse(value));
                if (file.exists() && !file.delete()) throw new IllegalStateException("File sementara tidak dapat dibersihkan.");
            }
            call.resolve();
        } catch (Exception error) { call.reject("File sementara tidak dapat dibersihkan.", error); }
    }

    private JSObject readVideoInfo(Uri uri) throws Exception {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(getContext(), uri);
            long duration = parseMetadata(retriever, MediaMetadataRetriever.METADATA_KEY_DURATION);
            int width = (int) parseMetadata(retriever, MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
            int height = (int) parseMetadata(retriever, MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
            int rotation = (int) parseMetadata(retriever, MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
            if (duration < 1 || width < 1 || height < 1 || (long) width * height > MAX_SOURCE_PIXELS) {
                throw new IllegalArgumentException("Resolusi atau durasi video melewati batas decoder perangkat.");
            }
            if (Math.floorMod(rotation, 180) != 0) { int swap = width; width = height; height = swap; }

            String name = "video";
            long size = -1;
            try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (nameColumn >= 0) name = cursor.getString(nameColumn);
                    if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn);
                }
            }
            String mime = getContext().getContentResolver().getType(uri);
            if (mime == null) mime = "video/mp4";
            return new JSObject().put("uri", uri.toString()).put("fileName", name).put("sizeBytes", size)
                .put("mimeType", mime).put("durationMs", duration).put("width", width).put("height", height).put("rotation", rotation);
        } finally { retriever.release(); }
    }

    private JSObject writeFrame(Uri source, long requestedTimeMs, int scale, String format, int quality) throws Exception {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        Bitmap frame = null;
        Bitmap output = null;
        File file = null;
        try {
            retriever.setDataSource(getContext(), source);
            long durationMs = parseMetadata(retriever, MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (durationMs < 1 || requestedTimeMs > durationMs) throw new IllegalArgumentException("Waktu frame berada di luar durasi video.");
            long timeMs = Math.min(requestedTimeMs, Math.max(0, durationMs - 1));
            frame = retriever.getFrameAtTime(timeMs * 1000L, MediaMetadataRetriever.OPTION_CLOSEST);
            if (frame == null || frame.getWidth() < 1 || frame.getHeight() < 1
                || (long) frame.getWidth() * frame.getHeight() > MAX_SOURCE_PIXELS) {
                throw new IllegalArgumentException("Decoder tidak menghasilkan frame yang valid.");
            }
            long widthLong = (long) frame.getWidth() * scale;
            long heightLong = (long) frame.getHeight() * scale;
            // ponytail: use the current heap as a conservative per-device ceiling before allocating a second bitmap.
            long safePixels = Math.min(MAX_OUTPUT_PIXELS, Runtime.getRuntime().maxMemory() / (scale == 1 ? 10L : 16L));
            if (widthLong > 8192 || heightLong > 8192 || widthLong * heightLong > safePixels) {
                throw new IllegalArgumentException("Resolusi foto melewati batas memori aman perangkat. Coba ukuran lebih kecil.");
            }
            int width = (int) widthLong;
            int height = (int) heightLong;
            output = scale == 1 ? frame : Bitmap.createScaledBitmap(frame, width, height, true);
            if (output != frame) { frame.recycle(); frame = null; }
            File folder = new File(getContext().getCacheDir(), "jeda-frames");
            if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException("Folder sementara Jeda tidak dapat dibuat.");
            file = new File(folder, UUID.randomUUID() + "." + extension(format));
            try (FileOutputStream stream = new FileOutputStream(file)) {
                if (!output.compress(compressFormat(format), quality, stream)) throw new IllegalStateException("Foto gagal dibuat.");
            }
            if (file.length() < 1 || file.length() > MAX_IMAGE_BYTES) throw new IllegalArgumentException("Foto melebihi batas aman 50 MB.");
            // MediaMetadataRetriever returns a bitmap, not its decoded presentation timestamp.
            return new JSObject().put("uri", Uri.fromFile(file).toString()).put("width", width).put("height", height)
                .put("sizeBytes", file.length()).put("targetTimeMs", timeMs).put("mimeType", mimeType(format)).put("format", format);
        } catch (Exception | Error error) {
            if (file != null) file.delete();
            throw error;
        } finally {
            if (output != null && output != frame && !output.isRecycled()) output.recycle();
            if (frame != null && !frame.isRecycled()) frame.recycle();
            retriever.release();
        }
    }

    private boolean validFormat(String format) { return "png".equals(format) || "jpeg".equals(format) || "webp".equals(format); }
    private String extension(String format) { return "jpeg".equals(format) ? "jpg" : format; }
    private String mimeType(String format) { return "jpeg".equals(format) ? "image/jpeg" : "image/" + format; }
    private Bitmap.CompressFormat compressFormat(String format) {
        if ("jpeg".equals(format)) return Bitmap.CompressFormat.JPEG;
        if ("webp".equals(format)) return Bitmap.CompressFormat.WEBP;
        return Bitmap.CompressFormat.PNG;
    }

    private File tempFile(Uri uri) throws Exception {
        if (!"file".equals(uri.getScheme())) throw new IllegalArgumentException("URI sementara tidak valid.");
        File folder = new File(getContext().getCacheDir(), "jeda-frames").getCanonicalFile();
        File file = new File(uri.getPath()).getCanonicalFile();
        if (!file.getPath().startsWith(folder.getPath() + File.separator)) throw new IllegalArgumentException("URI sementara di luar folder Jeda.");
        return file;
    }

    private long parseMetadata(MediaMetadataRetriever retriever, int key) {
        String value = retriever.extractMetadata(key);
        try { return value == null ? 0 : Long.parseLong(value); }
        catch (NumberFormatException ignored) { return 0; }
    }
}
