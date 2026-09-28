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
    // v8 (batch 498): one channel per sound/vibrate choice; the server sends these only to devices registered with caps "ch2"
    static final String CHANNEL_LOUD = "rx_loud";
    static final String CHANNEL_SOUND = "rx_sound";
    static final String CHANNEL_BUZZ = "rx_buzz";
    static final String CHANNEL_QUIET = "rx_quiet";
    // v10 (batch 503): one channel per alert category, rx_c_<cat>; the server sends these only to devices with caps "ch3"
    static final String CHANNEL_CAT_PREFIX = "rx_c_";
    /** The alert categories, in the order the app and RxNotify.channels() list them. One list: CAT_RE must match it. */
    static final String[] CATS = { "needs", "money", "price", "loops", "agent", "reports", "system" };
    static final String CAT_RE = "needs|money|price|loops|agent|reports|system";
    /** What this app can show; the server stores it with the token. "ch2" = the four rx_* channels, "ch3" = the rx_c_* ones. */
    static final String CAPS = "ch2,ch3";

    static boolean isCatChannel(String ch) {
        return ch != null && ch.startsWith(CHANNEL_CAT_PREFIX) && ch.substring(CHANNEL_CAT_PREFIX.length()).matches(CAT_RE);
    }

    /** A channel id from the server, or alerts for anything this app does not have. */
    static String knownChannel(String ch) {
        if (ch == null) return CHANNEL_ALERTS;
        if (isCatChannel(ch)) return ch;
        switch (ch) {
            case CHANNEL_ALERTS:
            case CHANNEL_INFO:
            case CHANNEL_LOUD:
            case CHANNEL_SOUND:
            case CHANNEL_BUZZ:
            case CHANNEL_QUIET:
                return ch;
            default:
                return CHANNEL_ALERTS;
        }
    }

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
                    .put("app_version", BuildConfig.VERSION_NAME)
                    .put("caps", CAPS);
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
