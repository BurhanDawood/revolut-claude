package com.bryan.revolutx.wear;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Desk #59 (Bryan 15 Oct 14:56): what the watch app's first screen says about the Rip alarm, because the watch's log cannot be
 * read while it is on Bluetooth: "Last rip alarm: 14:56 TEST" (or "none received yet") and the last error, if any, from
 * posting its notification or updating the face's icon. Kept on the watch only.
 */
final class RipDiag {

    private static final String PREFS = "rx_watch_rip_diag";
    private static final String TAG = "RxRipRing";

    private RipDiag() {}

    static final long DUPLICATE_MS = 2 * 60_000L;

    /**
     * Bryan 15 Oct 16:22: the same coin's alarm again within 2 min of the last one (the phone's forward and a retry can both
     * arrive) is a duplicate: it is dropped, so only one sound ever plays. Atomic, so two copies at once cannot both pass.
     */
    static synchronized boolean duplicate(Context ctx, String coin) {
        SharedPreferences p = prefs(ctx);
        long at = p.getLong("at", 0);
        long now = System.currentTimeMillis();
        boolean dup = coin != null && coin.equals(p.getString("coin", null)) && now >= at && now - at < DUPLICATE_MS;
        if (!dup) received(ctx, coin);
        return dup;
    }

    /** An alarm arrived from the phone (before anything else is done with it). */
    static void received(Context ctx, String coin) {
        prefs(ctx).edit().putLong("at", System.currentTimeMillis()).putString("coin", coin).remove("err").remove("err_at").commit();
        String off = notificationsOff(ctx);
        if (off != null) error(ctx, null, off);
    }

    static void error(Context ctx, String where, Object e) {
        String m = e instanceof Throwable ? why((Throwable) e) : String.valueOf(e);
        String line = (where == null ? "" : where + ": ") + (m.length() > 120 ? m.substring(0, 120) : m);
        Log.w(TAG, "error " + line);
        prefs(ctx).edit().putString("err", line).putLong("err_at", System.currentTimeMillis()).commit();
    }

    /** The first screen's line(s). */
    static String line(Context ctx) {
        SharedPreferences p = prefs(ctx);
        long at = p.getLong("at", 0);
        String s = at == 0 ? "Last rip alarm: none received yet"
            : "Last rip alarm: " + new SimpleDateFormat("d MMM HH:mm", Locale.UK).format(new Date(at)) + " " + p.getString("coin", "?");
        String err = p.getString("err", null);
        if (err == null) err = notificationsOff(ctx);
        return err == null ? s : s + "\n\u26a0 " + err;
    }

    static boolean hasError(Context ctx) {
        return prefs(ctx).getString("err", null) != null || notificationsOff(ctx) != null;
    }

    /** Why the alarm's notification cannot show, or null. */
    static String notificationsOff(Context ctx) {
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm == null) return null;
            if (!nm.areNotificationsEnabled()) return "notifications off on the watch";
            NotificationChannel c = nm.getNotificationChannel(RipRing.CHANNEL);
            if (c != null && c.getImportance() == NotificationManager.IMPORTANCE_NONE) return "Rip alarm channel off on the watch";
        } catch (Exception ignored) {
            // unknown: not shown
        }
        return null;
    }

    static String why(Throwable e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m == null ? "" : ": " + m);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
