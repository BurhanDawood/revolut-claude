package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationType;

/**
 * Today's P&L: text "+$57", title "+1.2%". As RANGED_VALUE its value is the % (the Revolut X face colours it green or red
 * by its sign); as SHORT_TEXT for any other face.
 */
public class PnlComplication extends ComplicationBase {

    @Nullable
    @Override
    ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap) {
        if (s == null || s.pnlUsd == null) return null;
        String text = Fmt.signedMoneyShort(s.pnlUsd);
        String title = s.pnlPct != null ? Fmt.pct(s.pnlPct) : "today";
        String desc = "Today " + Fmt.signedMoney(s.pnlUsd) + (s.pnlPct != null ? ", " + Fmt.pct(s.pnlPct) : "");
        if (type == ComplicationType.RANGED_VALUE) {
            float sign = s.pnlPct != null ? s.pnlPct.floatValue() : (s.pnlUsd >= 0 ? 0f : -1f);
            return signed(sign, text, title, desc, tap);
        }
        if (type == ComplicationType.SHORT_TEXT) return shortText(text, title, desc, tap);
        return null;
    }
}
