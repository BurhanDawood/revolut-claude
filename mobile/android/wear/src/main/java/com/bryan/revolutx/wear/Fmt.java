package com.bryan.revolutx.wear;

import android.content.Context;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Number and status text shared by the app, the Tile and the complications. */
final class Fmt {

    static final int WHITE = 0xFFFFFFFF;
    static final int GREY = 0xFF9A9A9A;
    static final int GREEN = 0xFF00C896;   // the widget's colours
    static final int RED = 0xFFFF4D6A;
    static final int ACCENT = 0xFF00FFC8;

    private Fmt() {}

    /** $4,826.69 */
    static String money(double v) {
        return (v < 0 ? "-$" : "$") + String.format(Locale.US, "%,.2f", Math.abs(v));
    }

    /** Short, for a complication: $4,827 / $48.3k / $1.23M */
    static String moneyShort(double v) {
        double a = Math.abs(v);
        String s;
        if (a >= 1e6) s = String.format(Locale.US, "%.2fM", a / 1e6);
        else if (a >= 1e5) s = String.format(Locale.US, "%.0fk", a / 1e3);
        else if (a >= 1e4) s = String.format(Locale.US, "%.1fk", a / 1e3);
        else s = String.format(Locale.US, "%,.0f", a);
        return (v < 0 ? "-$" : "$") + s;
    }

    /** +$57.30 / -$12.10 */
    static String signedMoney(double v) {
        return (v >= 0 ? "+" : "") + money(v);
    }

    static String signedMoneyShort(double v) {
        return (v >= 0 ? "+" : "") + moneyShort(v);
    }

    /** +1.2% / -0.4%; whole numbers from 10% */
    static String pct(double p) {
        if (Double.isNaN(p)) return "";
        String s = Math.abs(p) >= 10 ? String.format(Locale.US, "%.0f", p) : String.format(Locale.US, "%.1f", p);
        return (p >= 0 ? "+" : "") + s + "%";
    }

    /** A price: 6 significant figures at most, no exponent. */
    static String price(double v) {
        if (Double.isNaN(v)) return "";
        if (v >= 1000) return String.format(Locale.US, "$%,.0f", v);
        if (v >= 1) return String.format(Locale.US, "$%.2f", v);
        return "$" + new java.math.BigDecimal(v).round(new java.math.MathContext(4)).stripTrailingZeros().toPlainString();
    }

    static int signColor(Double v) {
        if (v == null) return WHITE;
        return v >= 0 ? GREEN : RED;
    }

    static int signColor(double v) {
        if (Double.isNaN(v)) return WHITE;
        return v >= 0 ? GREEN : RED;
    }

    static String hhmm(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ms));
    }

    /** "updated HH:MM", plus why the numbers may be old. */
    static String updatedLine(Context ctx, Snapshot s) {
        String status = WatchStore.status(ctx);
        long ms = s != null && s.updatedMs > 0 ? s.updatedMs : WatchStore.values(ctx).getLong(WatchStore.V_FETCHED, 0);
        String line = ms > 0 ? "updated " + hhmm(ms) : "";
        String why = "";
        if ("offline".equals(status)) why = "offline";
        else if ("badkey".equals(status)) why = "key not accepted";
        else if (status.startsWith("http:")) why = "server busy";
        if (s != null && s.partial) why = why.isEmpty() ? "partial" : why + " · partial";
        if (line.isEmpty()) return why;
        return why.isEmpty() ? line : line + " · " + why;
    }

    /** The one line shown instead of numbers when there are none. */
    static String emptyLine(Context ctx) {
        String status = WatchStore.status(ctx);
        if ("nokey".equals(status)) return "Open Revolut X on your phone to connect";
        if ("badkey".equals(status)) return "Key not accepted - open the phone app";
        if ("offline".equals(status)) return "No connection";
        return "Loading…";
    }
}
