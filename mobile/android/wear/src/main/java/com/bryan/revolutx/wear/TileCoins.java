package com.bryan.revolutx.wear;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;

/**
 * Desk #59 Tiles (Bryan 13 Oct 23:45): the three coins the Coin 1-3 Tiles show, picked on the watch (TileCoinsActivity) and
 * kept only in this app's own prefs. They are coin tickers, nothing secret, so they stay when the key changes or is cleared.
 * The summary fetch asks for them (and for the coin open on screen) with ?coins=, one read for every Tile.
 */
final class TileCoins {

    static final int SLOTS = 3;
    private static final String FILE = "rx_watch_tiles";
    private static final String VIEWING = "viewing";   // the coin open in CoinActivity, fetched with the Tile coins

    private TileCoins() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static boolean valid(String coin) {
        return coin != null && coin.matches("[A-Z0-9]{1,15}");
    }

    /** The coin in slot 1..3, or null. */
    static String get(Context ctx, int slot) {
        String c = prefs(ctx).getString("slot" + slot, null);
        return valid(c) ? c : null;
    }

    /** Saves (or with null clears) a slot and redraws its Tile; the next read asks for the new coin. */
    static void set(Context ctx, int slot, String coin) {
        if (slot < 1 || slot > SLOTS) return;
        SharedPreferences.Editor e = prefs(ctx).edit();
        if (valid(coin)) e.putString("slot" + slot, coin);
        else e.remove("slot" + slot);
        e.commit();
        Tiles.update(ctx, CoinTileService.forSlot(slot));
    }

    static void viewing(Context ctx, String coin) {
        prefs(ctx).edit().putString(VIEWING, valid(coin) ? coin : "").apply();
    }

    /** The ?coins= list: the slot coins, then the coin on screen; unique, at most 5 (the server's limit). */
    static String wanted(Context ctx) {
        List<String> out = new ArrayList<>();
        for (int i = 1; i <= SLOTS; i++) {
            String c = get(ctx, i);
            if (c != null && !out.contains(c)) out.add(c);
        }
        String v = prefs(ctx).getString(VIEWING, "");
        if (valid(v) && !out.contains(v)) out.add(v);
        while (out.size() > 5) out.remove(out.size() - 1);
        return String.join(",", out);
    }
}
