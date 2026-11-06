package com.bryan.revolutx.wear;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Desk #59 Tiles (Bryan 13 Oct 23:45): "Tile coins" - the three coins the Coin 1-3 Tiles show. Each slot opens a list from
 * GET /api/watch?choices=1 (held coins first, then A-Z; Repo.choices), and the pick is saved on the watch only (TileCoins).
 * Opened from the app's "Tile coins" button, or from an empty Coin Tile straight into that slot's list.
 */
public class TileCoinsActivity extends Activity {

    static final String EXTRA_SLOT = "slot";

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private LinearLayout list;
    private boolean fromTile;   // opened for one slot: close after the pick

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!OnWatch.is(this)) {
            Toast.makeText(this, OnWatch.PHONE_HINT, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
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
        int slot = 0;
        try {
            slot = Integer.parseInt(getIntent() != null && getIntent().getStringExtra(EXTRA_SLOT) != null ? getIntent().getStringExtra(EXTRA_SLOT) : "0");
        } catch (NumberFormatException ignored) {
            // no slot: the overview
        }
        if (slot >= 1 && slot <= TileCoins.SLOTS) {
            fromTile = true;
            pick(slot);
        } else {
            slots();
        }
    }

    /** Coin 1: SOL / Coin 2: (empty) / Coin 3: ... */
    private void slots() {
        list.removeAllViews();
        add("Tile coins", 16, Fmt.WHITE, true);
        add("The Coin 1-3 Tiles show these", 12, Fmt.GREY, false);
        for (int i = 1; i <= TileCoins.SLOTS; i++) {
            final int slot = i;
            String c = TileCoins.get(this, i);
            TextView t = button("Coin " + i + ":  " + (c == null ? "choose…" : c), c == null ? Fmt.ACCENT : Fmt.WHITE);
            t.setOnClickListener(v -> pick(slot));
        }
        add("Add a Tile: swipe left from the face, then +", 11, Fmt.GREY, false).setPadding(0, dp(12), 0, 0);
    }

    /** The coins for one slot, loading first. */
    private void pick(int slot) {
        list.removeAllViews();
        add("Coin " + slot, 16, Fmt.WHITE, true);
        add("Loading coins…", 13, Fmt.GREY, false);
        EXEC.execute(() -> {
            List<String> coins = Repo.choices(getApplicationContext());
            Snapshot s = WatchStore.snapshot(getApplicationContext());
            main.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                list.removeAllViews();
                add("Coin " + slot, 16, Fmt.WHITE, true);
                if (!fromTile) button("‹ Back", Fmt.GREY).setOnClickListener(v -> slots());
                String now = TileCoins.get(this, slot);
                if (now != null) button("None (empty this Tile)", Fmt.GREY).setOnClickListener(v -> chosen(slot, null));
                if (coins.isEmpty()) add(s == null ? Fmt.emptyLine(this) : "No coins to choose from yet", 13, Fmt.GREY, false);
                for (String c : coins) {
                    boolean held = false;
                    if (s != null) for (Snapshot.Coin h : s.holdings) held |= h.coin.equals(c);
                    TextView t = button(c + (held ? "  · held" : "") + (c.equals(now) ? "  ✓" : ""), c.equals(now) ? Fmt.ACCENT : Fmt.WHITE);
                    t.setOnClickListener(v -> chosen(slot, c));
                }
            });
        });
    }

    private void chosen(int slot, String coin) {
        TileCoins.set(this, slot, coin);
        Toast.makeText(this, "Coin " + slot + ": " + (coin == null ? "empty" : coin), Toast.LENGTH_SHORT).show();
        if (fromTile) finish();
        else slots();
    }

    private TextView button(String text, int color) {
        TextView t = add(text, 15, color, true);
        t.setPadding(dp(12), dp(9), dp(12), dp(9));
        t.setBackgroundColor(0xFF1A1A1A);
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) t.getLayoutParams();
        lp.width = LinearLayout.LayoutParams.MATCH_PARENT;
        lp.topMargin = dp(4);
        return t;
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
