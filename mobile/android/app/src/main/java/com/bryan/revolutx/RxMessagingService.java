package com.bryan.revolutx;

import android.app.PendingIntent;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Replaces the push plugin's service (see AndroidManifest.xml) and keeps its behaviour, adding:
 * a new token is sent to the server, and a message that arrives while the app is open (or a data-only
 * message) is still shown. Tapping opens the tab named in data.tab (default home), on data.coin's card when set.
 * When the app is in the background Android shows notification messages itself; their tap brings
 * data.tab and data.coin in as the launch intent's "tab" / "coin" extras, which MainActivity reads.
 */
public class RxMessagingService extends MessagingService {

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        Push.onToken(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        super.onMessageReceived(msg);
        Map<String, String> data = msg.getData();
        RemoteMessage.Notification n = msg.getNotification();
        String title = n != null && n.getTitle() != null ? n.getTitle() : data.get("title");
        String body = n != null && n.getBody() != null ? n.getBody() : data.get("body");
        if (title == null && body == null) return;
        String channel = n != null && n.getChannelId() != null ? n.getChannelId() : data.get("channel");
        if (!Push.CHANNEL_INFO.equals(channel)) channel = Push.CHANNEL_ALERTS;
        String tab = data.get("tab");
        if (tab == null || !tab.matches(MainActivity.TAB_RE)) tab = "home";
        String coin = data.get("coin");   // '' or a symbol like AST

        int id = (int) (System.currentTimeMillis() & 0x7fffffff);
        Intent open = new Intent(this, MainActivity.class)
            .putExtra(MainActivity.EXTRA_TAB, tab)
            .putExtra(MainActivity.EXTRA_COIN, coin != null && coin.matches(MainActivity.COIN_RE) ? coin : null)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_rx)
            .setColor(0xFF00FFC8)
            .setContentTitle(title != null ? title : "Revolut X")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(Push.CHANNEL_ALERTS.equals(channel) ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pi);
        try {
            NotificationManagerCompat.from(this).notify(id, b.build());
        } catch (SecurityException ignored) {
            // notifications not allowed on this phone
        }
    }
}
