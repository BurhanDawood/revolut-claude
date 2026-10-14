package com.bryan.revolutx.wear;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Desk #59 Tiles (Bryan 13 Oct 23:45): one coin on the watch, opened from a Coin Tile, the Top movers Tile or the app's lists.
 * Its ticker and 24 h %, price, the same chart as its Coin Tile (ChartView: hourly candles with volume and the live price, or the
 * 24 h line), then the holding and "Open on phone". Live like the app: the coin rides along in the summary read (?coins=), every 30 s
 * while the screen is on.
 */
public class CoinActivity extends Activity {

    static final String EXTRA_COIN = "coin";

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private String coin;
    private LinearLayout list;
    private ChartView chart;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null || pm.isInteractive()) load(false);
            main.postDelayed(this, 30_000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        coin = getIntent() != null ? getIntent().getStringExtra(EXTRA_COIN) : null;
        if (!OnWatch.is(this) || !TileCoins.valid(coin)) {
            if (!OnWatch.is(this)) Toast.makeText(this, OnWatch.PHONE_HINT, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        TileCoins.viewing(this, coin);   // the next read brings this coin's numbers
        int pad = Math.round(getResources().getDisplayMetrics().widthPixels * 0.12f);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF000000);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setGravity(Gravity.CENTER_HORIZONTAL);
        list.setPadding(pad, pad, pad, pad * 2);
        scroll.addView(list);
        setContentView(scroll);
        chart = new ChartView(this);
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (list == null) return;
        main.removeCallbacks(tick);
        main.post(tick);
    }

    @Override
    protected void onPause() {
        main.removeCallbacks(tick);
        super.onPause();
    }

    private void load(boolean force) {
        EXEC.execute(() -> {
            Repo.refresh(getApplicationContext(), force ? 0 : Repo.AGE_APP, Repo.FROM_APP);
            main.post(() -> {
                if (!isFinishing() && !isDestroyed()) render();
            });
        });
    }

    private void render() {
        list.removeAllViews();
        Snapshot s = WatchStore.snapshot(this);
        Snapshot.Quote q = s == null ? null : s.quote(coin);
        if (q == null) {
            add(coin, 18, Fmt.WHITE, true);
            add(s == null ? Fmt.emptyLine(this) : "Loading…", 14, Fmt.GREY, false).setOnClickListener(v -> load(true));
            return;
        }
        int color = SparkCard.up(q) ? SparkCard.UP : SparkCard.DOWN;
        TextView head = add(coin + (Double.isNaN(q.pct) ? "" : "  " + (q.pct >= 0 ? "+" : "\u2212") + String.format(java.util.Locale.US, "%.2f", Math.abs(q.pct)) + "%"), 18, Fmt.WHITE, true);
        if (!Double.isNaN(q.pct)) {
            android.text.SpannableString sp = new android.text.SpannableString(head.getText());
            sp.setSpan(new android.text.style.ForegroundColorSpan(color), coin.length(), sp.length(), 0);
            head.setText(sp);
        }
        add(Double.isNaN(q.price) ? "--" : Fmt.price(q.price), 26, Fmt.WHITE, true);
        chart.set(q);   // candles with volume and the live price (batch 631), else the 24 h line
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        list.addView(chart, lp);
        chart.setOnClickListener(v -> {
            Toast.makeText(this, "Refreshing", Toast.LENGTH_SHORT).show();
            load(true);
        });
        add(Double.isNaN(q.held) || q.held <= 0 ? "Not held" : "Held " + Fmt.money(q.held), 14, Fmt.WHITE, false).setPadding(0, dp(8), 0, 0);
        add(Fmt.updatedLine(this, s), 12, Fmt.GREY, false);
        TextView phone = add("Open on phone", 14, Fmt.ACCENT, true);
        phone.setPadding(dp(14), dp(8), dp(14), dp(8));
        phone.setBackgroundColor(0xFF1F2A28);
        ((LinearLayout.LayoutParams) phone.getLayoutParams()).topMargin = dp(12);
        phone.setOnClickListener(v -> {
            PhoneLink.openOnPhone(this, "portfolio", coin);
            Toast.makeText(this, "Opening on your phone", Toast.LENGTH_SHORT).show();
        });
    }

    private TextView add(String text, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        list.addView(t, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
