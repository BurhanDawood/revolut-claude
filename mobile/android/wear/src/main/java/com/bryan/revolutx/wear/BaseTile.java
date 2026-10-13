package com.bryan.revolutx.wear;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.concurrent.futures.CallbackToFutureAdapter;
import androidx.wear.protolayout.DeviceParametersBuilders;
import androidx.wear.protolayout.LayoutElementBuilders;
import androidx.wear.protolayout.ResourceBuilders;
import androidx.wear.protolayout.TimelineBuilders;
import androidx.wear.tiles.EventBuilders;
import androidx.wear.tiles.RequestBuilders;
import androidx.wear.tiles.TileBuilders;
import androidx.wear.tiles.TileService;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Desk #59 Tiles: what every Revolut X Tile does. On each request it reads the summary through Repo (at most every 30 s, the
 * server's cache; one read serves all the Tiles), then lays out from the saved answer. Swiping to a Tile asks for a fresh read
 * (onTileEnterEvent); otherwise Wear OS's own schedule. Lines are images drawn by SparkCard (the face's and the app's routine),
 * handed over as Tile resources whose version changes with the picture. Numbers only: the key is never in a Tile (W2).
 * On a phone (the watch APK installed there by mistake) a Tile shows the one-line hint and fetches nothing.
 */
abstract class BaseTile extends TileService {

    /** A PNG for the layout, at its pixel size. */
    static final class Img {
        final byte[] png;
        final int w;
        final int h;

        Img(byte[] png, int w, int h) {
            this.png = png;
            this.w = w;
            this.h = h;
        }
    }

    /** What the layout needs to size its images. */
    static final class Screen {
        final float widthDp;
        final float density;

        Screen(float widthDp, float density) {
            this.widthDp = widthDp;
            this.density = density;
        }

        int px(float dp) {
            return Math.max(1, Math.round(dp * density));
        }
    }

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private static final Map<Class<?>, Object[]> LAST = new ConcurrentHashMap<>();   // class -> { version, images }

    /** The Tile from the saved answer (s is null before the first one); images it uses go in imgs. Never fetches. */
    abstract LayoutElementBuilders.LayoutElement layout(Context app, Snapshot s, Screen screen, Map<String, Img> imgs);

    @NonNull
    @Override
    protected ListenableFuture<TileBuilders.Tile> onTileRequest(@NonNull RequestBuilders.TileRequest request) {
        final Context app = getApplicationContext();
        final Screen screen = screen(request.getDeviceConfiguration());
        return CallbackToFutureAdapter.getFuture(completer -> {
            EXEC.execute(() -> {
                try {
                    if (!OnWatch.is(app)) {   // not a watch: the hint only, no fetch
                        completer.set(tile("0", Tiles.page(Tiles.text(OnWatch.PHONE_HINT, 13, Fmt.WHITE, false), null)));
                        return;
                    }
                    Repo.refresh(app, Repo.AGE_TILE, Repo.FROM_TILE);
                    Map<String, Img> imgs = new LinkedHashMap<>();
                    LayoutElementBuilders.LayoutElement root = layout(app, WatchStore.snapshot(app), screen, imgs);
                    String version = version(imgs);
                    LAST.put(getClass(), new Object[] { version, imgs });
                    completer.set(tile(version, root));
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
        final Context app = getApplicationContext();
        final String version = request.getVersion();
        final Screen screen = screen(request.getDeviceConfiguration());
        return CallbackToFutureAdapter.getFuture(completer -> {
            EXEC.execute(() -> {
                try {
                    Object[] last = LAST.get(getClass());
                    @SuppressWarnings("unchecked")
                    Map<String, Img> imgs = last != null && version.equals(last[0]) ? (Map<String, Img>) last[1] : null;
                    if (imgs == null) {   // the process restarted: draw again from the saved answer
                        imgs = new LinkedHashMap<>();
                        if (OnWatch.is(app)) layout(app, WatchStore.snapshot(app), screen, imgs);
                    }
                    ResourceBuilders.Resources.Builder r = new ResourceBuilders.Resources.Builder().setVersion(version);
                    for (Map.Entry<String, Img> e : imgs.entrySet()) {
                        Img i = e.getValue();
                        r.addIdToImageMapping(e.getKey(), new ResourceBuilders.ImageResource.Builder()
                            .setInlineResource(new ResourceBuilders.InlineImageResource.Builder()
                                .setData(i.png)
                                .setWidthPx(i.w)
                                .setHeightPx(i.h)
                                .setFormat(ResourceBuilders.IMAGE_FORMAT_UNDEFINED)   // PNG bytes, decoded by the renderer
                                .build())
                            .build());
                    }
                    completer.set(r.build());
                } catch (Exception e) {
                    completer.setException(e);
                }
            });
            return "rx-tile-res";
        });
    }

    /** Swiping to the Tile: ask for it again, which reads the summary if the last answer is over 30 s old. */
    @Override
    protected void onTileEnterEvent(@NonNull EventBuilders.TileEnterEvent event) {
        Tiles.update(this, getClass());
    }

    private static TileBuilders.Tile tile(String version, LayoutElementBuilders.LayoutElement root) {
        return new TileBuilders.Tile.Builder()
            .setResourcesVersion(version)
            .setFreshnessIntervalMillis(5 * 60_000)   // Wear OS's schedule in between swipes
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
            .build();
    }

    private static Screen screen(DeviceParametersBuilders.DeviceParameters d) {
        float w = d != null && d.getScreenWidthDp() > 0 ? d.getScreenWidthDp() : 225f;
        float density = d != null && d.getScreenDensity() > 0 ? d.getScreenDensity() : 2f;
        return new Screen(w, density);
    }

    private static String version(Map<String, Img> imgs) {
        int h = 17;
        for (Map.Entry<String, Img> e : imgs.entrySet()) h = 31 * h + e.getKey().hashCode() * 7 + Arrays.hashCode(e.getValue().png);
        return imgs.isEmpty() ? "0" : Integer.toHexString(h);
    }
}
