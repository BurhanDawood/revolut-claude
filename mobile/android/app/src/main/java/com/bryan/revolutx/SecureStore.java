package com.bryan.revolutx;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * The dashboard key, the server base and the widget's last values, in EncryptedSharedPreferences.
 * Nothing read from here is ever logged.
 */
final class SecureStore {

    static final String KEY = "key";
    static final String BASE = "base";
    static final String PUSH_TOKEN = "push_token";

    private static final String FILE = "rx_secure";
    private static SharedPreferences prefs;

    private SecureStore() {}

    static synchronized SharedPreferences get(Context ctx) {
        if (prefs != null) return prefs;
        Context app = ctx.getApplicationContext();
        try {
            prefs = open(app);
        } catch (Exception e) {
            // the Keystore entry is gone (e.g. restored from a backup): start clean; the shell hands the key over again on its next start
            app.deleteSharedPreferences(FILE);
            try {
                prefs = open(app);
            } catch (Exception e2) {
                throw new IllegalStateException("secure storage unavailable");
            }
        }
        return prefs;
    }

    private static SharedPreferences open(Context app) throws Exception {
        MasterKey mk = new MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        return EncryptedSharedPreferences.create(
            app,
            FILE,
            mk,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    static String key(Context ctx) {
        return get(ctx).getString(KEY, null);
    }

    /** The saved base, or the app's own server. Only https on the app's own host is accepted. */
    static String base(Context ctx) {
        String b = get(ctx).getString(BASE, null);
        return b != null ? b : Config.BASE;
    }
}
