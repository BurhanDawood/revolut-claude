package com.bryan.revolutx.wear;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Desk #59 W1/W2. The dashboard key lives only here: in this app's private EncryptedSharedPreferences (an AES-256 key in the
 * watch's Keystore). It is never put in a Tile, a complication, a log or any other storage. The last /api/watch numbers sit
 * in plain private prefs (numbers and counts only, no key).
 */
final class WatchStore {

    /** The only server the key may go to (the phone app's Config.BASE). */
    static final String BASE = "https://revolut-claude-production.up.railway.app";

    private static final String SECURE_FILE = "rx_watch_secure";
    private static final String VALUES_FILE = "rx_watch_values";
    private static final String K_KEY = "key";

    static final String V_SNAPSHOT = "snapshot";   // Snapshot.toJson(): the last good answer
    static final String V_FETCHED = "fetched";      // System.currentTimeMillis() of the last good answer
    static final String V_TRIED = "tried";          // ... of the last attempt
    static final String V_STATUS = "status";        // "" ok | offline | badkey | nokey | http:<code>
    static final String V_HELLO = "hello";          // ... of the last hello sent to the phone

    private static SharedPreferences secure;

    private WatchStore() {}

    private static synchronized SharedPreferences secure(Context ctx) {
        if (secure != null) return secure;
        Context app = ctx.getApplicationContext();
        try {
            secure = open(app);
        } catch (Exception e) {
            // the Keystore entry is gone: start clean; the phone hands the key over again on the next hello
            app.deleteSharedPreferences(SECURE_FILE);
            try {
                secure = open(app);
            } catch (Exception e2) {
                throw new IllegalStateException("secure storage unavailable");
            }
        }
        return secure;
    }

    private static SharedPreferences open(Context app) throws Exception {
        return EncryptedSharedPreferences.create(
            SECURE_FILE,
            MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
            app,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    static SharedPreferences values(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(VALUES_FILE, Context.MODE_PRIVATE);
    }

    /** The key, or null. Only Repo reads it, to send it to BASE. */
    static String key(Context ctx) {
        try {
            return secure(ctx).getString(K_KEY, null);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean hasKey(Context ctx) {
        return key(ctx) != null;
    }

    /**
     * W1: accepts a /rx/watch/config payload only when it is exactly {"base","key"}, base is exactly BASE and the key is
     * one plain token. The new key replaces the old one (never appended). Returns false, storing nothing, otherwise.
     */
    static boolean acceptConfig(Context ctx, byte[] payload) {
        String key;
        try {
            JSONObject o = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            if (o.length() != 2 || !o.has("base") || !o.has("key")) return false;
            if (!BASE.equals(o.get("base"))) return false;   // the key never goes to another server
            Object k = o.get("key");
            if (!(k instanceof String)) return false;
            key = ((String) k).trim();
        } catch (Exception e) {
            return false;
        }
        if (key.isEmpty() || key.length() > 512 || !key.matches("[\\x21-\\x7e]+")) return false;
        String old = key(ctx);
        try {
            if (!secure(ctx).edit().putString(K_KEY, key).commit()) return false;
        } catch (Exception e) {
            return false;   // secure storage unavailable: nothing stored
        }
        // a different key may read a different book: its numbers are fetched fresh
        if (!key.equals(old)) values(ctx).edit().clear().apply();
        return true;
    }

    /** W2: the phone's CLEAR. The key and the last values go. */
    static void clear(Context ctx) {
        try {
            secure(ctx).edit().clear().commit();
        } catch (Exception ignored) {
            ctx.getApplicationContext().deleteSharedPreferences(SECURE_FILE);
        }
        values(ctx).edit().clear().putString(V_STATUS, "nokey").commit();
    }

    static Snapshot snapshot(Context ctx) {
        return Snapshot.fromJson(values(ctx).getString(V_SNAPSHOT, null));
    }

    static String status(Context ctx) {
        if (!hasKey(ctx)) return "nokey";
        return values(ctx).getString(V_STATUS, "");
    }
}
