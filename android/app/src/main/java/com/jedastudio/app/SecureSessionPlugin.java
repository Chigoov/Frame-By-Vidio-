package com.jedastudio.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureSession")
public class SecureSessionPlugin extends Plugin {
    private static final String KEY_ALIAS = "jeda.supabase.session.v1";
    private static final String PREFS = "jeda_secure_session";
    private static final String TOKEN = "supabase_session";

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String stored = getContext().getSharedPreferences(PREFS, 0).getString(TOKEN, null);
            if (stored == null) {
                call.resolve();
                return;
            }
            byte[] packed = Base64.decode(stored, Base64.NO_WRAP);
            byte[] iv = new byte[12];
            byte[] ciphertext = new byte[packed.length - iv.length];
            System.arraycopy(packed, 0, iv, 0, iv.length);
            System.arraycopy(packed, iv.length, ciphertext, 0, ciphertext.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getKey(), new GCMParameterSpec(128, iv));
            call.resolve(new com.getcapacitor.JSObject().put("value", new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)));
        } catch (Exception error) {
            call.reject("Sesi aman tidak dapat dibuka di perangkat ini.", error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        try {
            String value = call.getString("value");
            if (value == null || value.length() > 65536) {
                call.reject("Data sesi kosong atau terlalu besar.");
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getKey());
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] packed = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, packed, 0, iv.length);
            System.arraycopy(ciphertext, 0, packed, iv.length, ciphertext.length);
            getContext().getSharedPreferences(PREFS, 0).edit().putString(TOKEN, Base64.encodeToString(packed, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Sesi aman tidak dapat disimpan.", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        getContext().getSharedPreferences(PREFS, 0).edit().remove(TOKEN).apply();
        call.resolve();
    }

    private SecretKey getKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
