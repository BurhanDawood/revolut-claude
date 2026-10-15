package com.bryan.revolutx.wear;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Locale;
import org.json.JSONObject;

/**
 * Desk #59 (Bryan 15 Oct 09:40): the Rip alarm on the watch, rung by the watch itself with the tone Bryan chose on the phone.
 * The phone sends /rx/watch/alarm {"coin","pct","price","id","sound"} (numbers and the coin name only) and, once per tone,
 * the tone's audio on /rx/watch/sound/<id> (KeyListener). This service plays it on the ALARM stream (it rings through the
 * watch's Do Not Disturb, like a clock alarm) with the phone's alarm vibration, for at most 30 s; its notification on
 * "Rip alarm" (high importance, alarm category, full-screen RipAlarmActivity) reads "🚨 COIN +X% in 24 h · $price".
 * Stop, a swipe of the notification, or opening it stops the sound. Without the tone (not received yet), the watch's
 * default alarm sound. Nothing is sent anywhere.
 */
public class RipRing extends Service {

    static final String CHANNEL = "rx_rip_alarm";
    static final String ACTION_RING = "com.bryan.revolutx.wear.RIP_RING";
    static final String ACTION_STOP = "com.bryan.revolutx.wear.RIP_STOP";
    static final String EXTRA_JSON = "rx_rip_json";
    static final int NOTIFICATION_ID = 5930;
    static final long RING_MS = 30_000;
    /** The phone's alarm vibration (MainActivity.ALARM_VIBRATION): three quick taps then a long buzz, twice. */
    static final long[] VIBRATION = { 0, 150, 100, 150, 100, 150, 400, 900, 600, 150, 100, 150, 100, 150, 400, 900 };
    private static final String TAG = "RxRipRing";
    private static final AudioAttributes ALARM = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build();

    private static RipRing running;
    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaPlayer player;
    private Vibrator vibrator;

    /** One alarm, checked: the coin as a ticker, numbers as numbers, the ids as plain tokens. Null when it is not one. */
    static final class Alarm {
        String coin;
        double pct = Double.NaN;
        double price = Double.NaN;
        String id = "";
        String sound = "";
        boolean test;   // the server's test alarm (#523): coin "TEST", no numbers

        static Alarm parse(byte[] payload) {
            try {
                JSONObject o = new JSONObject(new String(payload, java.nio.charset.StandardCharsets.UTF_8));
                Alarm a = new Alarm();
                a.coin = o.optString("coin", "").toUpperCase(Locale.US);
                if (!TileCoins.valid(a.coin)) return null;
                a.pct = o.optDouble("pct", Double.NaN);
                a.price = o.optDouble("price", Double.NaN);
                String id = o.optString("id", "");
                a.id = id.matches("[A-Za-z0-9_-]{1,40}") ? id : "";
                String sound = o.optString("sound", "");
                a.sound = sound.matches("[0-9a-f]{16}") ? sound : "";
                a.test = o.optBoolean("test", false) && "TEST".equals(a.coin);
                return a;
            } catch (Exception e) {
                return null;
            }
        }

        String toJson() {
            try {
                JSONObject o = new JSONObject().put("coin", coin).put("id", id).put("sound", sound).put("test", test);
                if (!Double.isNaN(pct)) o.put("pct", pct);
                if (!Double.isNaN(price)) o.put("price", price);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        /** "🚨 SOL +34% in 24 h · $182.40" */
        String text() {
            if (test) return "\uD83D\uDEA8 RIP ALARM TEST";
            StringBuilder b = new StringBuilder("🚨 ").append(coin);
            if (!Double.isNaN(pct)) b.append(" +").append(Math.abs(pct) >= 10 ? String.format(Locale.US, "%.0f", pct) : String.format(Locale.US, "%.1f", pct)).append('%');
            b.append(" in 24 h");
            if (!Double.isNaN(price)) b.append(" · ").append(Fmt.price(price));
            return b.toString();
        }
    }

    // ── from KeyListener ──

    /** Rings this alarm (the listener's background thread). */
    static void ring(Context ctx, Alarm a) {
        Context app = ctx.getApplicationContext();
        ensureChannel(app);
        Intent i = new Intent(app, RipRing.class).setAction(ACTION_RING).putExtra(EXTRA_JSON, a.toJson());
        try {
            app.startForegroundService(i);
        } catch (Exception e) {
            // not allowed to start from the background here: the notification's full-screen RipAlarmActivity starts the
            // ringing instead (an activity on screen may)
            Log.w(TAG, "ring service not started from the background, the alarm screen will: " + e.getClass().getSimpleName());
            NotificationManager nm = app.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIFICATION_ID, notification(app, a));
            Log.i(TAG, "posted the Rip alarm notification (full-screen alarm to ring): " + a.coin);
        }
    }

    /** /rx/watch/sound/<id>: the tone's file. Only the newest tone is kept. */
    static File soundFile(Context ctx, String id) {
        File dir = new File(ctx.getFilesDir(), "rip-sound");
        if (!dir.isDirectory()) dir.mkdirs();
        return new File(dir, id);
    }

    /** Keeps the received tone (at most 3 MB) and drops older ones. */
    static void keepSound(Context ctx, String id, InputStream in) throws java.io.IOException {
        if (!id.matches("[0-9a-f]{16}")) return;
        File f = soundFile(ctx, id);
        File tmp = new File(f.getParentFile(), id + ".part");
        long total = 0;
        try (InputStream s = in; FileOutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[16 * 1024];
            for (int r; (r = s.read(buf)) > 0; ) {
                total += r;
                if (total > 3 * 1024 * 1024) throw new java.io.IOException("tone too large");
                out.write(buf, 0, r);
            }
        }
        if (total == 0 || !tmp.renameTo(f)) {
            tmp.delete();
            return;
        }
        File[] all = f.getParentFile().listFiles();
        if (all != null) for (File o : all) if (!o.getName().equals(id)) o.delete();
    }

    static void ensureChannel(Context app) {
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel c = new NotificationChannel(CHANNEL, "Rip alarm", NotificationManager.IMPORTANCE_HIGH);
        c.setDescription("A coin you hold up 30%+ in 24 h: rings with the phone's Rip alarm tone");
        c.setSound(null, null);          // the service plays the tone itself, on the alarm stream
        c.enableVibration(false);        // and vibrates with the alarm pattern
        c.setBypassDnd(true);            // honoured where Do Not Disturb access is given; the sound rings through DND anyway
        c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(c);
    }

    static Notification notification(Context ctx, Alarm a) {
        PendingIntent open = PendingIntent.getActivity(ctx, 1,
            new Intent(ctx, RipAlarmActivity.class).putExtra(EXTRA_JSON, a.toJson()).putExtra(RipAlarmActivity.EXTRA_OPEN_COIN, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent full = PendingIntent.getActivity(ctx, 2,
            new Intent(ctx, RipAlarmActivity.class).putExtra(EXTRA_JSON, a.toJson()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getBroadcast(ctx, 3, new Intent(ctx, Stop.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_rx)
            .setColor(0xFFFF4D6A)
            .setContentTitle(a.text())
            .setContentText(a.test ? "A test - nothing moved, nothing trades" : "Rip alarm - tap to open " + a.coin)
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(open)
            .setFullScreenIntent(full, true)
            .setDeleteIntent(stop)
            .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
            .setAutoCancel(true)
            .build();
    }

    // ── the service ──

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !ACTION_RING.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String json = intent.getStringExtra(EXTRA_JSON);
        Alarm a = json == null ? null : Alarm.parse(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (a == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification n = notification(this, a);
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
            else startForeground(NOTIFICATION_ID, n);
            Log.i(TAG, "posted the Rip alarm notification: " + a.coin);
        } catch (Exception e) {
            Log.w(TAG, "not foreground: " + e.getClass().getSimpleName());
        }
        if (running != null && running != this) running.silence();
        running = this;
        silence();
        play(a.sound);
        vibrate();
        main.removeCallbacksAndMessages(null);
        main.postDelayed(this::finishRinging, RING_MS);   // at most 30 s
        return START_NOT_STICKY;
    }

    private void play(String sound) {
        File f = sound.isEmpty() ? null : soundFile(this, sound);
        Uri[] tries = {
            f != null && f.isFile() ? Uri.fromFile(f) : null,                // the phone's chosen tone
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),         // else the watch's own alarm sound
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
        };
        for (Uri u : tries) {
            if (u == null) continue;
            MediaPlayer p = new MediaPlayer();
            try {
                p.setAudioAttributes(ALARM);
                p.setDataSource(this, u);
                p.setLooping(true);
                p.prepare();
                p.start();
                player = p;
                Log.i(TAG, "ringing: " + (u == tries[0] ? "the phone's tone" : "the watch's alarm sound"));
                return;
            } catch (Exception e) {
                p.release();
            }
        }
        Log.w(TAG, "no tone could be played; vibrating only");
    }

    private void vibrate() {
        vibrator = getSystemService(Vibrator.class);
        if (vibrator == null || !vibrator.hasVibrator()) return;
        try {
            vibrator.vibrate(VibrationEffect.createWaveform(VIBRATION, 0), ALARM);   // repeats until stopped; alarm usage passes DND
        } catch (Exception ignored) {
            // no vibration
        }
    }

    private void silence() {
        if (player != null) {
            try {
                player.stop();
            } catch (Exception ignored) {
                // already stopped
            }
            player.release();
            player = null;
        }
        if (vibrator != null) vibrator.cancel();
    }

    /** 30 s are up: the sound and vibration stop; the notification stays until read or swiped. */
    private void finishRinging() {
        silence();
        try {
            stopForeground(STOP_FOREGROUND_DETACH);
        } catch (Exception ignored) {
            // not foreground
        }
        if (running == this) running = null;
        stopSelf();
    }

    static boolean isRinging() {
        return running != null;
    }

    /** Stop, a swipe or opening it: the sound stops at once. */
    static void stopRinging(Context ctx) {
        RipRing r = running;
        if (r != null) r.main.post(r::finishRinging);
    }

    @Override
    public void onTimeout(int startId, int fgsType) {   // Android 15's limit for a short service; 30 s never gets there
        finishRinging();
    }

    @Override
    public void onDestroy() {
        silence();
        if (running == this) running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** The notification's Stop, or a swipe. */
    public static class Stop extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            if (intent == null || !ACTION_STOP.equals(intent.getAction())) return;
            stopRinging(ctx);
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
        }
    }
}
