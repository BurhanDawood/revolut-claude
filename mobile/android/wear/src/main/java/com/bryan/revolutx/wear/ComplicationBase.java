package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.RemoteException;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationText;
import androidx.wear.watchface.complications.data.ComplicationType;
import androidx.wear.watchface.complications.data.NoDataComplicationData;
import androidx.wear.watchface.complications.data.PlainComplicationText;
import androidx.wear.watchface.complications.data.RangedValueComplicationData;
import androidx.wear.watchface.complications.data.ShortTextComplicationData;
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService;
import androidx.wear.watchface.complications.datasource.ComplicationRequest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Desk #59 part 2: the complication data sources the Revolut X face (and any face) reads. Wear OS asks every 5 minutes
 * (UPDATE_PERIOD_SECONDS 300, its floor) while a face shows them; they also redraw whenever the app or Tile fetched.
 * Numbers and counts only: complication data is readable by whichever face shows it, so the key is never in it (W2).
 * A tap opens the watch app, which fetches at once.
 */
public abstract class ComplicationBase extends ComplicationDataSourceService {

    static final Class<?>[] ALL = { TotalComplication.class, PnlComplication.class, NotesComplication.class, MoverComplication.class,
        CardComplication.class, DotComplication.class, FaceTotalComplication.class };

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();

    /** The data for this source, or null for "no data". s is null before the first answer. */
    @Nullable
    abstract ComplicationData build(@NonNull ComplicationType type, @Nullable Snapshot s, @Nullable PendingIntent tap);

    @Override
    public void onComplicationRequest(@NonNull ComplicationRequest request, @NonNull ComplicationDataSourceService.ComplicationRequestListener listener) {
        final Context app = getApplicationContext();
        final ComplicationType type = request.getComplicationType();
        if (!OnWatch.is(app)) {   // not a watch: no data, no fetch
            try {
                listener.onComplicationData(new NoDataComplicationData());
            } catch (RemoteException ignored) {
                // the caller went away
            }
            return;
        }
        EXEC.execute(() -> {
            ComplicationData d = null;
            try {
                Repo.refresh(app, Repo.AGE_COMPLICATION, Repo.FROM_COMPLICATION);
                Snapshot s = WatchStore.snapshot(app);
                d = s == null ? empty(app, type) : build(type, s, tap(app));
            } catch (Exception e) {
                // the last data stays; the reason goes to the log (the class and type only, never data)
                Log.w("RxWatch", getClass().getSimpleName() + " " + type + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
            }
            if (d == null) Log.i("RxWatch", getClass().getSimpleName() + " " + type + ": no data");
            try {
                listener.onComplicationData(d != null ? d : new NoDataComplicationData());
            } catch (RemoteException ignored) {
                // the face went away
            }
        });
    }

    @Nullable
    @Override
    public ComplicationData getPreviewData(@NonNull ComplicationType type) {
        Snapshot s = new Snapshot();
        s.total = 4826.69;
        s.pnlUsd = 57.3;
        s.pnlPct = 1.2;
        s.unread = 3;
        s.movers.add(new Snapshot.Coin("SOL", 8.1, 182.4));
        s.spark = new double[61];   // a gentle 6 h rise for the face picker's preview
        for (int i = 0; i < s.spark.length; i++) s.spark[i] = 4770 + i * 0.9 + 14 * Math.sin(i / 6.0);
        s.sparkChgUsd = s.spark[60] - s.spark[0];
        s.sparkChgPct = s.sparkChgUsd / s.spark[0] * 100;
        return build(type, s, null);
    }

    /** Before the first answer: "--" with a hint, so the face does not look broken. */
    @Nullable
    ComplicationData empty(Context app, ComplicationType type) {
        if (type != ComplicationType.SHORT_TEXT) return null;
        String title = WatchStore.hasKey(app) ? "Rx" : "Set up";
        return shortText("--", title, "Revolut X: " + Fmt.emptyLine(app), tap(app));
    }

    static ComplicationText text(String s) {
        return new PlainComplicationText.Builder(s).build();
    }

    static ComplicationData shortText(String text, @Nullable String title, String description, @Nullable PendingIntent tap) {
        ShortTextComplicationData.Builder b = new ShortTextComplicationData.Builder(text(text), text(description));
        if (title != null) b.setTitle(text(title));
        if (tap != null) b.setTapAction(tap);
        return b.build();
    }

    /** A value with a sign the face colours by (RANGED_VALUE_VALUE >= 0: green). The value is clamped to [-100, 100]. */
    static ComplicationData signed(float value, String text, @Nullable String title, String description, @Nullable PendingIntent tap) {
        float v = Math.max(-100f, Math.min(100f, value));
        RangedValueComplicationData.Builder b = new RangedValueComplicationData.Builder(v, -100f, 100f, text(description)).setText(text(text));
        if (title != null) b.setTitle(text(title));
        if (tap != null) b.setTapAction(tap);
        return b.build();
    }

    static PendingIntent tap(Context app) {
        Intent i = new Intent(app, MainActivity.class).putExtra(MainActivity.EXTRA_REFRESH, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(app, 59, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
