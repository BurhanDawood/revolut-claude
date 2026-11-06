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
 * Desk #59 (Bryan 14 Oct 14:01): the Revolut X face under its clock - the total at the top, the live 6-hour line raised behind the
 * time, and its change at the bottom - as one image, drawn by SparkCard like the first screen of the watch app. Numbers only
 * (W2). Drawn at the screen's own pixels: the image is the whole face.
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
        PhotoImageComplicationData.Builder b =
            new PhotoImageComplicationData.Builder(Icon.createWithBitmap(SparkCard.face(m, scale(ctx))), text(m.describe()));
        if (tap != null) b.setTapAction(tap);
        return b.build();
    }

    /** The face is 450 units across the screen: draw at the screen's own pixels so the image is not scaled. */
    static float scale(Context ctx) {
        return Math.max(0.5f, ctx.getResources().getDisplayMetrics().widthPixels / SparkCard.W);
    }
}
