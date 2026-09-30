package com.bryan.revolutx;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.TypedValue;
import android.view.Display;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.WindowMetrics;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.annotation.RequiresApi;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * v13 (batch 530): the floating window over every app (Bryan, desk #37 Option B). A read-only WebView showing one of the
 * two float pages (a coin's chart, or one Home widget) from the app's own server origin, in a rounded dark frame:
 *   - a thin top bar: drag it to move the window (kept on screen); ⤢ toggles the last small size / nearly full screen;
 *     ✕ closes the window and stops the service;
 *   - a corner handle at the bottom right: drag it to resize, from 160 × 120 dp up to full.
 * The last path, position and size are remembered (SharedPreferences "rx_float") and reopened, clamped to the screen.
 * A foreground service (type specialUse) with a silent notification on rx_float and one action, Close.
 * The WebView has no Capacitor bridge and no file access; it navigates only on the server origin. Its one JS method,
 * RxFloatHost.open(coin), brings the app to the front on that coin, the same way a notification does. Not exported.
 */
@RequiresApi(Build.VERSION_CODES.O)
public class FloatService extends Service {

    static final String ACTION_OPEN = "com.bryan.revolutx.FLOAT_OPEN";
    static final String ACTION_CLOSE = "com.bryan.revolutx.FLOAT_CLOSE";
    static final String EXTRA_URL = "rx_float_url";
    /** Set when started with startForegroundService: Android then requires startForeground even if no window shows. */
    private static final String EXTRA_FG = "rx_float_fg";
    static final String CHANNEL = "rx_float";
    static final int NOTIFICATION_ID = 7300;
    private static final String TAG = "FloatService";
    private static final String PREFS = "rx_float";
    private static final String HOST_COIN_RE = "^[A-Z0-9]{0,15}$";

    private static final int BAR_DP = 28;
    private static final int HANDLE_DP = 28;
    private static final int MIN_W_DP = 160;
    private static final int MIN_H_DP = 120;
    private static final int MARGIN_DP = 8;
    private static final int CORNER_DP = 12;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private FrameLayout root;
    private WebView web;
    private WindowManager.LayoutParams lp;
    private boolean foreground;
    private boolean full;
    /** The last small size and place, for ⤢ back from full. */
    private int smallX, smallY, smallW, smallH;

    /**
     * Shows the window on url (Config.BASE + a path RxFloatPlugin.PATH_RE accepted), or loads url in the one already
     * open. Called from the app while it is in the foreground, so a plain start is allowed and nothing is posted unless
     * the window really appears; startForegroundService is only the fallback.
     */
    static void open(Context ctx, String url) {
        Intent i = new Intent(ctx, FloatService.class).setAction(ACTION_OPEN).putExtra(EXTRA_URL, url);
        try {
            ctx.startService(i);
        } catch (IllegalStateException e) {
            ContextCompat.startForegroundService(ctx, i.putExtra(EXTRA_FG, true));
        }
    }

    /** True for Config.BASE + one of the two float paths, and nothing else. */
    static boolean isFloatUrl(String url) {
        return url != null && url.startsWith(Config.BASE) && url.substring(Config.BASE.length()).matches(RxFloatPlugin.PATH_RE);
    }

    /** https on the server's own host (default port): the only place the float may navigate to. */
    static boolean isServerOrigin(Uri u) {
        return u != null && "https".equals(u.getScheme()) && Config.HOST.equalsIgnoreCase(u.getHost()) && u.getPort() == -1;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        String url = intent != null ? intent.getStringExtra(EXTRA_URL) : null;
        if (intent != null && intent.getBooleanExtra(EXTRA_FG, false) && !foreground) goForeground();
        if (!ACTION_OPEN.equals(action) || !isFloatUrl(url) || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            close();
            return START_NOT_STICKY;
        }
        if (root != null) {
            // one window at a time: the new path replaces what it shows
            web.loadUrl(url);
            prefs().edit().putString("path", url.substring(Config.BASE.length())).apply();
            return START_NOT_STICKY;
        }
        if (!Settings.canDrawOverlays(this) || !showWindow(url)) {
            close();   // permission revoked (or addView refused): no window, nothing posted
            return START_NOT_STICKY;
        }
        if (!goForeground()) {
            close();
            return START_NOT_STICKY;
        }
        prefs().edit().putString("path", url.substring(Config.BASE.length())).apply();
        return START_NOT_STICKY;   // killed for memory: it stays closed
    }

    @Override
    public void onDestroy() {
        removeWindow();
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // rotated or folded: once the new display size is known, keep the window on it
        handler.postDelayed(this::refit, 150);
    }

    // ── the window ──

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    @SuppressLint({ "SetJavaScriptEnabled", "ClickableViewAccessibility", "AddJavascriptInterface" })
    private boolean showWindow(String url) {
        Context ctx = this;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 11+: an overlay's views and metrics belong to a window context for its window type
            try {
                DisplayManager dm = getSystemService(DisplayManager.class);
                Display d = dm != null ? dm.getDisplay(Display.DEFAULT_DISPLAY) : null;
                if (d != null) ctx = createDisplayContext(d).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null);
            } catch (Exception e) {
                ctx = this;
            }
        }
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        if (wm == null) return false;

        root = new FrameLayout(ctx);
        GradientDrawable frame = new GradientDrawable();
        frame.setColor(0xFF0D0D0D);
        frame.setCornerRadius(dp(CORNER_DP));
        frame.setStroke(Math.max(1, dp(1)), 0xFF2A2A2A);
        root.setBackground(frame);
        root.setClipToOutline(true);

        LinearLayout column = new LinearLayout(ctx);
        column.setOrientation(LinearLayout.VERTICAL);
        root.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // top bar: the drag handle, ⤢ and ✕
        LinearLayout bar = new LinearLayout(ctx);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(0xFF1A1A1A);
        TextView grip = new TextView(ctx);
        grip.setText("⋮⋮  Revolut X");
        grip.setTextColor(0xFF8F8F8F);
        grip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        grip.setSingleLine(true);
        grip.setPadding(dp(10), 0, 0, 0);
        grip.setGravity(Gravity.CENTER_VERTICAL);
        bar.addView(grip, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
        TextView size = barButton(ctx, "⤢", "Full screen or small");
        size.setOnClickListener(v -> toggleFull());
        bar.addView(size, new LinearLayout.LayoutParams(dp(40), ViewGroup.LayoutParams.MATCH_PARENT));
        TextView x = barButton(ctx, "✕", "Close");
        x.setOnClickListener(v -> close());
        bar.addView(x, new LinearLayout.LayoutParams(dp(40), ViewGroup.LayoutParams.MATCH_PARENT));
        bar.setOnTouchListener(new Drag(false));
        grip.setOnTouchListener(new Drag(false));
        column.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(BAR_DP)));

        // the page: a plain WebView on the default profile (so /dashboard-auth.js finds the key the app's pages saved)
        web = new WebView(ctx);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isServerOrigin(request.getUrl());   // anything else is blocked, never opened
            }
        });
        web.addJavascriptInterface(new Host(), "RxFloatHost");
        column.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // bottom-right corner: the resize handle, over the page
        TextView handle = new TextView(ctx);
        handle.setText("◢");
        handle.setTextColor(0x99E8E8E8);
        handle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        handle.setGravity(Gravity.BOTTOM | Gravity.END);
        handle.setPadding(0, 0, dp(4), dp(2));
        handle.setContentDescription("Resize");
        handle.setOnTouchListener(new Drag(true));
        root.addView(handle, new FrameLayout.LayoutParams(dp(HANDLE_DP), dp(HANDLE_DP), Gravity.BOTTOM | Gravity.END));

        lp = new WindowManager.LayoutParams(
            1,
            1,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        lp.gravity = Gravity.TOP | Gravity.START;
        restoreGeometry();
        try {
            wm.addView(root, lp);
        } catch (Exception e) {
            Log.w(TAG, "overlay refused: " + e.getClass().getSimpleName());
            destroyWeb();
            root = null;
            return false;
        }
        web.loadUrl(url);
        return true;
    }

    private TextView barButton(Context ctx, String glyph, String label) {
        TextView b = new TextView(ctx);
        b.setText(glyph);
        b.setTextColor(0xFFE8E8E8);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setGravity(Gravity.CENTER);
        b.setContentDescription(label);
        b.setClickable(true);
        return b;
    }

    /** The bar moves the window; the corner handle resizes it. Kept inside the screen either way; saved on release. */
    private class Drag implements View.OnTouchListener {

        private final boolean resize;
        private float downX, downY;
        private int startX, startY, startW, startH;

        Drag(boolean resize) {
            this.resize = resize;
        }

        @Override
        public boolean onTouch(View v, MotionEvent e) {
            if (lp == null || root == null) return false;
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX();
                    downY = e.getRawY();
                    startX = lp.x;
                    startY = lp.y;
                    startW = lp.width;
                    startH = lp.height;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    int dx = Math.round(e.getRawX() - downX), dy = Math.round(e.getRawY() - downY);
                    if (resize) {
                        Rect s = screen();
                        lp.width = clamp(startW + dx, dp(MIN_W_DP), s.right - lp.x);
                        lp.height = clamp(startH + dy, dp(MIN_H_DP), s.bottom - lp.y);
                    } else {
                        lp.x = startX + dx;
                        lp.y = startY + dy;
                    }
                    full = false;
                    fit();
                    update();
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    rememberSmall();
                    saveGeometry();
                    return true;
                default:
                    return true;
            }
        }
    }

    private void toggleFull() {
        if (lp == null) return;
        if (full) {
            full = false;
            lp.x = smallX;
            lp.y = smallY;
            lp.width = smallW;
            lp.height = smallH;
        } else {
            rememberSmall();
            full = true;
            Rect s = screen();
            lp.x = s.left;
            lp.y = s.top;
            lp.width = s.width();
            lp.height = s.height();
        }
        fit();
        update();
        saveGeometry();
    }

    private void rememberSmall() {
        if (full || lp == null) return;
        smallX = lp.x;
        smallY = lp.y;
        smallW = lp.width;
        smallH = lp.height;
    }

    /** After a rotation or fold: full stays full; otherwise the window is clamped back on screen. */
    private void refit() {
        if (lp == null || root == null) return;
        if (full) {
            Rect s = screen();
            lp.x = s.left;
            lp.y = s.top;
            lp.width = s.width();
            lp.height = s.height();
        }
        fit();
        rememberSmall();
        update();
        saveGeometry();
    }

    /** Size between the minimum and the usable screen, then position so the whole window is on it. */
    private void fit() {
        Rect s = screen();
        lp.width = clamp(lp.width, Math.min(dp(MIN_W_DP), s.width()), s.width());
        lp.height = clamp(lp.height, Math.min(dp(MIN_H_DP), s.height()), s.height());
        lp.x = clamp(lp.x, s.left, s.right - lp.width);
        lp.y = clamp(lp.y, s.top, s.bottom - lp.height);
    }

    private void update() {
        try {
            if (root != null && root.isAttachedToWindow()) wm.updateViewLayout(root, lp);
        } catch (Exception ignored) {
            // the window went away underneath us
        }
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(v, Math.max(lo, hi)));
    }

    /**
     * Where the window may be: the whole display less the status bar (and navigation bar, so the corner handle is never
     * under the gesture bar) and a small margin. This is also "full".
     */
    @SuppressWarnings("deprecation")
    private Rect screen() {
        int w, h, top, bottom, left = 0, right = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowMetrics m = wm.getCurrentWindowMetrics();
            Rect b = m.getBounds();
            Insets in = m.getWindowInsets().getInsetsIgnoringVisibility(
                WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars() | WindowInsets.Type.displayCutout()
            );
            w = b.width();
            h = b.height();
            top = in.top;
            bottom = in.bottom;
            left = in.left;
            right = in.right;
        } else {
            DisplayMetrics dm = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            w = dm.widthPixels;
            h = dm.heightPixels;
            top = systemDimen("status_bar_height");
            bottom = w < h ? systemDimen("navigation_bar_height") : 0;
        }
        int m = dp(MARGIN_DP);
        return new Rect(left + m, top + m, w - right - m, h - bottom - m);
    }

    private int systemDimen(String name) {
        int id = getResources().getIdentifier(name, "dimen", "android");
        return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
    }

    // ── remembered: path, x, y, width, height (and full + the small size for ⤢) ──

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void restoreGeometry() {
        SharedPreferences p = prefs();
        Rect s = screen();
        if (p.contains("w")) {
            lp.x = p.getInt("x", 0);
            lp.y = p.getInt("y", 0);
            lp.width = p.getInt("w", 0);
            lp.height = p.getInt("h", 0);
            full = p.getBoolean("full", false);
            smallX = p.getInt("sx", lp.x);
            smallY = p.getInt("sy", lp.y);
            smallW = p.getInt("sw", lp.width);
            smallH = p.getInt("sh", lp.height);
            if (full) {
                lp.x = s.left;
                lp.y = s.top;
                lp.width = s.width();
                lp.height = s.height();
            }
        } else {
            // first time: about 60% of the screen width at 4:3, top right
            lp.width = Math.round(s.width() * 0.6f);
            lp.height = lp.width * 3 / 4;
            lp.x = s.right - lp.width;
            lp.y = s.top;
            full = false;
        }
        fit();
        if (!full) rememberSmall();
    }

    private void saveGeometry() {
        if (lp == null) return;
        prefs()
            .edit()
            .putInt("x", lp.x)
            .putInt("y", lp.y)
            .putInt("w", lp.width)
            .putInt("h", lp.height)
            .putBoolean("full", full)
            .putInt("sx", smallX)
            .putInt("sy", smallY)
            .putInt("sw", smallW)
            .putInt("sh", smallH)
            .apply();
    }

    // ── RxFloatHost: a tap in the window opens the app (on a coin) ──

    private class Host {

        @JavascriptInterface
        public void open(String coin) {
            String c = coin != null && coin.matches(HOST_COIN_RE) ? coin : "";
            Intent i = new Intent(FloatService.this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .putExtra(MainActivity.EXTRA_TAB, "home");
            if (!c.isEmpty()) i.putExtra(MainActivity.EXTRA_COIN, c);
            handler.post(() -> {
                try {
                    startActivity(i);   // the float stays open
                } catch (Exception e) {
                    Log.w(TAG, "could not open the app: " + e.getClass().getSimpleName());
                }
            });
        }
    }

    // ── foreground notification on rx_float: silent, one action (Close) ──

    private boolean goForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Floating chart", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while a Revolut X chart floats over other apps");
            ch.setSound(null, null);
            ch.enableVibration(false);
            ch.setShowBadge(false);
            try {
                nm.createNotificationChannel(ch);
            } catch (Exception ignored) {
                // leave it as it is
            }
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent closePi = PendingIntent.getService(this, 1, new Intent(this, FloatService.class).setAction(ACTION_CLOSE), piFlags);
        PendingIntent openPi = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            piFlags
        );
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_rx)
            .setColor(ContextCompat.getColor(this, R.color.rx_accent))
            .setContentTitle("Revolut X")
            .setContentText("Revolut X chart is floating")
            .setContentIntent(openPi)
            .addAction(0, "Close", closePi)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                n,
                Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0
            );
            foreground = true;
            return true;
        } catch (Exception e) {
            Log.w(TAG, "could not go foreground: " + e.getClass().getSimpleName());
            return false;
        }
    }

    // ── closing: ✕, Close, a bad start, or the service being destroyed ──

    private void close() {
        saveGeometry();
        removeWindow();
        if (foreground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            foreground = false;
        }
        stopSelf();
    }

    private void removeWindow() {
        handler.removeCallbacksAndMessages(null);
        if (root != null) {
            try {
                wm.removeViewImmediate(root);
            } catch (Exception ignored) {
                // already gone
            }
        }
        destroyWeb();
        root = null;
        lp = null;
    }

    private void destroyWeb() {
        if (web == null) return;
        try {
            web.stopLoading();
            web.removeJavascriptInterface("RxFloatHost");
            web.destroy();
        } catch (Exception ignored) {
            // nothing left to free
        }
        web = null;
    }
}
