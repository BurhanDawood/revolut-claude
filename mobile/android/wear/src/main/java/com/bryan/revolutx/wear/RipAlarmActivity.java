package com.bryan.revolutx.wear;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Desk #59 (15 Oct): the Rip alarm on the watch screen (RipRing's full-screen intent, also over the lock screen):
 * "🚨 COIN +X% in 24 h · $price", Stop, and Open COIN (the coin screen). Opened from the notification itself it goes straight
 * to the coin screen. Either way the alarm stops (RipRing.stopAll), and so do the side buttons (Back, the stem buttons, or
 * Home, which leaves the page). It never starts a ring itself unless the listener could not, for this very alarm.
 */
public class RipAlarmActivity extends Activity {

    static final String EXTRA_OPEN_COIN = "rx_rip_open_coin";
    private static final java.util.Set<RipAlarmActivity> OPEN = java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>());
    private boolean closing;

    /** RipRing.stopAll and the 30 s cap: every alarm page closes. */
    static void closeAll() {
        RipAlarmActivity[] all;
        synchronized (OPEN) {
            all = OPEN.toArray(new RipAlarmActivity[0]);
        }
        for (RipAlarmActivity a : all) {
            a.runOnUiThread(() -> {
                a.closing = true;
                if (!a.isFinishing()) a.finish();
            });
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        String json = getIntent() != null ? getIntent().getStringExtra(RipRing.EXTRA_JSON) : null;
        RipRing.Alarm a = json == null ? null : RipRing.Alarm.parse(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (a == null || !OnWatch.is(this)) {
            finish();
            return;
        }
        if (getIntent().getBooleanExtra(EXTRA_OPEN_COIN, false)) {   // the notification's tap: the coin screen
            openCoin(a);
            return;
        }
        if (!RipRing.isRinging()) {
            if (state == null && RipRing.takePending(this, json)) {   // the listener could not start it from the background: ring from here
                try {
                    startForegroundService(new android.content.Intent(this, RipRing.class).setAction(RipRing.ACTION_RING).putExtra(RipRing.EXTRA_JSON, json));
                } catch (Exception e) {
                    RipDiag.error(this, "ring service", e);
                }
            } else {   // already stopped (or capped): the page never brings the sound back
                finish();
                return;
            }
        }
        synchronized (OPEN) {
            OPEN.add(this);
        }
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        int pad = Math.round(getResources().getDisplayMetrics().widthPixels * 0.12f);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(0xFF000000);
        box.setPadding(pad, pad, pad, pad);
        TextView t = text("RIP ALARM", 14, 0xFFFF4D6A, true);
        box.addView(t);
        TextView main = text(a.text().replace("🚨 ", ""), 22, Fmt.WHITE, true);
        main.setPadding(0, dp(6), 0, dp(14));
        main.setOnClickListener(v -> openCoin(a));
        box.addView(main);
        TextView stop = text("Stop", 16, 0xFF000000, true);
        stop.setBackgroundColor(0xFFFF4D6A);
        stop.setPadding(dp(22), dp(10), dp(22), dp(10));
        stop.setOnClickListener(v -> {
            RipRing.stopAll(this, "Stop on the alarm page");
            finish();
        });
        box.addView(stop);
        TextView open = text(a.test ? "A test - nothing moved" : "Open " + a.coin, 14, Fmt.ACCENT, true);
        open.setPadding(0, dp(12), 0, 0);
        open.setOnClickListener(v -> openCoin(a));
        box.addView(open);
        setContentView(box);
    }

    // the side buttons: Back and the stem buttons here; Home leaves the page (onUserLeaveHint)
    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        if (keyCode == android.view.KeyEvent.KEYCODE_BACK || keyCode == android.view.KeyEvent.KEYCODE_STEM_PRIMARY
            || keyCode == android.view.KeyEvent.KEYCODE_STEM_1 || keyCode == android.view.KeyEvent.KEYCODE_STEM_2
            || keyCode == android.view.KeyEvent.KEYCODE_STEM_3) {
            RipRing.stopAll(this, "side button (" + android.view.KeyEvent.keyCodeToString(keyCode) + ")");
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        RipRing.stopAll(this, "side button (back)");
        super.onBackPressed();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (!closing && !isFinishing()) RipRing.stopAll(this, "side button (home)");
    }

    @Override
    protected void onDestroy() {
        synchronized (OPEN) {
            OPEN.remove(this);
        }
        super.onDestroy();
    }

    private void openCoin(RipRing.Alarm a) {
        closing = true;
        RipRing.stopAll(this, a.test ? "opened the app from the alarm" : "opened " + a.coin + " from the alarm");
        startActivity(a.test ? new Intent(this, MainActivity.class)   // a test has no coin: the app
            : new Intent(this, CoinActivity.class).putExtra(CoinActivity.EXTRA_COIN, a.coin));
        finish();
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
