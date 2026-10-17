package com.bryan.revolutx.wear;

import android.content.Context;
import androidx.wear.protolayout.LayoutElementBuilders;
import java.util.Map;

/**
 * Desk #59 Tiles (Bryan 13 Oct 23:45), Tile 1 "Portfolio": the total with the cents smaller, the 6-hour line with the dot (still:
 * a Tile cannot animate) and "6 hours -$133.89 (-2.68%)", green or red like the face and the app (SparkCard). No series: no
 * line, today's P&L instead. A tap opens the watch app, which is live. (The class keeps its name so a placed Tile stays.)
 */
public class RxTileService extends BaseTile {

    @Override
    LayoutElementBuilders.LayoutElement layout(Context app, Snapshot s, Screen screen, Map<String, Img> imgs) {
        LayoutElementBuilders.Column.Builder col = Tiles.column().addContent(Tiles.text("Revolut X", 12, Fmt.GREY, false));
        if (s == null || s.total == null) {
            col.addContent(Tiles.spacer(4)).addContent(Tiles.text(Fmt.emptyLine(app), 14, Fmt.WHITE, false));
            return Tiles.page(col.build(), Tiles.open(app, "app", MainActivity.class, null, null));
        }
        SparkCard.Model m = SparkCard.model(app, s);
        col.addContent(Tiles.money(Fmt.money(s.total), 24));
        if (s.spark != null) {
            float w = screen.widthDp * 0.66f;
            float h = 40;
            byte[] png = SparkCard.linePng(s.spark, m.color, screen.px(w), screen.px(h), screen.density);
            if (png != null) {
                imgs.put("line", new Img(png, screen.px(w), screen.px(h)));
                col.addContent(Tiles.spacer(4)).addContent(Tiles.image("line", w, h));
            }
        }
        col.addContent(Tiles.spacer(4)).addContent(new LayoutElementBuilders.Spannable.Builder()
            .setMaxLines(1)
            .addSpan(Tiles.span(m.range + "  ", 12, Fmt.GREY, false))
            .addSpan(Tiles.span(m.change, 12, m.color, true))
            .build());
        col.addContent(Tiles.text(Fmt.updatedLine(app, s), 10, Fmt.GREY, false));
        return Tiles.page(col.build(), Tiles.open(app, "app", MainActivity.class, null, null));
    }
}
