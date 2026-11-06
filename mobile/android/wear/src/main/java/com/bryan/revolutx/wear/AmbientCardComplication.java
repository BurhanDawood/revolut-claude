package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import android.graphics.drawable.Icon;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationType;
import androidx.wear.watchface.complications.data.PhotoImageComplicationData;

/**
 * Desk #59 (Bryan 14 Oct 00:06): the Revolut X face's always-on band - the total in outline and the 6-hour line as a thin grey
 * outline, no fill, no dot, no colour (SparkCard.ambientFace), in the same place as the live face image. Numbers only (W2).
 */
public class AmbientCardComplication extends ComplicationBase {

    @Nullable
    @Override
    ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap) {
        if (type != ComplicationType.PHOTO_IMAGE || s == null) return null;
        SparkCard.Model m = SparkCard.model(this, s);
        return new PhotoImageComplicationData.Builder(Icon.createWithBitmap(SparkCard.ambientFace(m, CardComplication.scale(this))),
            text(m.describe())).build();
    }
}
