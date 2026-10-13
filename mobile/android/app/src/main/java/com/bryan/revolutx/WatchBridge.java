package com.bryan.revolutx;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.android.gms.wearable.CapabilityClient;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Desk #59 W1/W2/W7: hands the WATCH-ONLY key to the Revolut X watch app over the Wearable Data Layer. The dashboard key
 * never leaves the phone: the watch key is the server's watch-only token, which opens GET /api/watch and nothing else (W6). The
 * shell reads it from GET /api/watch/key and passes it to WidgetBridge.setConfig as watchKey; WatchListener re-reads it
 * when the watch asks (a 401 after a rotation).
 *
 * Messages only (MessageClient), never a DataItem, so the key is not kept in Play services' synced storage on either side.
 *   /rx/watch/config  payload exactly {"base","key"}; key = the watch key, base is always Config.BASE
 *   /rx/watch/clear   empty: the watch deletes its key and its last values
 *   /rx/watch/hello   watch -> phone, empty: "send me the current one" (WatchListener)
 * The watch is cleared only on an explicit "no watch key" (the server's { key: null }, or the dashboard key removed),
 * never because a fetch failed (Fable 625 C2). A changed watch key is sent as CLEAR then config; each config replaces the
 * watch's one key. Nothing about either key is logged.
 */
final class WatchBridge {

    static final String CAP_WATCH = "rx_watch";   // declared by the watch app (wear/src/main/res/values/wear.xml)
    static final String PATH_CONFIG = "/rx/watch/config";
    static final String PATH_CLEAR = "/rx/watch/clear";
    static final String PATH_HELLO = "/rx/watch/hello";

    /** One printable token, as the server's /api/watch/key checks it. */
    private static final String WATCH_KEY_RE = "[\\x21-\\x7e]{24,512}";

    private static long lastServerRead = 0;

    private WatchBridge() {}

    // ── what the shell tells us (WidgetBridgePlugin) ──

    /** The server's watch key (from the shell). An invalid one, or one equal to the dashboard key, counts as none. */
    static void setWatchKey(Context ctx, String watchKey) {
        Context app = ctx.getApplicationContext();
        if (watchKey == null || !watchKey.matches(WATCH_KEY_RE) || watchKey.equals(SecureStore.key(app))) {
            noWatchKey(app);
            return;
        }
        if (watchKey.equals(SecureStore.watchKey(app))) return;   // unchanged: the start-up sync covers it
        if (!SecureStore.get(app).edit().putString(SecureStore.WATCH_KEY, watchKey).remove(SecureStore.WATCH_NONE).commit()) return;
        eachWatch(app, node ->
            Wearable.getMessageClient(app).sendMessage(node, PATH_CLEAR, new byte[0])
                .addOnCompleteListener(t -> sendCurrent(app, node))
        );
    }

    /** An explicit "no watch key" (the server has none, or the dashboard key was removed): the watch is cleared. */
    static void noWatchKey(Context ctx) {
        Context app = ctx.getApplicationContext();
        boolean ok;
        try {
            ok = SecureStore.get(app).edit().remove(SecureStore.WATCH_KEY).putBoolean(SecureStore.WATCH_NONE, true).commit();
        } catch (Exception e) {
            ok = false;
        }
        // commit() returns false on a failed write: then the file goes, so the old watch key is never re-sent on a hello
        if (!ok) SecureStore.reset(app);
        eachWatch(app, node -> Wearable.getMessageClient(app).sendMessage(node, PATH_CLEAR, new byte[0]));
    }

    // ── sending ──

    /** Phone-app start: what the phone knows now (see sendCurrent). */
    static void sync(Context ctx) {
        Context app = ctx.getApplicationContext();
        eachWatch(app, node -> sendCurrent(app, node));
    }

    /**
     * One watch: the watch key when there is one; a CLEAR when there is explicitly none (or no dashboard key at all);
     * nothing when the phone simply has not learned a watch key yet (it must not wipe a working one).
     */
    static void sendCurrent(Context app, String node) {
        String wk = SecureStore.watchKey(app);
        if (wk != null && wk.matches(WATCH_KEY_RE) && !wk.equals(SecureStore.key(app))) {
            byte[] payload = configPayload(wk);
            if (payload != null) Wearable.getMessageClient(app).sendMessage(node, PATH_CONFIG, payload);
        } else if (SecureStore.key(app) == null || SecureStore.get(app).getBoolean(SecureStore.WATCH_NONE, false)) {
            Wearable.getMessageClient(app).sendMessage(node, PATH_CLEAR, new byte[0]);
        }
    }

    private static byte[] configPayload(String watchKey) {
        try {
            return new JSONObject().put("base", Config.BASE).put("key", watchKey).toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    // ── the watch asked (WatchListener, a background thread) ──

    /**
     * W7: re-reads GET /api/watch/key with the dashboard key (at most once a minute; a rotation of the watch token shows on the
     * watch as a 401 and then a hello), then answers this watch. A failed read changes nothing.
     */
    static void answerHello(Context ctx, String node) {
        Context app = ctx.getApplicationContext();
        String key = SecureStore.key(app);
        long now = System.currentTimeMillis();
        if (key != null && now - lastServerRead > 60_000) {
            lastServerRead = now;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(Config.BASE + "/api/watch/key").openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(10000);
                c.setInstanceFollowRedirects(false);
                c.setUseCaches(false);
                c.setRequestProperty("x-api-token", key);
                c.setRequestProperty("Accept", "application/json");
                if (c.getResponseCode() == 200) {
                    JSONObject j = new JSONObject(read(c.getInputStream()));
                    SharedPreferences p = SecureStore.get(app);
                    if (j.has("key") && j.isNull("key")) {
                        if (!p.edit().remove(SecureStore.WATCH_KEY).putBoolean(SecureStore.WATCH_NONE, true).commit()) SecureStore.reset(app);
                    } else {
                        Object wk = j.opt("key");
                        if (wk instanceof String && ((String) wk).matches(WATCH_KEY_RE) && !wk.equals(key)) {
                            p.edit().putString(SecureStore.WATCH_KEY, (String) wk).remove(SecureStore.WATCH_NONE).commit();
                        }
                    }
                }
            } catch (Exception ignored) {
                // offline or the server is busy: the watch keeps what it has
            } finally {
                if (c != null) c.disconnect();
            }
        }
        sendCurrent(app, node);
    }

    private static String read(InputStream in) throws java.io.IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = s.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                if (out.size() > 16 * 1024) throw new java.io.IOException("too large");
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private interface NodeAction {
        void run(String nodeId);
    }

    /**
     * Every reachable watch that has the Revolut X watch app. No watch, no Wear OS app or no Play services: the Task fails and
     * nothing is sent. Any node that can reach us with a hello also gets the watch key: the real gate is the Data Layer's rule
     * that only an app with this same package name AND signing certificate can send to us or receive from us.
     */
    private static void eachWatch(Context app, NodeAction action) {
        Wearable.getCapabilityClient(app).getCapability(CAP_WATCH, CapabilityClient.FILTER_REACHABLE)
            .addOnSuccessListener(info -> {
                for (Node n : info.getNodes()) action.run(n.getId());
            })
            .addOnFailureListener(e -> { /* no watch reachable: the watch's hello asks again later */ });
    }
}
