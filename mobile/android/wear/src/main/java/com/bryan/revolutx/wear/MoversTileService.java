package com.bryan.revolutx.wear;

import android.content.Context;
import androidx.wear.protolayout.DimensionBuilders;
import androidx.wear.protolayout.LayoutElementBuilders;
import androidx.wear.protolayout.ModifiersBuilders;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Desk #59 Tiles (Bryan 13 Oct 23:45), Tile "Top movers": the biggest 24 h moves, either way - movers[] and holdings[]
 * together, the 5 largest by size - each "COIN  +8.1%  $182.40" in green or red. A tap on a coin opens it in the watch app.
 */
public class MoversTileService extends BaseTile {

    static final int MAX = 5;

    @Override
    LayoutElementBuilders.LayoutElement layout(Context app, Snapshot s, Screen screen, Map<String, Img> imgs) {
        LayoutElementBuilders.Column.Builder col = Tiles.column().addContent(Tiles.text("Top movers, 24 h", 12, Fmt.GREY, false));
        List<Snapshot.Coin> top = s == null ? new ArrayList<>() : top(s);
        if (top.isEmpty()) {
            col.addContent(Tiles.spacer(4)).addContent(Tiles.text(s == null ? Fmt.emptyLine(app) : "No moves yet", 13, Fmt.WHITE, false));
            return Tiles.page(col.build(), Tiles.open(app, "app", MainActivity.class, null, null));
        }
        float w = screen.widthDp * 0.72f;
        for (int i = 0; i < top.size(); i++) {
            Snapshot.Coin c = top.get(i);
            Snapshot.Quote q = s.quote(c.coin);
            double price = q != null && !Double.isNaN(q.price) ? q.price : Double.NaN;
            LayoutElementBuilders.Row row = new LayoutElementBuilders.Row.Builder()
                .setWidth(DimensionBuilders.dp(w))
                .setModifiers(new ModifiersBuilders.Modifiers.Builder()
                    .setClickable(Tiles.open(app, "m" + i, CoinActivity.class, CoinActivity.EXTRA_COIN, c.coin))
                    .setPadding(new ModifiersBuilders.Padding.Builder().setTop(DimensionBuilders.dp(2)).setBottom(DimensionBuilders.dp(2)).build())
                    .build())
                .addContent(cell(c.coin, w * 0.32f, Fmt.WHITE, true, LayoutElementBuilders.HORIZONTAL_ALIGN_START))
                .addContent(cell(Fmt.pct(c.pct), w * 0.30f, Fmt.signColor(c.pct), true, LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER))
                .addContent(cell(Double.isNaN(price) ? "" : Fmt.price(price), w * 0.38f, Fmt.GREY, false, LayoutElementBuilders.HORIZONTAL_ALIGN_END))
                .build();
            col.addContent(row);
        }
        return Tiles.page(col.build(), null);
    }

    /** movers[] and holdings[] by coin, the largest 24 h moves first (a coin in both counts once). */
    static List<Snapshot.Coin> top(Snapshot s) {
        List<Snapshot.Coin> all = new ArrayList<>();
        List<String> seen = new ArrayList<>();
        for (List<Snapshot.Coin> list : List.of(s.movers, s.holdings)) {
            for (Snapshot.Coin c : list) {
                if (Double.isNaN(c.pct) || seen.contains(c.coin)) continue;
                seen.add(c.coin);
                all.add(c);
            }
        }
        all.sort((a, b) -> Double.compare(Math.abs(b.pct), Math.abs(a.pct)));
        return all.size() > MAX ? new ArrayList<>(all.subList(0, MAX)) : all;
    }

    private static LayoutElementBuilders.LayoutElement cell(String text, float wDp, int color, boolean bold, int align) {
        return new LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.dp(wDp))
            .setHorizontalAlignment(align)
            .addContent(new LayoutElementBuilders.Text.Builder().setText(text).setFontStyle(Tiles.font(13, color, bold)).setMaxLines(1).build())
            .build();
    }
}
