package com.bryan.revolutx;

import android.content.Context;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Push registration. Runs only in builds that had google-services.json (BuildConfig.HAS_FCM).
 * The FCM token is sent to POST {base}/api/app/devices with the dashboard key. Until the server has that
 * route it answers 404: that is ignored quietly and the app tries again on its next start.
 */
final class Push {

    static final String CHANNEL_ALERTS = "alerts";
    static final String CHANNEL_INFO = "info";

    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private Push() {}

    static void fetchTokenAndRegister(Context ctx) {
        if (!BuildConfig.HAS_FCM) return;
        final Context app = ctx.getApplicationContext();
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance()
                .getToken()
                .addOnSuccessListener(token -> onToken(app, token));
        } catch (Exception ignored) {
            // Firebase not initialised: push stays off, everything else works
        }
    }

    static void onToken(Context ctx, String token) {
        if (token == null || token.isEmpty()) return;
        SecureStore.get(ctx).edit().putString(SecureStore.PUSH_TOKEN, token).apply();
        registerSavedToken(ctx);
    }

    /** Sends the saved token, if there is one and the shell has handed over the key. */
    static void registerSavedToken(Context ctx) {
        if (!BuildConfig.HAS_FCM) return;
        final Context app = ctx.getApplicationContext();
        IO.execute(() -> {
            try {
                String token = SecureStore.get(app).getString(SecureStore.PUSH_TOKEN, null);
                String key = SecureStore.key(app);
                if (token == null || key == null) return;   // no key yet: WidgetBridge.setConfig calls this again
                JSONObject body = new JSONObject()
                    .put("token", token)
                    .put("platform", "android")
                    .put("app_version", BuildConfig.VERSION_NAME);
                HttpURLConnection c = (HttpURLConnection) new URL(SecureStore.base(app) + "/api/app/devices").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("x-api-token", key);
                try (OutputStream o = c.getOutputStream()) {
                    o.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                c.getResponseCode();   // 2xx registered; 404 = the server has no device registry yet; anything else: next start
                c.disconnect();
            } catch (Exception ignored) {
                // offline or the server is busy: tried again on the next start
            }
        });
    }
}
