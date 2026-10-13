package com.bryan.revolutx.wear;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.concurrent.futures.CallbackToFutureAdapter;
import androidx.wear.protolayout.ActionBuilders;
import androidx.wear.protolayout.ColorBuilders;
import androidx.wear.protolayout.DimensionBuilders;
import androidx.wear.protolayout.LayoutElementBuilders;
import androidx.wear.protolayout.ModifiersBuilders;
import androidx.wear.protolayout.ResourceBuilders;
import androidx.wear.protolayout.TimelineBuilders;
import androidx.wear.tiles.RequestBuilders;
import androidx.wear.tiles.TileBuilders;
import androidx.wear.tiles.TileService;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Desk #59 part 1: the Tile. Portfolio total, today's P&L green/red, the top 3 movers (either way), unread PM notes and
 * "updated HH:MM". Asks again every minute while it is shown (freshness 60 s); a tap on the numbers fetches at once; "Open
 * on phone" opens the dashboard on the phone. Numbers only: the key is never in the Tile (W2).
 */
public class RxTileService extends TileService {

    private static final String RES_VERSION = "1";
    private static final String CLICK_REFRESH = "refresh";
    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();

    @NonNull
    @Override
    protected ListenableFuture<TileBuilders.Tile> onTileRequest(@NonNull RequestBuilders.TileRequest request) {
        final Context app = getApplicationContext();
        boolean tapped = CLICK_REFRESH.equals(request.getCurrentState().getLastClickableId());
        final long maxAge = tapped ? 0 : Repo.AGE_SCREEN;
        return CallbackToFutureAdapter.getFuture(completer -> {
            EXEC.execute(() -> {
                try {
                    Repo.refresh(app, maxAge, Repo.FROM_TILE);
                    completer.set(tile(app));
                } catch (Exception e) {
                    completer.setException(e);
                }
            });
            return "rx-tile";
        });
    }

    @NonNull
    @Override
    protected ListenableFuture<ResourceBuilders.Resources> onTileResourcesRequest(@NonNull RequestBuilders.ResourcesRequest request) {
        return CallbackToFutureAdapter.getFuture(completer -> {
            completer.set(new ResourceBuilders.Resources.Builder().setVersion(RES_VERSION).build());
            return "rx-tile-res";
        });
    }

    private static TileBuilders.Tile tile(Context app) {
        return new TileBuilders.Tile.Builder()
            .setResourcesVersion(RES_VERSION)
            .setFreshnessIntervalMillis(60_000)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout(app)))
            .build();
    }

    private static LayoutElementBuilders.LayoutElement layout(Context app) {
        Snapshot s = WatchStore.snapshot(app);
        LayoutElementBuilders.Column.Builder numbers = new LayoutElementBuilders.Column.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text("Revolut X", 12, Fmt.GREY, false));
        if (s == null) {
            numbers.addContent(text(Fmt.emptyLine(app), 14, Fmt.WHITE, false));
        } else {
            numbers.addContent(text(Fmt.money(s.total), 24, Fmt.WHITE, true));
            if (s.pnlUsd != null) {
                String p = Fmt.signedMoney(s.pnlUsd) + (s.pnlPct != null ? "  " + Fmt.pct(s.pnlPct) : "");
                numbers.addContent(text(p, 15, Fmt.signColor(s.pnlUsd), true));
            }
            if (!s.movers.isEmpty()) {
                numbers.addContent(spacer(4));
                LayoutElementBuilders.Spannable.Builder movers = new LayoutElementBuilders.Spannable.Builder()
                    .setMaxLines(2)
                    .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER);
                for (int i = 0; i < s.movers.size(); i++) {
                    Snapshot.Coin m = s.movers.get(i);
                    if (i > 0) movers.addSpan(span("  ", 13, Fmt.GREY, false));
                    movers.addSpan(span(m.coin + " ", 13, Fmt.WHITE, false));
                    movers.addSpan(span(Fmt.pct(m.pct), 13, Fmt.signColor(m.pct), true));
                }
                numbers.addContent(movers.build());
            }
            numbers.addContent(spacer(2));
            numbers.addContent(text(s.unread == 1 ? "1 unread PM note" : s.unread + " unread PM notes", 12, s.unread > 0 ? Fmt.ACCENT : Fmt.GREY, false));
            numbers.addContent(text(Fmt.updatedLine(app, s), 11, Fmt.GREY, false));
        }

        LayoutElementBuilders.Box refresh = new LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHeight(DimensionBuilders.wrap())
            .setModifiers(new ModifiersBuilders.Modifiers.Builder()
                .setClickable(new ModifiersBuilders.Clickable.Builder()
                    .setId(CLICK_REFRESH)
                    .setOnClick(new ActionBuilders.LoadAction.Builder().build())
                    .build())
                .build())
            .addContent(numbers.build())
            .build();

        LayoutElementBuilders.Box phone = new LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.wrap())
            .setHeight(DimensionBuilders.wrap())
            .setModifiers(new ModifiersBuilders.Modifiers.Builder()
                .setClickable(new ModifiersBuilders.Clickable.Builder()
                    .setId("phone")
                    .setOnClick(new ActionBuilders.LaunchAction.Builder()
                        .setAndroidActivity(new ActionBuilders.AndroidActivity.Builder()
                            .setPackageName(app.getPackageName())
                            .setClassName(OpenOnPhoneActivity.class.getName())
                            .build())
                        .build())
                    .build())
                .setBackground(new ModifiersBuilders.Background.Builder()
                    .setColor(ColorBuilders.argb(0xFF1F2A28))
                    .setCorner(new ModifiersBuilders.Corner.Builder().setRadius(DimensionBuilders.dp(14)).build())
                    .build())
                .setPadding(new ModifiersBuilders.Padding.Builder()
                    .setStart(DimensionBuilders.dp(12))
                    .setEnd(DimensionBuilders.dp(12))
                    .setTop(DimensionBuilders.dp(5))
                    .setBottom(DimensionBuilders.dp(5))
                    .build())
                .build())
            .addContent(text("Open on phone", 12, Fmt.ACCENT, false))
            .build();

        return new LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHeight(DimensionBuilders.expand())
            .setModifiers(new ModifiersBuilders.Modifiers.Builder()
                .setPadding(new ModifiersBuilders.Padding.Builder()
                    .setStart(DimensionBuilders.dp(14))
                    .setEnd(DimensionBuilders.dp(14))
                    .build())
                .build())
            .addContent(new LayoutElementBuilders.Column.Builder()
                .setWidth(DimensionBuilders.expand())
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
                .addContent(refresh)
                .addContent(spacer(6))
                .addContent(phone)
                .build())
            .build();
    }

    private static LayoutElementBuilders.FontStyle font(float sp, int color, boolean bold) {
        return new LayoutElementBuilders.FontStyle.Builder()
            .setSize(DimensionBuilders.sp(sp))
            .setColor(ColorBuilders.argb(color))
            .setWeight(bold ? LayoutElementBuilders.FONT_WEIGHT_BOLD : LayoutElementBuilders.FONT_WEIGHT_NORMAL)
            .build();
    }

    private static LayoutElementBuilders.Text text(String s, float sp, int color, boolean bold) {
        return new LayoutElementBuilders.Text.Builder()
            .setText(s)
            .setFontStyle(font(sp, color, bold))
            .setMaxLines(2)
            .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
            .build();
    }

    private static LayoutElementBuilders.SpanText span(String s, float sp, int color, boolean bold) {
        return new LayoutElementBuilders.SpanText.Builder().setText(s).setFontStyle(font(sp, color, bold)).build();
    }

    private static LayoutElementBuilders.Spacer spacer(float dp) {
        return new LayoutElementBuilders.Spacer.Builder().setHeight(DimensionBuilders.dp(dp)).build();
    }
}
