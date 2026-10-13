package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationType;
import androidx.wear.watchface.complications.data.RangedValueComplicationData;

/**
 * Desk #59 (Bryan 13 Oct 23:21): where the Revolut X face puts its pulsing dot - the 6-hour line's last point. The face can
 * animate but cannot read the card's image, so this hands it one number: 0..1 = the point's height in the line's box (0 top)
 * when the 6 h change is >= 0; -1 - height (-1..-2) when it is down, so the sign also picks green or red. No series: no data,
 * and the face draws no dot.
 */
public class DotComplication extends ComplicationBase {

    @Nullable
    @Override
    ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap) {
        if (type != ComplicationType.RANGED_VALUE || s == null) return null;
        SparkCard.Model m = SparkCard.model(this, s);
        float y = m.lastY();
        if (y < 0) return null;
        y = Math.max(0f, Math.min(1f, y));
        float v = m.up ? y : -1f - y;
        RangedValueComplicationData.Builder b = new RangedValueComplicationData.Builder(v, -2f, 1f, text(m.describe()))
            .setText(text(m.change.isEmpty() ? m.dollars : m.change));   // androidx needs a text; the face does not show it
        if (tap != null) b.setTapAction(tap);
        return b.build();
    }
}
