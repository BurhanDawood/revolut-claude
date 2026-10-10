package com.bryan.revolutx;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.Map;

/**
 * v11 (batch 514): the rip alarm. The server sends a data-only, high-priority message with data.alarm = "1" when a coin
 * Bryan holds is up 30%+ in 24 h (one per coin per day). It is shown on rx_alarm: alarm tone, its own vibration,
 * repeating (FLAG_INSISTENT) until tapped, stopped or swiped, and for at most 10 minutes; over the lock screen through
 * AlarmActivity (full-screen intent). Only a validated coin and feed id reach an intent's deep link; title and body are
 * shown as plain text only.
 * v12: the notification system obeys the ringer mode, so on silent v11 made no sound. Now RipAlarmService rings it: the
 * tone on the alarm stream and an alarm vibration, like a clock app, with a silent notification on rx_alarm_ring. The
 * v11 notification is only the fallback when the service cannot be started.
 */
final class RipAlarm {

    static final String EXTRA_ID = "rx_alarm_id";
    static final String EXTRA_TITLE = "rx_alarm_title";
    static final String EXTRA_BODY = "rx_alarm_body";
    static final String ACTION_STOP = "com.bryan.revolutx.ALARM_STOP";
    /** v12: on MainActivity's intent from a tap on the alarm's notification: stop the alarm, then open the deep link. */
    static final String EXTRA_STOP_ID = "rx_alarm_stop_id";
    private static final String TAG = "RipAlarm";
    static final long TIMEOUT_MS = 10 * 60 * 1000L;
    private static final int MAX_TITLE = 80;
    private static final int MAX_BODY = 300;

    private RipAlarm() {}

    /** One fixed id per coin, so a repeat replaces the alarm rather than stacking a second one. */
    static int notificationId(String coin) {
        return 9000 + ((coin == null ? "" : coin).hashCode() & 0xfff);
    }

    static void show(Context ctx, Map<String, String> data) {
        String coin = data.get("coin");
        if (coin == null || !coin.matches(MainActivity.COIN_RE)) coin = "";
        String inbox = data.get("inbox");
        if (inbox == null || !inbox.matches(MainActivity.INBOX_RE)) inbox = "";
        String title = cap(data.get("title"), MAX_TITLE);
        if (title.isEmpty()) title = coin.isEmpty() ? "🚨 RIP ALARM" : "🚨 RIP ALARM - " + coin;
        String body = cap(data.get("body"), MAX_BODY);
        int id = notificationId(coin);

        // v12: RipAlarmService rings it on the alarm stream (through silent mode). Only when its notification can be
        // seen: a ringing alarm with no Stop button would ring for 10 minutes.
        if (canRing(ctx)) {
            Intent ring = new Intent(ctx, RipAlarmService.class)
                .setAction(RipAlarmService.ACTION_RING)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_BODY, body)
                .putExtra(MainActivity.EXTRA_COIN, coin)
                .putExtra(MainActivity.EXTRA_INBOX, inbox);
            try {
                ContextCompat.startForegroundService(ctx, ring);
                return;
            } catch (Exception e) {
                // e.g. ForegroundServiceStartNotAllowedException: fall back to the v11 notification below
                Log.w(TAG, "rip alarm service not started, showing the v11 notification: " + e.getClass().getSimpleName());
            }
        }
        showNotification(ctx, id, title, body, coin, inbox);
    }

    /** Notifications allowed, and neither rx_alarm (Bryan's on/off and tone) nor rx_alarm_ring blocked. */
    private static boolean canRing(Context ctx) {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return false;
        NotificationChannel alarm = nm.getNotificationChannel(Push.CHANNEL_ALARM);
        if (alarm != null && alarm.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        NotificationChannel ring = nm.getNotificationChannel(Push.CHANNEL_ALARM_RING);
        return ring == null || ring.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    /** v11's notification on rx_alarm (insistent, 10-minute timeout): the fallback when the service cannot start. */
    static void showNotification(Context ctx, int id, String title, String body, String coin, String inbox) {
        NotificationCompat.Builder b = builder(ctx, Push.CHANNEL_ALARM, id, title, body, coin, inbox)
            .setOngoing(false)
            .setAutoCancel(true)
            .setTimeoutAfter(TIMEOUT_MS)
            // below Android 8 there are no channels: the same tone, stream and pattern set on the notification itself
            .setSound(MainActivity.alarmTone(), AudioManager.STREAM_ALARM)
            .setVibrate(MainActivity.ALARM_VIBRATION);
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT;   // sound and vibration repeat until tapped, stopped, swiped or timed out
        try {
            NotificationManagerCompat.from(ctx).notify(id, n);
        } catch (SecurityException ignored) {
            // notifications not allowed on this phone
        }
    }

    /**
     * v12: RipAlarmService's foreground notification on the silent rx_alarm_ring: the service plays the sound and the
     * vibration and stops them after 10 minutes, so no FLAG_INSISTENT and no timeout here. Swiping it away stops it.
     */
    static Notification ringingNotification(Context ctx, int id, String title, String body, String coin, String inbox) {
        return builder(ctx, Push.CHANNEL_ALARM_RING, id, title, body, coin, inbox)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setDeleteIntent(stopIntent(ctx, id))
            .build();
    }

    /** What both notifications share: text, alarm category, the deep link on tap, the full-screen page, Stop. */
    private static NotificationCompat.Builder builder(
        Context ctx, String channel, int id, String title, String body, String coin, String inbox
    ) {
        // the tap stops the alarm (MainActivity reads EXTRA_STOP_ID) and opens the same deep link as v11
        PendingIntent open = PendingIntent.getActivity(
            ctx, id, openIntent(ctx, coin, inbox).putExtra(EXTRA_STOP_ID, id),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Intent screen = new Intent(ctx, AlarmActivity.class)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_BODY, body)
            .putExtra(MainActivity.EXTRA_COIN, coin)
            .putExtra(MainActivity.EXTRA_INBOX, inbox)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent full = PendingIntent.getActivity(
            ctx, id, screen, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_rx)
            .setColor(0xFF00FFC8)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open)
            .setFullScreenIntent(full, true)
            .addAction(0, "Stop", stopIntent(ctx, id));
    }

    private static PendingIntent stopIntent(Context ctx, int id) {
        return PendingIntent.getBroadcast(
            ctx, id, new Intent(ctx, Stop.class).setAction(ACTION_STOP).putExtra(EXTRA_ID, id),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** The same deep link a normal notification uses: the home tab on the coin, or its message in the feed. */
    static Intent openIntent(Context ctx, String coin, String inbox) {
        return new Intent(ctx, MainActivity.class)
            .putExtra(MainActivity.EXTRA_TAB, "home")
            .putExtra(MainActivity.EXTRA_COIN, coin != null && coin.matches(MainActivity.COIN_RE) ? coin : null)
            .putExtra(MainActivity.EXTRA_INBOX, inbox != null && inbox.matches(MainActivity.INBOX_RE) ? inbox : null)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    /**
     * Stops the alarm at once: RipAlarmService's sound, vibration, audio focus and foreground notification (v12), the
     * v11 fallback notification (cancelling it silences it), and an open alarm screen. Main thread.
     */
    static void stop(Context ctx, int id) {
        RipAlarmService.stopRinging();
        NotificationManagerCompat.from(ctx).cancel(id);
        AlarmActivity.finishShowing(id);
    }

    private static String cap(String s, int max) {
        if (s == null) return "";
        s = s.trim();
        if (s.length() <= max) return s;
        int end = Character.isHighSurrogate(s.charAt(max - 1)) ? max - 1 : max;   // never cut an emoji in half
        return s.substring(0, end);
    }

    /** The notification's "Stop" button. */
    public static class Stop extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            if (intent == null || !ACTION_STOP.equals(intent.getAction())) return;
            stop(ctx, intent.getIntExtra(EXTRA_ID, notificationId("")));
        }
    }
}
