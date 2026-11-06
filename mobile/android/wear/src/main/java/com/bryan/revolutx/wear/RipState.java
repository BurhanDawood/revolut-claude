package com.bryan.revolutx.wear;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.util.Log;
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester;
import java.io.File;
import java.io.FileOutputStream;

/**
 * Desk #59 (Bryan 15 Oct 13:20): "ripping" - after a Rip alarm the face flashes that coin's icon (RipComplication) for 60 min.
 * Held in memory, with a copy in this app's own files so a restarted watch app still knows it: the coin, its +%, until when,
 * and the logo the phone sent (else the ticker in a green circle). It ends on a tap of the icon (the coin screen), Stop or a
 * swipe of the alarm, or after 60 min. Nothing is sent anywhere.
 */
final class RipState {

    static final long FOR_MS = 60 * 60_000L;
    private static final String TAG = "RxRipRing";

    static String coin;
    static double pct = Double.NaN;
    static boolean test;
    static long until;
    static Bitmap icon;

    private RipState() {}

    static synchronized void start(Context ctx, RipRing.Alarm a) {
        Context app = ctx.getApplicationContext();
        coin = a.coin;
        pct = a.pct;
        test = a.test;
        until = System.currentTimeMillis() + FOR_MS;
        Bitmap logo = a.logo == null ? null : BitmapFactory.decodeByteArray(a.logo, 0, a.logo.length);
        icon = logo != null ? round(logo) : tickerIcon(a.coin);
        save(app);
        AlarmManager am = app.getSystemService(AlarmManager.class);
        if (am != null) am.set(AlarmManager.RTC, until + 1000, expiry(app));   // inexact is fine: within a few minutes
        update(app);
        Log.i(TAG, "the face flashes " + coin + "'s icon for 60 min (" + (logo != null ? "its logo" : "the ticker") + ")");
    }

    /** True while ripping; reads the saved copy when the watch app was restarted. */
    static synchronized boolean active(Context ctx) {
        if (coin == null) load(ctx.getApplicationContext());
        return coin != null && System.currentTimeMillis() < until && icon != null;
    }

    static synchronized void clear(Context ctx) {
        Context app = ctx.getApplicationContext();
        boolean was = coin != null;
        coin = null;
        icon = null;
        until = 0;
        new File(app.getFilesDir(), "rip-state.png").delete();
        app.getSharedPreferences("rx_watch_rip", Context.MODE_PRIVATE).edit().clear().apply();
        if (was) Log.i(TAG, "the face's Rip alarm icon is cleared");
        update(app);
    }

    private static void update(Context app) {
        try {
            ComplicationDataSourceUpdateRequester.Companion.create(app, new ComponentName(app, RipComplication.class)).requestUpdateAll();
        } catch (Exception e) {
            RipDiag.error(app, "complication", e);
        }
    }

    private static PendingIntent expiry(Context app) {
        return PendingIntent.getBroadcast(app, 61, new Intent(app, Expire.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void save(Context app) {
        try (FileOutputStream out = new FileOutputStream(new File(app.getFilesDir(), "rip-state.png"))) {
            icon.compress(Bitmap.CompressFormat.PNG, 100, out);
        } catch (Exception ignored) {
            // memory only
        }
        app.getSharedPreferences("rx_watch_rip", Context.MODE_PRIVATE).edit()
            .putString("coin", coin).putFloat("pct", (float) pct).putBoolean("test", test).putLong("until", until).apply();
    }

    private static void load(Context app) {
        android.content.SharedPreferences p = app.getSharedPreferences("rx_watch_rip", Context.MODE_PRIVATE);
        String c = p.getString("coin", null);
        long u = p.getLong("until", 0);
        if (c == null || System.currentTimeMillis() >= u) return;
        Bitmap b = BitmapFactory.decodeFile(new File(app.getFilesDir(), "rip-state.png").getPath());
        if (b == null) return;
        coin = c;
        pct = p.getFloat("pct", Float.NaN);
        test = p.getBoolean("test", false);
        until = u;
        icon = b;
    }

    /** The logo, cut to a circle at 96 px. */
    private static Bitmap round(Bitmap src) {
        int s = 96;
        Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        c.drawCircle(s / 2f, s / 2f, s / 2f, p);
        p.setXfermode(new android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN));
        c.drawBitmap(Bitmap.createScaledBitmap(src, s, s, true), 0, 0, p);
        return out;
    }

    /** No logo: the ticker in a green (#00ffc8) circle. */
    static Bitmap tickerIcon(String coin) {
        int s = 96;
        Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(SparkCard.UP);
        c.drawCircle(s / 2f, s / 2f, s / 2f, p);
        p.setColor(0xFF000000);
        p.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        p.setTextAlign(Paint.Align.CENTER);
        String t = coin == null ? "?" : coin;
        p.setTextSize(SparkCard.fit(p, t, 40, s * 0.78f));
        Paint.FontMetrics fm = p.getFontMetrics();
        c.drawText(t, s / 2f, s / 2f - (fm.ascent + fm.descent) / 2, p);
        return out;
    }

    /** 60 minutes are up. */
    public static class Expire extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            synchronized (RipState.class) {
                if (coin != null && System.currentTimeMillis() < until - 5000) return;   // a newer alarm since
            }
            clear(ctx);
        }
    }
}
