package com.bryan.revolutx.wear;

import android.content.Context;
import androidx.wear.protolayout.ActionBuilders;
import androidx.wear.protolayout.ColorBuilders;
import androidx.wear.protolayout.DimensionBuilders;
import androidx.wear.protolayout.LayoutElementBuilders;
import androidx.wear.protolayout.ModifiersBuilders;
import androidx.wear.tiles.TileService;

/**
 * Desk #59 Tiles (Bryan 13 Oct 23:45): what the Tiles share - the list of them, "redraw", and the layout pieces (text, a
 * line image, a tap that opens a watch screen). Each Tile is its own service, so Bryan adds, removes and orders them himself.
 */
final class Tiles {

    /** Every Tile: Portfolio (RxTileService, the first Tile's class, so a placed Tile stays), Coin 1-3, Top movers, PM notes. */
    static final Class<?>[] ALL = { RxTileService.class, CoinTile1.class, CoinTile2.class, CoinTile3.class, MoversTileService.class,
        NotesTileService.class };

    private Tiles() {}

    static void update(Context ctx, Class<?> tile) {
        try {
            TileService.getUpdater(ctx.getApplicationContext()).requestUpdate(tile.asSubclass(TileService.class));
        } catch (Exception ignored) {
            // the Tile is not placed
        }
    }

    static void updateAll(Context ctx) {
        for (Class<?> t : ALL) update(ctx, t);
    }

    static LayoutElementBuilders.FontStyle font(float sp, int color, boolean bold) {
        return new LayoutElementBuilders.FontStyle.Builder()
            .setSize(DimensionBuilders.sp(sp))
            .setColor(ColorBuilders.argb(color))
            .setWeight(bold ? LayoutElementBuilders.FONT_WEIGHT_BOLD : LayoutElementBuilders.FONT_WEIGHT_NORMAL)
            .build();
    }

    static LayoutElementBuilders.Text text(String s, float sp, int color, boolean bold) {
        return new LayoutElementBuilders.Text.Builder()
            .setText(s)
            .setFontStyle(font(sp, color, bold))
            .setMaxLines(2)
            .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
            .build();
    }

    static LayoutElementBuilders.Text text(String s, float sp, int color, boolean bold, int maxLines) {
        return new LayoutElementBuilders.Text.Builder()
            .setText(s)
            .setFontStyle(font(sp, color, bold))
            .setMaxLines(maxLines)
            .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE_END)
            .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
            .build();
    }

    static LayoutElementBuilders.SpanText span(String s, float sp, int color, boolean bold) {
        return new LayoutElementBuilders.SpanText.Builder().setText(s).setFontStyle(font(sp, color, bold)).build();
    }

    static LayoutElementBuilders.Spacer spacer(float dp) {
        return new LayoutElementBuilders.Spacer.Builder().setHeight(DimensionBuilders.dp(dp)).build();
    }

    /** "$4,863" big and ".98" smaller, like the card. */
    static LayoutElementBuilders.Spannable money(String text, float sp) {
        int dot = text.lastIndexOf('.');
        LayoutElementBuilders.Spannable.Builder b = new LayoutElementBuilders.Spannable.Builder().setMaxLines(1);
        b.addSpan(span(dot > 0 ? text.substring(0, dot) : text, sp, Fmt.WHITE, true));
        if (dot > 0) b.addSpan(span(text.substring(dot), sp * 0.62f, Fmt.WHITE, true));
        return b.build();
    }

    static LayoutElementBuilders.Image image(String id, float wDp, float hDp) {
        return new LayoutElementBuilders.Image.Builder()
            .setResourceId(id)
            .setWidth(DimensionBuilders.dp(wDp))
            .setHeight(DimensionBuilders.dp(hDp))
            .build();
    }

    /** A tap that opens one of this app's screens, with an optional string extra. */
    static ModifiersBuilders.Clickable open(Context app, String id, Class<?> activity, String extraKey, String extraValue) {
        ActionBuilders.AndroidActivity.Builder a = new ActionBuilders.AndroidActivity.Builder()
            .setPackageName(app.getPackageName())
            .setClassName(activity.getName());
        if (extraKey != null) a.addKeyToExtraMapping(extraKey, new ActionBuilders.AndroidStringExtra.Builder().setValue(extraValue).build());
        return new ModifiersBuilders.Clickable.Builder()
            .setId(id)
            .setOnClick(new ActionBuilders.LaunchAction.Builder().setAndroidActivity(a.build()).build())
            .build();
    }

    /** The whole Tile: padded, centred, one tap target. */
    static LayoutElementBuilders.LayoutElement page(LayoutElementBuilders.LayoutElement content, ModifiersBuilders.Clickable tap) {
        ModifiersBuilders.Modifiers.Builder m = new ModifiersBuilders.Modifiers.Builder()
            .setPadding(new ModifiersBuilders.Padding.Builder().setStart(DimensionBuilders.dp(14)).setEnd(DimensionBuilders.dp(14)).build());
        if (tap != null) m.setClickable(tap);
        return new LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHeight(DimensionBuilders.expand())
            .setModifiers(m.build())
            .addContent(content)
            .build();
    }

    static LayoutElementBuilders.Column.Builder column() {
        return new LayoutElementBuilders.Column.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER);
    }
}
