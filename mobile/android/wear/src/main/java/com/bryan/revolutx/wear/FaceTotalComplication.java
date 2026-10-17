package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationType;

/**
 * Desk #59 (Bryan 13 Oct 23:20): the Revolut X face's always-on total, split so the face can draw the cents smaller: text
 * "$4,863", title ".98". (TotalComplication stays "$4,863" / "Total" for other faces.)
 */
public class FaceTotalComplication extends ComplicationBase {

    @Nullable
    @Override
    ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap) {
        if (s == null || s.total == null || type != ComplicationType.SHORT_TEXT) return null;
        String total = Fmt.money(s.total);
        int dot = total.lastIndexOf('.');
        String dollars = dot > 0 ? total.substring(0, dot) : total;
        String cents = dot > 0 ? total.substring(dot) : "";
        return shortText(dollars, cents.isEmpty() ? null : cents, "Portfolio " + total, tap);
    }
}
