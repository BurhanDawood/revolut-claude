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
 * to the coin screen. Either way the sound stops.
 */
public class RipAlarmActivity extends Activity {

    static final String EXTRA_OPEN_COIN = "rx_rip_open_coin";

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
        if (!RipRing.isRinging() && state == null) {   // the listener could not start it from the background: ring from here
            try {
                startForegroundService(new android.content.Intent(this, RipRing.class).setAction(RipRing.ACTION_RING).putExtra(RipRing.EXTRA_JSON, json));
            } catch (Exception ignored) {
                // the notification is still there
            }
        }
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
            RipRing.stopRinging(this);
            finish();
        });
        box.addView(stop);
        TextView open = text("Open " + a.coin, 14, Fmt.ACCENT, true);
        open.setPadding(0, dp(12), 0, 0);
        open.setOnClickListener(v -> openCoin(a));
        box.addView(open);
        setContentView(box);
    }

    private void openCoin(RipRing.Alarm a) {
        RipRing.stopRinging(this);
        startActivity(new Intent(this, CoinActivity.class).putExtra(CoinActivity.EXTRA_COIN, a.coin));
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
