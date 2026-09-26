package com.jedastudio.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import org.tensorflow.lite.Interpreter;

@CapacitorPlugin(name = "VdsrUpscaler")
public class VdsrUpscalerPlugin extends Plugin {
    private static final int MODEL_SIZE = 256;
    private static final int HALO = 24;
    private static final int CORE = MODEL_SIZE - HALO * 2;
    private static final long MAX_INPUT_PIXELS = 12_000_000L;
    private static final long MAX_OUTPUT_PIXELS = 10_000_000L;
    private static final int MAX_SOURCE_BYTES = 20 * 1024 * 1024;
    private static final int MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
    private Interpreter interpreter;

    @PluginMethod
    public void upscaleImage(PluginCall call) {
        String sourceUri = call.getString("sourceUri");
        Integer scale = call.getInt("scale");
        String format = call.getString("format", "png");
        Integer quality = call.getInt("quality", 92);
        if (sourceUri == null || sourceUri.length() > 2048 || scale == null || (scale != 2 && scale != 4)
            || !validFormat(format) || quality == null || quality < 1 || quality > 100) {
            call.reject("Foto sumber atau ukuran AI tidak valid.");
            return;
        }
        execute(() -> {
            try {
                call.resolve(runVdsr(sourceUri, scale, format, quality));
            } catch (OutOfMemoryError error) {
                System.gc();
                call.reject("Memori perangkat tidak cukup untuk AI upscale. Coba 2× atau ambil frame dari video beresolusi lebih kecil.");
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "AI upscale gagal di perangkat." : error.getMessage(), error);
            }
        });
    }

    private synchronized JSObject runVdsr(String sourceUri, int scale, String format, int quality) throws Exception {
        Uri uri = Uri.parse(sourceUri);
        if (!"file".equals(uri.getScheme())) throw new IllegalArgumentException("File sumber AI tidak valid.");
        File frameFolder = new File(getContext().getCacheDir(), "jeda-frames").getCanonicalFile();
        File sourceFile = new File(uri.getPath()).getCanonicalFile();
        if (!sourceFile.getPath().startsWith(frameFolder.getPath() + File.separator)) throw new IllegalArgumentException("File sumber AI di luar folder sementara Jeda.");
        byte[] encoded;
        try (InputStream sourceStream = getContext().getContentResolver().openInputStream(uri); ByteArrayOutputStream sourceBuffer = new ByteArrayOutputStream()) {
            if (sourceStream == null) throw new IllegalArgumentException("Frame sumber AI tidak ditemukan.");
            byte[] chunk = new byte[16 * 1024];
            int total = 0;
            for (int read; (read = sourceStream.read(chunk)) >= 0;) {
                total += read;
                if (total > MAX_SOURCE_BYTES) throw new IllegalArgumentException("Foto sumber melebihi batas AI upscale 20 MB.");
                sourceBuffer.write(chunk, 0, read);
            }
            encoded = sourceBuffer.toByteArray();
        }
        if (encoded.length == 0 || encoded.length > MAX_SOURCE_BYTES) throw new IllegalArgumentException("Foto sumber melebihi batas AI upscale 20 MB.");
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(encoded, 0, encoded.length, bounds);
        if (bounds.outWidth < 1 || bounds.outHeight < 1 || (long) bounds.outWidth * bounds.outHeight > MAX_INPUT_PIXELS) {
            throw new IllegalArgumentException("Resolusi video terlalu besar untuk AI upscale offline.");
        }
        long outputWidthLong = (long) bounds.outWidth * scale;
        long outputHeightLong = (long) bounds.outHeight * scale;
        // ponytail: multiple full-size pixel buffers need heap headroom; raise this only after device profiling.
        long safePixels = Math.min(MAX_OUTPUT_PIXELS, Runtime.getRuntime().maxMemory() / 32L);
        if (outputWidthLong > 8192 || outputHeightLong > 8192 || outputWidthLong * outputHeightLong > safePixels) {
            throw new IllegalArgumentException("Hasil AI melebihi batas memori aman perangkat. Coba 2× atau video sumber lebih kecil.");
        }
        int outputWidth = (int) outputWidthLong;
        int outputHeight = (int) outputHeightLong;
        Bitmap source = BitmapFactory.decodeByteArray(encoded, 0, encoded.length);
        if (source == null) throw new IllegalArgumentException("Foto frame tidak dapat dibaca.");
        Bitmap scaled = Bitmap.createScaledBitmap(source, outputWidth, outputHeight, true);
        if (source != scaled) source.recycle();
        int[] inputPixels = new int[outputWidth * outputHeight];
        scaled.getPixels(inputPixels, 0, outputWidth, 0, 0, outputWidth, outputHeight);
        scaled.recycle();

        int[] outputPixels = new int[inputPixels.length];
        int tilePixels = MODEL_SIZE * MODEL_SIZE;
        ByteBuffer input = ByteBuffer.allocateDirect(tilePixels * Float.BYTES).order(ByteOrder.nativeOrder());
        ByteBuffer output = ByteBuffer.allocateDirect(tilePixels * Float.BYTES).order(ByteOrder.nativeOrder());
        Interpreter model = getInterpreter();
        for (int top = 0; top < outputHeight; top += CORE) {
            for (int left = 0; left < outputWidth; left += CORE) {
                input.clear();
                for (int row = 0; row < MODEL_SIZE; row++) {
                    int y = clamp(top + row - HALO, outputHeight - 1);
                    int rowOffset = y * outputWidth;
                    for (int column = 0; column < MODEL_SIZE; column++) {
                        int x = clamp(left + column - HALO, outputWidth - 1);
                        int pixel = inputPixels[rowOffset + x];
                        float luminance = (0.299f * ((pixel >>> 16) & 255) + 0.587f * ((pixel >>> 8) & 255) + 0.114f * (pixel & 255)) / 255f;
                        input.putFloat(luminance);
                    }
                }
                input.rewind();
                output.clear();
                model.run(input, output);
                output.rewind();
                for (int row = HALO; row < MODEL_SIZE - HALO && top + row - HALO < outputHeight; row++) {
                    int y = top + row - HALO;
                    for (int column = HALO; column < MODEL_SIZE - HALO && left + column - HALO < outputWidth; column++) {
                        int x = left + column - HALO;
                        int sourcePixel = inputPixels[y * outputWidth + x];
                        float newY = Math.max(0f, Math.min(1f, output.getFloat((row * MODEL_SIZE + column) * Float.BYTES))) * 255f;
                        outputPixels[y * outputWidth + x] = recombineLuminance(sourcePixel, newY);
                    }
                }
            }
        }
        inputPixels = null;
        Bitmap result = Bitmap.createBitmap(outputPixels, outputWidth, outputHeight, Bitmap.Config.ARGB_8888);
        outputPixels = null;
        File outputFile = new File(frameFolder, java.util.UUID.randomUUID() + "." + extension(format));
        try (FileOutputStream encodedOutput = new FileOutputStream(outputFile)) {
            if (!result.compress(compressFormat(format), quality, encodedOutput)) throw new IllegalArgumentException("Hasil AI gagal dibuat.");
        } catch (Exception | Error error) { outputFile.delete(); throw error; }
        finally { result.recycle(); }
        if (outputFile.length() == 0 || outputFile.length() > MAX_OUTPUT_BYTES) {
            outputFile.delete();
            throw new IllegalArgumentException("Hasil AI melebihi batas aman 24 MB. Coba 2× atau resolusi sumber yang lebih kecil.");
        }
        JSObject response = new JSObject();
        response.put("uri", Uri.fromFile(outputFile).toString());
        response.put("width", outputWidth);
        response.put("height", outputHeight);
        response.put("sizeBytes", outputFile.length());
        response.put("format", format);
        response.put("mimeType", mimeType(format));
        return response;
    }

    private boolean validFormat(String format) { return "png".equals(format) || "jpeg".equals(format) || "webp".equals(format); }
    private String extension(String format) { return "jpeg".equals(format) ? "jpg" : format; }
    private String mimeType(String format) { return "jpeg".equals(format) ? "image/jpeg" : "image/" + format; }
    private Bitmap.CompressFormat compressFormat(String format) {
        if ("jpeg".equals(format)) return Bitmap.CompressFormat.JPEG;
        if ("webp".equals(format)) return Bitmap.CompressFormat.WEBP;
        return Bitmap.CompressFormat.PNG;
    }

    private Interpreter getInterpreter() throws Exception {
        if (interpreter != null) return interpreter;
        byte[] modelBytes;
        try (InputStream asset = getContext().getAssets().open("vdsr_256.tflite"); ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[16 * 1024];
            for (int read; (read = asset.read(chunk)) >= 0;) buffer.write(chunk, 0, read);
            modelBytes = buffer.toByteArray();
        }
        ByteBuffer modelBuffer = ByteBuffer.allocateDirect(modelBytes.length).order(ByteOrder.nativeOrder());
        modelBuffer.put(modelBytes).rewind();
        Interpreter.Options options = new Interpreter.Options().setNumThreads(2);
        interpreter = new Interpreter(modelBuffer, options);
        return interpreter;
    }

    private int recombineLuminance(int pixel, float y) {
        float red = (pixel >>> 16) & 255;
        float green = (pixel >>> 8) & 255;
        float blue = pixel & 255;
        float cb = 128f - 0.168736f * red - 0.331264f * green + 0.5f * blue;
        float cr = 128f + 0.5f * red - 0.418688f * green - 0.081312f * blue;
        // VDSR changes luminance; keeping the source chroma avoids hue shifts.
        int outR = clamp(Math.round(y + 1.402f * (cr - 128f)), 255);
        int outG = clamp(Math.round(y - 0.344136f * (cb - 128f) - 0.714136f * (cr - 128f)), 255);
        int outB = clamp(Math.round(y + 1.772f * (cb - 128f)), 255);
        return 0xff000000 | (outR << 16) | (outG << 8) | outB;
    }

    private int clamp(int value, int maximum) { return Math.max(0, Math.min(maximum, value)); }

    @Override
    protected void handleOnDestroy() {
        if (interpreter != null) interpreter.close();
        interpreter = null;
        super.handleOnDestroy();
    }
}
