package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationType;

/** Unread PM notes: a count only, never a note's text. */
public class NotesComplication extends ComplicationBase {

    @Nullable
    @Override
    ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap) {
        if (s == null || type != ComplicationType.SHORT_TEXT) return null;
        return shortText(String.valueOf(s.unread), "PM notes", s.unread + " unread PM notes", tap);
    }
}
