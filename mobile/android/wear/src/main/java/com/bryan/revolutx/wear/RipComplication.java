package com.bryan.revolutx.wear;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.wear.watchface.complications.data.ComplicationData;
import androidx.wear.watchface.complications.data.ComplicationRequest;
import androidx.wear.watchface.complications.data.ComplicationType;
import androidx.wear.watchface.complications.data.NoDataComplicationData;
import androidx.wear.watchface.complications.data.ShortTextComplicationData;
import androidx.wear.watchface.complications.data.SmallImage;
import androidx.wear.watchface.complications.data.SmallImageComplicationData;
import androidx.wear.watchface.complications.data.SmallImageType;
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService;
import java.util.Locale;

/**
 * Desk #59 (Bryan 15 Oct 13:20): "Rip alarm" - for 60 min after a Rip alarm, the coin's icon (its logo from the phone, else its
 * ticker in a green circle) as SMALL_IMAGE, which the Revolut X face flashes; SHORT_TEXT "SOL +34%" for other faces. Otherwise
 * no data, so the slot is invisible. A tap opens the coin screen and ends it (RipState).
 */
public class RipComplication extends ComplicationDataSourceService {

    static final String EXTRA_CLEAR = "rx_rip_clear";

    @Override
    public void onComplicationRequest(@NonNull ComplicationRequest request, @NonNull ComplicationRequestListener listener) {
        ComplicationData d = null;
        try {
            if (OnWatch.is(this)) d = build(request.getComplicationType());
        } catch (Exception ignored) {
            // no data
        }
        try {
            listener.onComplicationData(d != null ? d : new NoDataComplicationData());
        } catch (Exception ignored) {
            // the face went away
        }
    }

    @Nullable
    private ComplicationData build(ComplicationType type) {
        if (!RipState.active(this)) return null;
        String text = RipState.test ? "TEST" : RipState.coin
            + (Double.isNaN(RipState.pct) ? "" : " +" + String.format(Locale.US, "%.0f", RipState.pct) + "%");
        PendingIntent tap = tap(this);
        if (type == ComplicationType.SMALL_IMAGE) {
            return new SmallImageComplicationData.Builder(
                new SmallImage.Builder(Icon.createWithBitmap(RipState.icon), SmallImageType.PHOTO).build(),
                ComplicationBase.text("Rip alarm: " + text)).setTapAction(tap).build();
        }
        if (type == ComplicationType.SHORT_TEXT) {
            return new ShortTextComplicationData.Builder(ComplicationBase.text(text), ComplicationBase.text("Rip alarm: " + text))
                .setTitle(ComplicationBase.text("RIP")).setTapAction(tap).build();
        }
        return null;
    }

    /** A tap: the coin screen (the app for a test) and the icon goes. */
    static PendingIntent tap(Context ctx) {
        Intent i = RipState.test || RipState.coin == null
            ? new Intent(ctx, MainActivity.class)
            : new Intent(ctx, CoinActivity.class).putExtra(CoinActivity.EXTRA_COIN, RipState.coin);
        i.putExtra(EXTRA_CLEAR, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(ctx, 62, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Nullable
    @Override
    public ComplicationData getPreviewData(@NonNull ComplicationType type) {
        return null;
    }
}
