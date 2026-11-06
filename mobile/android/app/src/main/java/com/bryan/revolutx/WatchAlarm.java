package com.bryan.revolutx;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.wearable.CapabilityClient;
import com.google.android.gms.wearable.ChannelClient;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Desk #59 (Bryan 15 Oct 09:40): the Rip alarm rings on the Galaxy Watch with the SAME sound as the phone. The phone's own
 * alarm notification is local-only (RipAlarm), so the watch does not also mirror it; this sends the watch its own alarm over
 * the Wearable Data Layer (the same path and the same same-key rule as the watch key, WatchBridge):
 *   /rx/watch/alarm          a message: {"coin","pct","price","id","sound"} - the coin name and numbers only (+ the sound's id)
 *   /rx/watch/sound/<id>     a channel: the audio of the tone Bryan chose for the Rip alarm ("Change >" opens Android's
 *                            sound list for it, so the tone lives on the phone; the watch gets a copy, once per tone, and
 *                            plays it on the alarm stream). The id is a hash of the tone's address, nothing else.
 * No watch, no Wear OS app or no Play services: nothing is sent and the phone rings as before. Runs on a background thread.
 */
final class WatchAlarm {

    static final String CAP_WATCH = WatchBridge.CAP_WATCH;
    static final String PATH_ALARM = "/rx/watch/alarm";
    static final String PATH_SOUND = "/rx/watch/sound/";
    private static final String TAG = "RxWatchAlarm";
    private static final String PREFS = "rx_watch_alarm";   // node -> the sound id that watch already has
    private static final String DIAG = "rx_watch_link";     // the last forward, for the Rip alarm card's "Watch link" line
    private static final long MAX_SOUND = 3 * 1024 * 1024;
    private static final Pattern PCT = Pattern.compile("\\+\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%");
    private static final Pattern TEST = Pattern.compile("RIP ALARM\\s*[-\u2013\u2014]?\\s*TEST\\b");
    private static final Pattern PRICE = Pattern.compile("(?i)\\bnow\\s+\\$\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)");

    private WatchAlarm() {}

    /**
     * The Rip alarm for each watch: the alarm first (so it rings at once, with the tone it has, else its own alarm sound), then
     * the tone when that watch does not have it yet. The numbers come from the push's own title and body ("🚨 RIP ALARM - SOL
     * +34% in 24 h", "Now $182.40 - you hold ..."); a part that cannot be read is left out, never guessed. Blocking (at most
     * ~25 s): call it off the main thread (FCM's onMessageReceived is). Each forward is recorded for the "Watch link" line
     * (15 Oct 14:56: Bryan cannot read the watch's log). Returns that record's one-line result.
     */
    static String send(Context ctx, Map<String, String> data) {
        Context app = ctx.getApplicationContext();
        JSONObject o = payload(data);
        if (o == null) {
            Log.i(TAG, "not forwarded to the watch: no coin and not a test");
            return record(app, false, "not forwarded: the push has no coin and is not a test", "");
        }
        String sent = "";
        try {
            List<Node> nodes = watches(app);
            if (nodes.isEmpty()) {
                Log.i(TAG, "not forwarded: no watch connected");   // the phone rings as before
                return record(app, false, "no watch found (no connected Wear OS node)", "");
            }
            Uri tone = tone(app);
            String sound = tone == null ? "" : soundId(tone);
            o.put("sound", sound);
            if (!o.optBoolean("test")) {   // 15 Oct 13:20: the coin's small logo, which the watch face flashes
                String logo = logo(app, o.optString("coin"));
                if (logo != null) o.put("logo", logo);
            }
            byte[] payload = o.toString().getBytes(StandardCharsets.UTF_8);
            StringBuilder failed = new StringBuilder();
            for (Node n : nodes) {
                try {
                    Tasks.await(Wearable.getMessageClient(app).sendMessage(n.getId(), PATH_ALARM, payload), 8, TimeUnit.SECONDS);
                    sent += (sent.isEmpty() ? "" : ", ") + label(n);
                    Log.i(TAG, "forwarded to the watch: " + o.optString("coin") + " -> " + label(n) + " (sound " + (sound.isEmpty() ? "default" : sound) + ")");
                } catch (Exception e) {
                    failed.append(failed.length() == 0 ? "" : "; ").append(label(n)).append(": ").append(why(e));
                    Log.w(TAG, "not forwarded to " + label(n) + ": " + why(e));
                }
            }
            for (Node n : nodes) if (!sound.isEmpty()) sendSound(app, n.getId(), tone, sound);   // after the alarm: it never waits on a tone
            if (sent.isEmpty()) return record(app, false, "send failed: " + failed, "");
            return record(app, true, "sent " + o.optString("coin") + (failed.length() > 0 ? "; failed: " + failed : ""), sent);
        } catch (Exception e) {
            Log.w(TAG, "watch alarm not sent: " + why(e));   // no watch: the phone rings as before
            return record(app, false, "error: " + why(e), sent);
        }
    }

    /**
     * Where the alarm goes: every watch with the Revolut X watch app (capability rx_watch), and every other connected node
     * too (15 Oct 14:56 (d): a watch whose capability is not seen yet is not filtered out; a node without the app ignores it).
     * The message carries no key, so it may go to any connected node.
     */
    static List<Node> watches(Context app) throws Exception {
        Map<String, Node> all = new LinkedHashMap<>();
        try {
            for (Node n : Tasks.await(Wearable.getCapabilityClient(app).getCapability(CAP_WATCH, CapabilityClient.FILTER_REACHABLE), 5, TimeUnit.SECONDS).getNodes()) all.put(n.getId(), n);
        } catch (Exception e) {
            Log.w(TAG, "capability lookup failed: " + why(e));
        }
        for (Node n : Tasks.await(Wearable.getNodeClient(app).getConnectedNodes(), 5, TimeUnit.SECONDS)) all.putIfAbsent(n.getId(), n);
        return new ArrayList<>(all.values());
    }

    /** The "Watch link" line's nodes: each connected node's name and id, and whether it has the watch app. */
    static JSONArray nodesJson(Context app) throws Exception {
        java.util.Set<String> withApp = new java.util.HashSet<>();
        try {
            for (Node n : Tasks.await(Wearable.getCapabilityClient(app).getCapability(CAP_WATCH, CapabilityClient.FILTER_ALL), 5, TimeUnit.SECONDS).getNodes()) withApp.add(n.getId());
        } catch (Exception ignored) {
            // shown as "app: not seen"
        }
        JSONArray out = new JSONArray();
        for (Node n : Tasks.await(Wearable.getNodeClient(app).getConnectedNodes(), 5, TimeUnit.SECONDS)) {
            out.put(new JSONObject().put("name", n.getDisplayName()).put("id", n.getId()).put("nearby", n.isNearby()).put("app", withApp.contains(n.getId())));
        }
        return out;
    }

    /** The last forward, for the "Watch link" line: {at, path, ok, result, to}. */
    static JSONObject last(Context app) {
        try {
            String j = app.getSharedPreferences(DIAG, Context.MODE_PRIVATE).getString("last", null);
            return j == null ? null : new JSONObject(j);
        } catch (Exception e) {
            return null;
        }
    }

    private static String record(Context app, boolean ok, String result, String to) {
        try {
            JSONObject j = new JSONObject().put("at", System.currentTimeMillis()).put("path", PATH_ALARM).put("ok", ok)
                .put("result", result.length() > 300 ? result.substring(0, 300) : result).put("to", to);
            app.getSharedPreferences(DIAG, Context.MODE_PRIVATE).edit().putString("last", j.toString()).commit();
        } catch (Exception ignored) {
            // the line shows the previous one
        }
        return result;
    }

    private static String label(Node n) {
        return n.getDisplayName() + " (" + n.getId() + ")";
    }

    /** An error as one short line: Play services' status code and name when it has one (e.g. 4000 TARGET_NODE_NOT_CONNECTED). */
    static String why(Throwable e) {
        Throwable c = e;
        while ((c instanceof java.util.concurrent.ExecutionException) && c.getCause() != null) c = c.getCause();
        if (c instanceof com.google.android.gms.common.api.ApiException) {
            int code = ((com.google.android.gms.common.api.ApiException) c).getStatusCode();
            return "ApiException " + code + " " + com.google.android.gms.wearable.WearableStatusCodes.getStatusCodeString(code);
        }
        if (c instanceof java.util.concurrent.TimeoutException) return "timed out";
        String m = c.getMessage();
        return c.getClass().getSimpleName() + (m == null ? "" : ": " + (m.length() > 120 ? m.substring(0, 120) : m));
    }

    /**
     * What goes to the watch for this alarm push, without the sound id; null when it is not one to forward. A real Rip alarm
     * has its coin; the server's test alarm (#523, "🚨 RIP ALARM - TEST (not a real move)") has none and goes as coin "TEST"
     * with no numbers, so the watch's sound can be tested any time.
     */
    static JSONObject payload(Map<String, String> data) {
        if (data == null) return null;
        String coin = data.get("coin");
        String title = data.get("title");
        String body = data.get("body");
        boolean test = TEST.matcher(title == null ? "" : title).find();
        try {
            JSONObject o = new JSONObject();
            if (test) {
                o.put("coin", "TEST").put("test", true);
            } else {
                if (coin == null || !coin.matches(MainActivity.COIN_RE)) return null;
                o.put("coin", coin);
                Double pct = number(PCT, title);
                if (pct == null) pct = number(PCT, body);
                Double price = number(PRICE, body);
                if (pct != null) o.put("pct", pct);
                if (price != null) o.put("price", price);
            }
            String id = data.get("inbox");
            if (id != null && id.matches(MainActivity.INBOX_RE)) o.put("id", id);
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** Phone-app start: hand the current tone to each watch that does not have it, so the first alarm needs no transfer. */
    static void syncSound(Context ctx) {
        Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try {
                Uri tone = tone(app);
                if (tone == null) return;
                String sound = soundId(tone);
                for (Node n : watches(app)) sendSound(app, n.getId(), tone, sound);
            } catch (Exception ignored) {
                // no watch: nothing to do
            }
        }, "rx-watch-sound").start();
    }

    /** The audio of the tone over a Data Layer channel, unless this watch already has this tone. At most 3 MB. */
    private static void sendSound(Context app, String node, Uri tone, String sound) {
        SharedPreferences p = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (sound.equals(p.getString(node, null))) return;
        ChannelClient cc = Wearable.getChannelClient(app);
        ChannelClient.Channel ch = null;
        try {
            ch = Tasks.await(cc.openChannel(node, PATH_SOUND + sound), 5, TimeUnit.SECONDS);
            long total = 0;
            try (InputStream in = app.getContentResolver().openInputStream(tone);
                 OutputStream out = Tasks.await(cc.getOutputStream(ch), 5, TimeUnit.SECONDS)) {
                if (in == null) return;
                byte[] buf = new byte[16 * 1024];
                for (int r; (r = in.read(buf)) > 0; ) {
                    total += r;
                    if (total > MAX_SOUND) throw new java.io.IOException("tone too large");
                    out.write(buf, 0, r);
                }
            }
            p.edit().putString(node, sound).apply();
        } catch (Exception e) {
            Log.w(TAG, "tone not sent to the watch (it rings its own alarm sound): " + e.getClass().getSimpleName());
        } finally {
            if (ch != null) {
                try {
                    Tasks.await(cc.close(ch), 3, TimeUnit.SECONDS);
                } catch (Exception ignored) {
                    // closed by the other side
                }
            }
        }
    }

    /**
     * The coin's logo as the app shows it (GET /api/coins/logo/COIN, the dashboard's own picture, with the phone's key as for any
     * dashboard read), shrunk to a 48 px PNG, base64; null when there is none or it does not decode (then the watch shows the
     * ticker). At most ~4 s.
     */
    static String logo(Context app, String coin) {
        String key = SecureStore.key(app);
        if (key == null || coin == null || !coin.matches(MainActivity.COIN_RE)) return null;
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(Config.BASE + "/api/coins/logo/" + coin).openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("x-api-token", key);
            if (c.getResponseCode() != 200) return null;
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] b = new byte[8192];
                for (int r; (r = in.read(b)) > 0; ) {
                    buf.write(b, 0, r);
                    if (buf.size() > 512 * 1024) return null;
                }
            }
            byte[] raw = buf.toByteArray();
            android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(raw, 0, raw.length);   // PNG, JPEG, WebP (an SVG does not decode: ticker)
            if (bmp == null) return null;
            android.graphics.Bitmap small = android.graphics.Bitmap.createScaledBitmap(bmp, 48, 48, true);
            java.io.ByteArrayOutputStream png = new java.io.ByteArrayOutputStream();
            small.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, png);
            return android.util.Base64.encodeToString(png.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (Exception e) {
            Log.w(TAG, "no logo for the watch: " + e.getClass().getSimpleName());
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** The tone Bryan chose for rx_alarm (Android's "Rip alarm" sound), else the default alarm tone. */
    static Uri tone(Context app) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = app.getSystemService(NotificationManager.class);
            NotificationChannel c = nm != null ? nm.getNotificationChannel(Push.CHANNEL_ALARM) : null;
            if (c != null && c.getSound() != null) return c.getSound();
        }
        return MainActivity.alarmTone();
    }

    /** 16 hex characters of SHA-256 over the tone's address: says "which tone", nothing else. */
    static String soundId(Uri tone) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(tone.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < 8; i++) b.append(String.format(Locale.US, "%02x", h[i]));
            return b.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static Double number(Pattern p, String s) {
        if (s == null) return null;
        Matcher m = p.matcher(s);
        if (!m.find()) return null;
        try {
            double v = Double.parseDouble(m.group(1).replace(",", ""));
            return Double.isNaN(v) || Double.isInfinite(v) ? null : v;
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
