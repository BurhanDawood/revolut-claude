package com.bryan.revolutx;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.app.Notification;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.WebBackForwardList;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.RequiresApi;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.WebViewListener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * The app is the server's /app shell (capacitor.config.json server.url) plus a few native pieces:
 * the BiometricAuth, WidgetBridge and RxNotify plugins the shell calls, the home-screen widget, push, the Back
 * button, and an offline page when the server cannot be reached.
 */
public class MainActivity extends BridgeActivity {

    /** Intent extra naming the shell tab to open: set by the widget and by our own notifications. */
    public static final String EXTRA_TAB = "rx_tab";
    /** Intent extra naming a coin (e.g. "AST") to open with the tab: set by our own notifications. */
    public static final String EXTRA_COIN = "rx_coin";
    /** Intent extra with a notification's message id in the app's feed (data.inbox): set by our own notifications. */
    public static final String EXTRA_INBOX = "rx_inbox";
    /** Intent extra set by the widget: a tap also refreshes it. */
    public static final String EXTRA_FROM_WIDGET = "rx_widget";

    static final String TAB_RE = "home|portfolio|agent|desk|more";
    static final String COIN_RE = "[A-Z0-9]{1,15}";
    static final String INBOX_RE = "[0-9]{1,15}";   // not part of TAB_RE: the feed is only reached through an id

    private String pendingTab = null;
    private String pendingCoin = null;
    private String pendingInbox = null;
    private boolean shellLoaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);   // the shell is dark-only
        registerPlugin(BiometricAuthPlugin.class);
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(RxNotifyPlugin.class);
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                shellLoaded = false;
            }

            @Override
            public void onPageLoaded(WebView webView) {
                String url = webView.getUrl();
                shellLoaded = url != null && isShell(Uri.parse(url));
                if (shellLoaded) {
                    webView.clearHistory();   // Back never returns to an offline page or an earlier load
                    deliverPendingTab();
                }
                darkBars();
            }
        });
        super.onCreate(savedInstanceState);   // loads the bridge, then calls onNewIntent(getIntent())

        if (bridge != null) bridge.setWebViewClient(new OfflineAwareClient());
        darkBars();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onBack();
            }
        });
        createChannels();
        if (BuildConfig.HAS_FCM) startPush();
    }

    @Override
    public void onResume() {
        super.onResume();
        darkBars();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null) return;
        // v12: a tap on the ringing rip alarm's notification stops it, then opens its deep link below
        if (intent.hasExtra(RipAlarm.EXTRA_STOP_ID) && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) {
            RipAlarm.stop(this, intent.getIntExtra(RipAlarm.EXTRA_STOP_ID, RipAlarm.notificationId("")));
            intent.removeExtra(RipAlarm.EXTRA_STOP_ID);   // a later re-delivery of this intent does not stop a newer alarm
        }
        String tab = intent.getStringExtra(EXTRA_TAB);
        if (tab == null) tab = intent.getStringExtra("tab");   // FCM puts a notification's data keys on the launch intent
        if (tab == null && intent.hasExtra("google.message_id")) tab = "home";
        String coin = intent.getStringExtra(EXTRA_COIN);
        if (coin == null) coin = intent.getStringExtra("coin");   // likewise data.coin of a background notification
        if (coin != null && !coin.matches(COIN_RE)) coin = null;   // only validated values ever reach the JS below
        String inbox = intent.getStringExtra(EXTRA_INBOX);
        if (inbox == null) inbox = intent.getStringExtra("inbox");   // likewise data.inbox of a background notification
        if (inbox != null && !inbox.matches(INBOX_RE)) inbox = null;
        // a valid feed id is delivered whatever the tab says; "home" is only the fallback for a shell without open()
        if (inbox != null && (tab == null || !tab.matches(TAB_RE))) tab = "home";
        if (intent.getBooleanExtra(EXTRA_FROM_WIDGET, false)) WidgetRefreshWorker.refreshNow(this);
        if (tab != null && tab.matches(TAB_RE)) {
            pendingTab = tab;
            pendingCoin = coin;
            pendingInbox = inbox;
            if (shellLoaded) deliverPendingTab();
        }
    }

    /**
     * Once the shell script has run (it defines rxApp at its end): rxApp.open({ tab, coin }) when a notification named a
     * coin and the shell has open() (shell 492+), otherwise rxApp.show(tab). The coin is cleared once delivered, so a
     * later plain open of the app does not jump to it. A notification's feed id (data.inbox, shell 501+) wins over both:
     * rxApp.open({ tab: 'inbox', id }) opens the feed on that message, falling back to rxApp.show('home').
     * tab, coin and inbox are validated against TAB_RE / COIN_RE / INBOX_RE first.
     */
    private void deliverPendingTab() {
        if (pendingTab == null || bridge == null) return;
        String tab = pendingTab, coin = pendingCoin, inbox = pendingInbox;
        pendingTab = null;
        pendingCoin = null;
        pendingInbox = null;
        if (!tab.matches(TAB_RE)) return;
        String call;
        if (inbox != null && inbox.matches(INBOX_RE)) {
            call = "if(rxApp.open){rxApp.open({tab:'inbox',id:'" + inbox + "'});}else{rxApp.show('home');}";
        } else if (coin != null && coin.matches(COIN_RE)) {
            call = "if(rxApp.open){rxApp.open({tab:'" + tab + "',coin:'" + coin + "'});}else{rxApp.show('" + tab + "');}";
        } else {
            call = "rxApp.show('" + tab + "');";
        }
        bridge.getWebView().evaluateJavascript(
            "(function go(n){if(window.rxApp&&rxApp.show){" + call + "}else if(n>0){setTimeout(function(){go(n-1);},250);}})(40);",
            null
        );
    }

    // ── Back: back inside the open tab's frame when it has moved off its start page, otherwise minimise ──
    private static final String BACK_JS =
        "(function(){try{var f=document.querySelector('#frames iframe.on');if(!f)return 'top';" +
        "var l=f.contentWindow.location,a=new URL(f.getAttribute('src'),location.href);" +
        "return (l.pathname+l.search+l.hash)!==(a.pathname+a.search+a.hash)?'sub':'top';}catch(e){return 'top';}})()";

    private void onBack() {
        if (bridge == null || !shellLoaded) {
            moveTaskToBack(true);
            return;
        }
        final WebView wv = bridge.getWebView();
        wv.evaluateJavascript(BACK_JS, result -> {
            if ("\"sub\"".equals(result) && sameDocumentBack(wv)) wv.goBack();
            else moveTaskToBack(true);
        });
    }

    /** True when the previous history entry is a frame navigation inside this same shell page. */
    private static boolean sameDocumentBack(WebView wv) {
        if (!wv.canGoBack()) return false;
        WebBackForwardList list = wv.copyBackForwardList();
        int i = list.getCurrentIndex();
        if (i < 1) return false;
        String prev = list.getItemAtIndex(i - 1).getUrl(), cur = list.getCurrentItem().getUrl();
        return prev != null && prev.equals(cur);
    }

    // ── status bar and navigation bar: dark, light icons ──
    private void darkBars() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            getWindow().setStatusBarColor(0xFF0D0D0D);
            getWindow().setNavigationBarColor(0xFF0D0D0D);
        }
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setAppearanceLightStatusBars(false);
        c.setAppearanceLightNavigationBars(false);
    }

    // ── offline: a network failure loading the shell shows the bundled www/index.html ──
    static boolean isShell(Uri u) {
        return Config.HOST.equalsIgnoreCase(u.getHost()) && "/app".equals(u.getPath());
    }

    private class OfflineAwareClient extends BridgeWebViewClient {

        OfflineAwareClient() {
            super(bridge);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) showOffline(view);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            super.onReceivedHttpError(view, request, response);
            int s = response.getStatusCode();
            if (request.isForMainFrame() && (s == 502 || s == 503 || s == 504)) showOffline(view);
        }
    }

    private void showOffline(WebView view) {
        try (InputStream in = getAssets().open("public/index.html")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            // based on the server's origin, so Retry's location.replace('/app') goes straight back to the shell
            view.loadDataWithBaseURL(Config.BASE + "/offline", out.toString(StandardCharsets.UTF_8.name()), "text/html", "utf-8", null);
        } catch (Exception e) {
            view.loadData("<body style='background:#0d0d0d;color:#e8e8e8'>No connection to the server</body>", "text/html", "utf-8");
        }
    }

    // ── push (only when google-services.json was present at build time) ──
    private void createChannels() {
        ensureChannels(this);
    }

    /** v10 (batch 503): the category channels, in Push.CATS order: { name, description }. */
    static final String[][] CAT_CHANNELS = {
        { "Needs you", "Approvals, anything held for your confirmation, a failed trade" },
        { "Money moved", "Buys and sells filled, card payments, deposits, swaps" },
        { "Price moves", "Dips, spikes, pumps, targets and floors hit" },
        { "Loops & trails", "Loops arming, trails, buy-backs, sales held or skipped" },
        { "Agent & desk", "The budget agent and spec-desk messages" },
        { "Reports", "Morning brief, weekly reviews, research" },
        { "System", "Backups, restarts, connection problems" },
    };
    static final String GROUP_CATS = "rx_cats";
    static final String GROUP_OTHER = "rx_other";

    /**
     * Creates every channel the app uses. Safe on each start and from RxNotify: for a channel that exists Android only
     * updates its name and description and keeps whatever sound / vibration the user chose.
     */
    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean otherGroup = false;
        try {
            nm.createNotificationChannelGroup(new NotificationChannelGroup(GROUP_OTHER, "Other"));
            otherGroup = true;
        } catch (Exception ignored) {
            // optional: the older channels simply stay outside a group
        }

        NotificationChannel alerts = new NotificationChannel(Push.CHANNEL_ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Trade and price alerts");
        NotificationChannel info = new NotificationChannel(Push.CHANNEL_INFO, "Info", NotificationManager.IMPORTANCE_DEFAULT);
        info.setDescription("Reports and other news");

        // v8: one channel per sound/vibrate choice (batch 498 picks one per alert category). Android fixes a channel's
        // sound and vibration once it exists, so these ids must never be reused with other settings.
        AudioAttributes sound = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();

        NotificationChannel loud = new NotificationChannel(Push.CHANNEL_LOUD, "Sound and vibrate", NotificationManager.IMPORTANCE_HIGH);
        loud.setDescription("Revolut X alerts you set to sound and vibrate");
        loud.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, sound);
        loud.enableVibration(true);

        NotificationChannel soundOnly = new NotificationChannel(Push.CHANNEL_SOUND, "Sound only", NotificationManager.IMPORTANCE_HIGH);
        soundOnly.setDescription("Revolut X alerts you set to sound without vibration");
        soundOnly.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, sound);
        soundOnly.enableVibration(false);

        NotificationChannel buzz = new NotificationChannel(Push.CHANNEL_BUZZ, "Vibrate only", NotificationManager.IMPORTANCE_HIGH);
        buzz.setDescription("Revolut X alerts you set to vibrate without sound");
        buzz.setSound(null, null);
        buzz.enableVibration(true);
        buzz.setVibrationPattern(new long[] { 0, 250, 150, 250 });

        NotificationChannel quiet = new NotificationChannel(Push.CHANNEL_QUIET, "Silent", NotificationManager.IMPORTANCE_LOW);
        quiet.setDescription("Revolut X alerts you set to silent");
        quiet.setSound(null, null);
        quiet.enableVibration(false);

        for (NotificationChannel c : new NotificationChannel[] { alerts, info, loud, soundOnly, buzz, quiet }) {
            if (otherGroup) c.setGroup(GROUP_OTHER);
            try {
                nm.createNotificationChannel(c);
            } catch (Exception e) {
                if (!otherGroup) continue;
                c.setGroup(null);   // Android refused the group: keep the channel as it was
                try {
                    nm.createNotificationChannel(c);
                } catch (Exception ignored) {
                    // leave it as it is
                }
            }
        }

        // v10: one channel per alert category, each starting on the default sound with vibration. The user picks their
        // own sound and vibration on Android's page for the channel (RxNotify.openChannel); the app never overrides it.
        // These ids must never be deleted, re-created or reused with other settings.
        nm.createNotificationChannelGroup(new NotificationChannelGroup(GROUP_CATS, "Alert categories"));
        for (int i = 0; i < Push.CATS.length; i++) {
            NotificationChannel c = new NotificationChannel(
                Push.CHANNEL_CAT_PREFIX + Push.CATS[i], CAT_CHANNELS[i][0], NotificationManager.IMPORTANCE_HIGH
            );
            c.setDescription(CAT_CHANNELS[i][1]);
            c.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, sound);
            c.enableVibration(true);
            c.setGroup(GROUP_CATS);
            nm.createNotificationChannel(c);
        }

        // v11: the rip alarm. Alarm tone at alarm volume (USAGE_ALARM also lets it through Do Not Disturb's default
        // "alarms allowed"), its own vibration pattern. The user may pick another tone on Android's page for it; the
        // app never overrides that. This id must never be deleted, re-created or reused with other settings.
        try {
            nm.createNotificationChannel(alarmChannel());
        } catch (Exception ignored) {
            // leave it as it is
        }
        // v12: the rip alarm's screen notification, silent (RipAlarmService plays rx_alarm's tone on the alarm stream).
        try {
            nm.createNotificationChannel(alarmRingChannel());
        } catch (Exception ignored) {
            // leave it as it is
        }
    }

    /**
     * v12: rx_alarm_ring, where RipAlarmService posts its notification. No sound and no vibration of its own: posting on
     * rx_alarm would play the tone a second time whenever the phone is not on silent. Never deleted or re-created.
     */
    @RequiresApi(Build.VERSION_CODES.O)
    static NotificationChannel alarmRingChannel() {
        NotificationChannel c = new NotificationChannel(Push.CHANNEL_ALARM_RING, "Rip alarm (screen)", NotificationManager.IMPORTANCE_HIGH);
        c.setDescription("Shows the rip alarm; its sound comes from the Rip alarm tone");
        c.setSound(null, null);
        c.enableVibration(false);
        c.setBypassDnd(true);
        c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        return c;
    }

    /** Three quick taps then a long buzz, twice: unlike any other notification on the phone. Fixed once rx_alarm exists. */
    static final long[] ALARM_VIBRATION = { 0, 150, 100, 150, 100, 150, 400, 900, 600, 150, 100, 150, 100, 150, 400, 900 };

    static Uri alarmTone() {
        Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (u == null) u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return u;
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private static NotificationChannel alarmChannel() {
        NotificationChannel c = new NotificationChannel(Push.CHANNEL_ALARM, "Rip alarm", NotificationManager.IMPORTANCE_HIGH);
        c.setDescription("Rings like an alarm when a coin you hold is up 30%+ in a day");
        c.setSound(
            alarmTone(),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        c.enableVibration(true);
        c.setVibrationPattern(ALARM_VIBRATION);
        c.setBypassDnd(true);   // honoured only if the user gave the app Do Not Disturb access; harmless otherwise
        c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        return c;
    }

    private void startPush() {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        Push.fetchTokenAndRegister(getApplicationContext());
    }
}
