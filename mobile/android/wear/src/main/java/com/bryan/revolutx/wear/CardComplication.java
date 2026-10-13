package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import android.content.Context;
import android.graphics.drawable.Icon;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationType;
import androidx.wear.watchface.complications.data.PhotoImageComplicationData;

/**
 * Desk #59 (Bryan 14 Oct 00:06): the Revolut X face's middle band - the total over the live 6-hour line and its change - as one
 * image, drawn by SparkCard like the top of the watch app. Numbers only (W2). Sent as a PNG (a few kB) at the screen's own
 * pixels: the band is the face's full width.
 */
public class CardComplication extends ComplicationBase {

    @Nullable
    @Override
    ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap) {
        if (type != ComplicationType.PHOTO_IMAGE) return null;
        return photo(this, SparkCard.model(this, s), tap);
    }

    /** Before the first answer the card says why ("Open Revolut X on your phone to connect"). */
    @Nullable
    @Override
    ComplicationData empty(Context app, ComplicationType type) {
        if (type != ComplicationType.PHOTO_IMAGE) return null;
        return photo(app, SparkCard.model(app, null), tap(app));
    }

    private static ComplicationData photo(Context ctx, SparkCard.Model m, @Nullable PendingIntent tap) {
        byte[] png = SparkCard.png(m, scale(ctx));
        PhotoImageComplicationData.Builder b =
            new PhotoImageComplicationData.Builder(Icon.createWithData(png, 0, png.length), text(m.describe()));
        if (tap != null) b.setTapAction(tap);
        return b.build();
    }

    /** The face is 450 units across the screen: draw at the screen's own pixels so the image is not scaled. */
    static float scale(Context ctx) {
        return Math.max(0.5f, ctx.getResources().getDisplayMetrics().widthPixels / SparkCard.W);
    }
}
