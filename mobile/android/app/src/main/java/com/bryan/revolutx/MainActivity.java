package com.bryan.revolutx;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebBackForwardList;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
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
 * the BiometricAuth and WidgetBridge plugins the shell calls, the home-screen widget, push, the Back
 * button, and an offline page when the server cannot be reached.
 */
public class MainActivity extends BridgeActivity {

    /** Intent extra naming the shell tab to open: set by the widget and by our own notifications. */
    public static final String EXTRA_TAB = "rx_tab";
    /** Intent extra naming a coin (e.g. "AST") to open with the tab: set by our own notifications. */
    public static final String EXTRA_COIN = "rx_coin";
    /** Intent extra set by the widget: a tap also refreshes it. */
    public static final String EXTRA_FROM_WIDGET = "rx_widget";

    static final String TAB_RE = "home|portfolio|agent|desk|more";
    static final String COIN_RE = "[A-Z0-9]{1,15}";

    private String pendingTab = null;
    private String pendingCoin = null;
    private boolean shellLoaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);   // the shell is dark-only
        registerPlugin(BiometricAuthPlugin.class);
        registerPlugin(WidgetBridgePlugin.class);
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
        String tab = intent.getStringExtra(EXTRA_TAB);
        if (tab == null) tab = intent.getStringExtra("tab");   // FCM puts a notification's data keys on the launch intent
        if (tab == null && intent.hasExtra("google.message_id")) tab = "home";
        String coin = intent.getStringExtra(EXTRA_COIN);
        if (coin == null) coin = intent.getStringExtra("coin");   // likewise data.coin of a background notification
        if (coin != null && !coin.matches(COIN_RE)) coin = null;   // only validated values ever reach the JS below
        if (intent.getBooleanExtra(EXTRA_FROM_WIDGET, false)) WidgetRefreshWorker.refreshNow(this);
        if (tab != null && tab.matches(TAB_RE)) {
            pendingTab = tab;
            pendingCoin = coin;
            if (shellLoaded) deliverPendingTab();
        }
    }

    /**
     * Once the shell script has run (it defines rxApp at its end): rxApp.open({ tab, coin }) when a notification named a
     * coin and the shell has open() (shell 492+), otherwise rxApp.show(tab). The coin is cleared once delivered, so a
     * later plain open of the app does not jump to it. tab and coin are validated against TAB_RE / COIN_RE first.
     */
    private void deliverPendingTab() {
        if (pendingTab == null || bridge == null) return;
        String tab = pendingTab, coin = pendingCoin;
        pendingTab = null;
        pendingCoin = null;
        if (!tab.matches(TAB_RE)) return;
        String call = coin != null && coin.matches(COIN_RE)
            ? "if(rxApp.open){rxApp.open({tab:'" + tab + "',coin:'" + coin + "'});}else{rxApp.show('" + tab + "');}"
            : "rxApp.show('" + tab + "');";
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
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel alerts = new NotificationChannel(Push.CHANNEL_ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Trade and price alerts");
        NotificationChannel info = new NotificationChannel(Push.CHANNEL_INFO, "Info", NotificationManager.IMPORTANCE_DEFAULT);
        info.setDescription("Reports and other news");
        nm.createNotificationChannel(alerts);
        nm.createNotificationChannel(info);
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
