package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationType;

/** The whole book: "$4,827". */
public class TotalComplication extends ComplicationBase {

    @Nullable
    @Override
    ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap) {
        if (s == null || s.total == null || type != ComplicationType.SHORT_TEXT) return null;
        return shortText(Fmt.moneyShort(s.total), "Total", "Portfolio " + Fmt.money(s.total), tap);
    }
}
