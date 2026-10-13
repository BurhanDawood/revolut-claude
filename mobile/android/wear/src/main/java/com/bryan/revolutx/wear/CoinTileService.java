package com.bryan.revolutx.wear;

import android.content.Context;
import androidx.wear.protolayout.LayoutElementBuilders;
import java.util.Map;

/**
 * Desk #59 Tiles (Bryan 13 Oct 23:45), Tiles "Coin 1-3": one coin each, picked on the watch (TileCoinsActivity). Ticker and
 * 24 h %, price, the coin's 24 h line, and the holding in $; green or red by the 24 h move. A tap opens the coin in the watch
 * app; an empty slot says "Tap to choose a coin" and opens the picker for it. Data: coins[] (batch 630); on an older server
 * what holdings[] / movers[] know, without a line.
 */
abstract class CoinTileService extends BaseTile {

    abstract int slot();

    static Class<?> forSlot(int slot) {
        return slot == 1 ? CoinTile1.class : slot == 2 ? CoinTile2.class : CoinTile3.class;
    }

    @Override
    LayoutElementBuilders.LayoutElement layout(Context app, Snapshot s, Screen screen, Map<String, Img> imgs) {
        String coin = TileCoins.get(app, slot());
        LayoutElementBuilders.Column.Builder col = Tiles.column();
        if (coin == null) {
            col.addContent(Tiles.text("Coin " + slot(), 12, Fmt.GREY, false))
                .addContent(Tiles.spacer(6))
                .addContent(Tiles.text("Tap to choose a coin", 15, Fmt.ACCENT, true));
            return Tiles.page(col.build(), Tiles.open(app, "pick", TileCoinsActivity.class, TileCoinsActivity.EXTRA_SLOT, String.valueOf(slot())));
        }
        Snapshot.Quote q = s == null ? null : s.quote(coin);
        int color = q == null ? Fmt.GREY : SparkCard.up(q) ? SparkCard.UP : SparkCard.DOWN;
        LayoutElementBuilders.Spannable.Builder head = new LayoutElementBuilders.Spannable.Builder().setMaxLines(1)
            .addSpan(Tiles.span(coin, 16, Fmt.WHITE, true));
        if (q != null && !Double.isNaN(q.pct)) {
            head.addSpan(Tiles.span("  " + (q.pct >= 0 ? "+" : "−") + String.format(java.util.Locale.US, "%.2f", Math.abs(q.pct)) + "%", 14, color, true));
        }
        col.addContent(head.build());
        if (q == null) {
            col.addContent(Tiles.spacer(4)).addContent(Tiles.text(s == null ? Fmt.emptyLine(app) : "Loading…", 13, Fmt.GREY, false));
        } else {
            col.addContent(Tiles.money(Double.isNaN(q.price) ? "--" : Fmt.price(q.price), 22));
            if (q.spark != null) {
                float w = screen.widthDp * 0.66f;
                float h = 36;
                byte[] png = SparkCard.linePng(q.spark, color, screen.px(w), screen.px(h), screen.density);
                if (png != null) {
                    imgs.put("line", new Img(png, screen.px(w), screen.px(h)));
                    col.addContent(Tiles.spacer(3)).addContent(Tiles.image("line", w, h));
                }
            }
            col.addContent(Tiles.spacer(3)).addContent(Tiles.text(
                Double.isNaN(q.held) || q.held <= 0 ? "24 h · not held" : "24 h · held " + Fmt.money(q.held), 12, Fmt.GREY, false));
        }
        return Tiles.page(col.build(), Tiles.open(app, "coin", CoinActivity.class, CoinActivity.EXTRA_COIN, coin));
    }
}
