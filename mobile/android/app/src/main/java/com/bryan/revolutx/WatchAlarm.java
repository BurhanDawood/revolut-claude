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
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
    private static final long MAX_SOUND = 3 * 1024 * 1024;
    private static final Pattern PCT = Pattern.compile("\\+\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%");
    private static final Pattern TEST = Pattern.compile("RIP ALARM\\s*[-\u2013\u2014]?\\s*TEST\\b");
    private static final Pattern PRICE = Pattern.compile("(?i)\\bnow\\s+\\$\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)");

    private WatchAlarm() {}

    /**
     * The Rip alarm for each reachable watch: its tone first when that watch does not have it yet, then the alarm. The numbers
     * come from the push's own title and body ("🚨 RIP ALARM - SOL +34% in 24 h", "Now $182.40 - you hold ..."); a part that
     * cannot be read is left out, never guessed. Blocking (at most ~25 s): call it off the main thread.
     */
    static void send(Context ctx, Map<String, String> data) {
        Context app = ctx.getApplicationContext();
        JSONObject o = payload(data);
        if (o == null) {
            Log.i(TAG, "not forwarded to the watch: no coin and not a test");
            return;
        }
        try {
            Set<Node> nodes = Tasks.await(
                Wearable.getCapabilityClient(app).getCapability(CAP_WATCH, CapabilityClient.FILTER_REACHABLE), 5, TimeUnit.SECONDS
            ).getNodes();
            if (nodes.isEmpty()) {
                Log.i(TAG, "not forwarded: no watch with the Revolut X watch app is reachable");   // the phone rings as before
                return;
            }
            Uri tone = tone(app);
            String sound = tone == null ? "" : soundId(tone);
            o.put("sound", sound);
            byte[] payload = o.toString().getBytes(StandardCharsets.UTF_8);
            for (Node n : nodes) {
                if (!sound.isEmpty()) sendSound(app, n.getId(), tone, sound);   // a new tone first, so the watch rings with it
                Tasks.await(Wearable.getMessageClient(app).sendMessage(n.getId(), PATH_ALARM, payload), 5, TimeUnit.SECONDS);
                Log.i(TAG, "forwarded to the watch: " + o.optString("coin") + " (sound " + (sound.isEmpty() ? "default" : sound) + ")");
            }
        } catch (Exception e) {
            Log.w(TAG, "watch alarm not sent: " + e.getClass().getSimpleName());   // no watch: the phone rings as before
        }
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
                Set<Node> nodes = Tasks.await(
                    Wearable.getCapabilityClient(app).getCapability(CAP_WATCH, CapabilityClient.FILTER_REACHABLE), 5, TimeUnit.SECONDS
                ).getNodes();
                for (Node n : nodes) sendSound(app, n.getId(), tone, sound);
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
