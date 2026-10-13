package com.bryan.revolutx.wear;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Desk #59 part 1: the watch app. The Tile's numbers plus the holdings list. Fetches every
 * minute while open and on a tap of the numbers; a tap on a coin or "Open on phone" opens the phone dashboard.
 */
public class MainActivity extends Activity {

    static final String EXTRA_REFRESH = "rx_refresh";

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private ScrollView scroll;
    private LinearLayout list;
    private boolean resumed;
    private boolean forceNext;
    private boolean notWatch;   // installed on a phone by mistake: one line, nothing else

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            load(false);
            main.postDelayed(this, 60_000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!OnWatch.is(this)) {
            notWatch = true;
            TextView t = new TextView(this);
            t.setText(OnWatch.PHONE_HINT);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            t.setTextColor(Fmt.WHITE);
            t.setGravity(Gravity.CENTER);
            int p = dp(24);
            t.setPadding(p, p, p, p);
            t.setBackgroundColor(0xFF000000);
            setContentView(t);
            return;
        }
        int pad = Math.round(getResources().getDisplayMetrics().widthPixels * 0.12f);   // the round screen's inset
        scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF000000);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setGravity(Gravity.CENTER_HORIZONTAL);
        list.setPadding(pad, pad, pad, pad * 2);
        scroll.addView(list);
        setContentView(scroll);
        forceNext = getIntent() != null && getIntent().getBooleanExtra(EXTRA_REFRESH, false);
        render();
        PhoneLink.helloAtMost(this, PhoneLink.HELLO_START_MS);   // the phone re-confirms the key, or clears it
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (notWatch) return;
        if (intent != null && intent.getBooleanExtra(EXTRA_REFRESH, false)) load(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (notWatch) return;
        resumed = true;
        scroll.requestFocus();   // the bezel / rotary input scrolls
        main.removeCallbacks(tick);
        if (forceNext) {
            forceNext = false;
            load(true);
            main.postDelayed(tick, 60_000);
        } else {
            main.post(tick);
        }
    }

    @Override
    protected void onPause() {
        resumed = false;
        if (!notWatch) main.removeCallbacks(tick);
        super.onPause();
    }

    private void load(boolean force) {
        EXEC.execute(() -> {
            Repo.refresh(getApplicationContext(), force ? 0 : Repo.AGE_SCREEN, Repo.FROM_APP);
            main.post(() -> {
                if (!isFinishing() && !isDestroyed()) render();
            });
        });
    }

    private void render() {
        list.removeAllViews();
        Snapshot s = WatchStore.snapshot(this);
        add("Revolut X", 13, Fmt.GREY, false);
        if (s == null) {
            add(Fmt.emptyLine(this), 15, Fmt.WHITE, false).setOnClickListener(v -> load(true));
            return;
        }
        View.OnClickListener refresh = v -> {
            Toast.makeText(this, "Refreshing", Toast.LENGTH_SHORT).show();
            load(true);
        };
        add(Fmt.money(s.total), 26, Fmt.WHITE, true).setOnClickListener(refresh);
        if (s.pnlUsd != null) {
            String p = Fmt.signedMoney(s.pnlUsd) + (s.pnlPct != null ? "  " + Fmt.pct(s.pnlPct) : "");
            add(p, 16, Fmt.signColor(s.pnlUsd), true).setOnClickListener(refresh);
        }
        add(Fmt.updatedLine(this, s), 12, Fmt.GREY, false).setOnClickListener(refresh);

        if (!s.movers.isEmpty()) {
            header("Top movers, 24 h");
            for (Snapshot.Coin m : s.movers) row(m.coin, Fmt.pct(m.pct), Fmt.signColor(m.pct), Fmt.price(m.price));
        }
        TextView notes = add(s.unread == 1 ? "1 unread PM note" : s.unread + " unread PM notes", 14, s.unread > 0 ? Fmt.ACCENT : Fmt.GREY, false);
        notes.setPadding(0, dp(10), 0, 0);
        notes.setOnClickListener(v -> openOnPhone("home", null));

        header("Holdings");
        if (s.holdings.isEmpty()) {
            add("None", 12, Fmt.GREY, false);
        } else {
            for (Snapshot.Coin h : s.holdings) row(h.coin, Fmt.pct(h.pct), Fmt.signColor(h.pct), Double.isNaN(h.price) ? "" : Fmt.money(h.price));
        }

        TextView phone = add("Open on phone", 14, Fmt.ACCENT, true);
        phone.setPadding(dp(14), dp(8), dp(14), dp(8));
        phone.setBackgroundColor(0xFF1F2A28);
        ((LinearLayout.LayoutParams) phone.getLayoutParams()).topMargin = dp(14);
        phone.setOnClickListener(v -> openOnPhone("portfolio", null));
    }

    private void openOnPhone(String tab, String coin) {
        PhoneLink.openOnPhone(this, tab, coin);
        Toast.makeText(this, "Opening on your phone", Toast.LENGTH_SHORT).show();
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

    private void header(String text) {
        TextView t = add(text, 12, Fmt.GREY, false);
        t.setPadding(0, dp(12), 0, dp(2));
    }

    /** COIN   +8.1%   $182.40; a tap opens the coin on the phone. */
    private void row(String coin, String pct, int pctColor, String value) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setPadding(0, dp(3), 0, dp(3));
        r.addView(cell(coin, Fmt.WHITE, true, Gravity.START), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r.addView(cell(pct, pctColor, true, Gravity.CENTER_HORIZONTAL), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r.addView(cell(value, Fmt.GREY, false, Gravity.END), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f));
        r.setOnClickListener(v -> openOnPhone("portfolio", coin));
        list.addView(r, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
    }

    private TextView cell(String text, int color, boolean bold, int gravity) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        t.setTextColor(color);
        t.setGravity(gravity);
        t.setSingleLine(true);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
