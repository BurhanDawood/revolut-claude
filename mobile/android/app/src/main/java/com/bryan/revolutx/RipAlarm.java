package com.bryan.revolutx;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Map;

/**
 * v11 (batch 514): the rip alarm. The server sends a data-only, high-priority message with data.alarm = "1" when a coin
 * Bryan holds is up 30%+ in 24 h (one per coin per day). It is shown on rx_alarm: alarm tone, its own vibration,
 * repeating (FLAG_INSISTENT) until tapped, stopped or swiped, and for at most 10 minutes; over the lock screen through
 * AlarmActivity (full-screen intent). Only a validated coin and feed id reach an intent's deep link; title and body are
 * shown as plain text only.
 */
final class RipAlarm {

    static final String EXTRA_ID = "rx_alarm_id";
    static final String EXTRA_TITLE = "rx_alarm_title";
    static final String EXTRA_BODY = "rx_alarm_body";
    static final String ACTION_STOP = "com.bryan.revolutx.ALARM_STOP";
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

        PendingIntent open = PendingIntent.getActivity(
            ctx, id, openIntent(ctx, coin, inbox), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
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
        PendingIntent stop = PendingIntent.getBroadcast(
            ctx, id, new Intent(ctx, Stop.class).setAction(ACTION_STOP).putExtra(EXTRA_ID, id),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, Push.CHANNEL_ALARM)
            .setSmallIcon(R.drawable.ic_stat_rx)
            .setColor(0xFF00FFC8)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(false)
            .setAutoCancel(true)
            .setTimeoutAfter(TIMEOUT_MS)
            .setContentIntent(open)
            .setFullScreenIntent(full, true)
            .addAction(0, "Stop", stop)
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

    /** The same deep link a normal notification uses: the home tab on the coin, or its message in the feed. */
    static Intent openIntent(Context ctx, String coin, String inbox) {
        return new Intent(ctx, MainActivity.class)
            .putExtra(MainActivity.EXTRA_TAB, "home")
            .putExtra(MainActivity.EXTRA_COIN, coin != null && coin.matches(MainActivity.COIN_RE) ? coin : null)
            .putExtra(MainActivity.EXTRA_INBOX, inbox != null && inbox.matches(MainActivity.INBOX_RE) ? inbox : null)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    /** Cancelling the notification stops its sound and vibration at once; an open alarm screen closes too. */
    static void stop(Context ctx, int id) {
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
