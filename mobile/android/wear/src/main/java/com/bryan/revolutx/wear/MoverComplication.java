package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationType;

/** The biggest 24 h mover, either way: text "+8.1%", title "SOL". */
public class MoverComplication extends ComplicationBase {

    @Nullable
    @Override
    ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap) {
        if (s == null || s.movers.isEmpty()) return null;
        Snapshot.Coin m = s.movers.get(0);
        String desc = m.coin + " " + Fmt.pct(m.pct) + " in 24 hours";
        if (type == ComplicationType.RANGED_VALUE && !Double.isNaN(m.pct)) return signed((float) m.pct, Fmt.pct(m.pct), m.coin, desc, tap);
        if (type == ComplicationType.SHORT_TEXT) return shortText(Fmt.pct(m.pct), m.coin, desc, tap);
        return null;
    }
}
