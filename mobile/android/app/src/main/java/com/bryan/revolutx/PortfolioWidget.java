package com.bryan.revolutx;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.view.View;
import android.widget.RemoteViews;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import org.json.JSONObject;

/**
 * The home-screen widget: the whole book now, its change, and (at 4x2 and taller) a line chart of the
 * chosen range with a 1D / 1W / 1M chip. Read-only. WidgetRefreshWorker fetches; this class only draws what
 * it saved. A tap on the chip cycles the range; a tap anywhere else opens the app on Portfolio.
 */
public class PortfolioWidget extends AppWidgetProvider {

    // saved by WidgetRefreshWorker (in SecureStore)
    static final String W_TOTAL = "w_total";
    static final String W_THEN = "w_then";
    static final String W_TS = "w_ts";
    static final String W_PARTIAL = "w_partial";
    static final String W_STATUS = "w_status";   // "", "offline", "nokey", "badkey", "http:NNN"
    static final String W_SPARK = "w_spark_";    // + range: the last /api/portfolio/spark answer (JSON)
    static final String W_SPARK_NA = "w_spark_na";   // the server has no spark route (404): text only
    static final String W_RANGE = "w_range_";    // + appWidgetId: "1d" | "1w" | "1m"

    static final String[] RANGES = { "1d", "1w", "1m" };
    static final String ACTION_CYCLE = "com.bryan.revolutx.WIDGET_CYCLE_RANGE";

    /** Below this height (dp) the widget is the 4x1 text-only layout. */
    private static final int CHART_MIN_HEIGHT_DP = 100;
    /** What the header and chip take above/around the chart, in dp (layout padding + header rows). */
    private static final int HEADER_DP = 66, SIDE_PAD_DP = 28;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        render(ctx);
        WidgetRefreshWorker.schedule(ctx);
        WidgetRefreshWorker.refreshNow(ctx);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        renderOne(ctx, mgr, id);   // resized: switch layout / redraw the chart at the new size
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (ACTION_CYCLE.equals(intent.getAction())) {
            int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return;
            String next = nextRange(rangeOf(ctx, id));
            try {
                SecureStore.get(ctx).edit().putString(W_RANGE + id, next).apply();
            } catch (Exception ignored) {
                return;
            }
            renderOne(ctx, AppWidgetManager.getInstance(ctx), id);   // cached data for that range at once, if any
            WidgetRefreshWorker.refreshNow(ctx);
            return;
        }
        super.onReceive(ctx, intent);
    }

    @Override
    public void onDeleted(Context ctx, int[] ids) {
        try {
            SharedPreferences.Editor e = SecureStore.get(ctx).edit();
            for (int id : ids) e.remove(W_RANGE + id);
            e.apply();
        } catch (Exception ignored) {}
    }

    @Override
    public void onEnabled(Context ctx) {
        WidgetRefreshWorker.schedule(ctx);
    }

    @Override
    public void onDisabled(Context ctx) {
        WidgetRefreshWorker.cancel(ctx);
    }

    // ── ranges ──

    static String rangeOf(Context ctx, int id) {
        try {
            String r = SecureStore.get(ctx).getString(W_RANGE + id, "1d");
            for (String x : RANGES) if (x.equals(r)) return r;
        } catch (Exception ignored) {}
        return "1d";
    }

    private static String nextRange(String r) {
        for (int i = 0; i < RANGES.length; i++) if (RANGES[i].equals(r)) return RANGES[(i + 1) % RANGES.length];
        return "1d";
    }

    /** The ranges the placed widgets show (the worker fetches a spark for each). */
    static Set<String> rangesInUse(Context ctx) {
        Set<String> out = new LinkedHashSet<>();
        for (int id : ids(ctx)) out.add(rangeOf(ctx, id));
        if (out.isEmpty()) out.add("1d");
        return out;
    }

    private static int[] ids(Context ctx) {
        int[] ids = AppWidgetManager.getInstance(ctx).getAppWidgetIds(new ComponentName(ctx, PortfolioWidget.class));
        return ids != null ? ids : new int[0];
    }

    // ── drawing ──

    static void render(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        for (int id : ids(ctx)) renderOne(ctx, mgr, id);
    }

    private static void renderOne(Context ctx, AppWidgetManager mgr, int id) {
        try {
            mgr.updateAppWidget(id, views(ctx, mgr, id));
        } catch (Exception ignored) {
            // e.g. the widget was removed meanwhile
        }
    }

    private static RemoteViews views(Context ctx, AppWidgetManager mgr, int id) {
        Bundle o = mgr.getAppWidgetOptions(id);
        // portrait convention: the widget is MIN_WIDTH wide and MAX_HEIGHT tall
        int wDp = o != null ? o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) : 0;
        int hDp = o != null ? o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0) : 0;
        if (wDp <= 0) wDp = 250;
        if (hDp <= 0) hDp = 110;

        SharedPreferences p;
        try {
            p = SecureStore.get(ctx);
        } catch (Exception e) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_portfolio);
            openOnTap(ctx, v);
            message(v, "Open the app to set up");
            return v;
        }
        String range = rangeOf(ctx, id);
        JSONObject spark = null;
        if (!p.getBoolean(W_SPARK_NA, false)) {
            try {
                String s = p.getString(W_SPARK + range, null);
                if (s != null) spark = new JSONObject(s);
            } catch (Exception ignored) {}
        }
        boolean chartLayout = hDp >= CHART_MIN_HEIGHT_DP && !p.getBoolean(W_SPARK_NA, false) && ready(ctx, p);

        RemoteViews v = new RemoteViews(ctx.getPackageName(), chartLayout ? R.layout.widget_portfolio_chart : R.layout.widget_portfolio);
        openOnTap(ctx, v);
        if (!header(ctx, p, v, chartLayout ? range : "1d", spark) || !chartLayout) return v;

        // the range chip: a broadcast back to this widget
        Intent cycle = new Intent(ctx, PortfolioWidget.class).setAction(ACTION_CYCLE).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        v.setOnClickPendingIntent(
            R.id.widget_range,
            PendingIntent.getBroadcast(ctx, id, cycle, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
        );
        v.setTextViewText(R.id.widget_range, chip(range));

        float density = ctx.getResources().getDisplayMetrics().density;
        Bitmap chart = spark != null
            ? SparkChart.draw(spark.optJSONArray("points"), Math.round((wDp - SIDE_PAD_DP) * density), Math.round((hDp - HEADER_DP) * density), density)
            : null;
        if (chart != null) {
            v.setImageViewBitmap(R.id.widget_chart, chart);
            v.setViewVisibility(R.id.widget_chart, View.VISIBLE);
        } else {
            v.setViewVisibility(R.id.widget_chart, View.INVISIBLE);   // not loaded yet / no points: the chip stays
        }
        return v;
    }

    /** A key is saved, it was accepted, and there is a value to show. */
    private static boolean ready(Context ctx, SharedPreferences p) {
        String st = p.getString(W_STATUS, "");
        return SecureStore.key(ctx) != null && !"nokey".equals(st) && !"badkey".equals(st) && p.contains(W_TOTAL);
    }

    private static void openOnTap(Context ctx, RemoteViews v) {
        Intent open = new Intent(ctx, MainActivity.class)
            .putExtra(MainActivity.EXTRA_TAB, "portfolio")
            .putExtra(MainActivity.EXTRA_FROM_WIDGET, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        v.setOnClickPendingIntent(
            R.id.widget_root,
            PendingIntent.getActivity(ctx, 42, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
        );
    }

    /**
     * "Revolut X", the total, the change and "updated HH:MM" (plus partial / offline). For 1D the change is
     * latest.total against day.total_then (/api/portfolio/state); for 1W and 1M it is the spark's change and pct.
     * Returns false when a message is shown instead of values.
     */
    private static boolean header(Context ctx, SharedPreferences p, RemoteViews v, String range, JSONObject spark) {
        String status = p.getString(W_STATUS, "");
        if (SecureStore.key(ctx) == null || "nokey".equals(status)) {
            message(v, "Open the app to set up");
            return false;
        }
        if ("badkey".equals(status)) {
            message(v, "Key not accepted - open the app");
            return false;
        }
        if (!p.contains(W_TOTAL)) {
            message(v, status.isEmpty() ? "Loading…" : "offline".equals(status) ? "Offline - tap to open" : "Server busy - tap to open");
            return false;
        }

        double total = Double.longBitsToDouble(p.getLong(W_TOTAL, 0));
        v.setViewVisibility(R.id.widget_msg, View.GONE);
        v.setViewVisibility(R.id.widget_total, View.VISIBLE);
        v.setViewVisibility(R.id.widget_change, View.VISIBLE);
        v.setTextViewText(R.id.widget_total, usd(total));

        Double ch = null, pct = null;
        if ("1d".equals(range)) {
            if (p.contains(W_THEN)) {
                double then = Double.longBitsToDouble(p.getLong(W_THEN, 0));
                ch = total - then;
                if (then != 0) pct = ch / then * 100;
            }
        } else if (spark != null && !spark.isNull("change")) {
            ch = spark.optDouble("change");
            if (!spark.isNull("pct")) pct = spark.optDouble("pct");
        }
        if (ch != null && !ch.isNaN()) {
            String pc = pct != null && !pct.isNaN() ? String.format(Locale.US, " (%s%.1f%%)", ch >= 0 ? "+" : "-", Math.abs(pct)) : "";
            v.setTextViewText(R.id.widget_change, (ch >= 0 ? "▲ " : "▼ ") + usd(Math.abs(ch)) + pc);
            v.setTextColor(R.id.widget_change, ch >= 0 ? SparkChart.UP : SparkChart.DOWN);
        } else {
            v.setTextViewText(R.id.widget_change, "–");
            v.setTextColor(R.id.widget_change, 0xFF8F8F8F);
        }

        StringBuilder foot = new StringBuilder();
        long ts = p.getLong(W_TS, 0);
        if (ts > 0) foot.append("updated ").append(new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ts * 1000)));
        if (p.getBoolean(W_PARTIAL, false)) foot.append(foot.length() > 0 ? " · " : "").append("partial");
        if ("offline".equals(status)) foot.append(foot.length() > 0 ? " · " : "").append("offline");
        else if (status.startsWith("http:")) foot.append(foot.length() > 0 ? " · " : "").append("server ").append(status.substring(5));
        v.setTextViewText(R.id.widget_updated, foot.toString());
        return true;
    }

    /** "1D 1W 1M" with the chosen one bright. */
    private static CharSequence chip(String range) {
        SpannableStringBuilder b = new SpannableStringBuilder();
        for (int i = 0; i < RANGES.length; i++) {
            if (i > 0) b.append("  ");
            int s = b.length();
            b.append(RANGES[i].toUpperCase(Locale.US));
            boolean on = RANGES[i].equals(range);
            b.setSpan(new ForegroundColorSpan(on ? 0xFF00FFC8 : 0xFF6A6A6A), s, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (on) b.setSpan(new StyleSpan(android.graphics.Typeface.BOLD), s, b.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        return b;
    }

    private static void message(RemoteViews v, String text) {
        v.setViewVisibility(R.id.widget_total, View.GONE);
        v.setViewVisibility(R.id.widget_change, View.GONE);
        v.setViewVisibility(R.id.widget_msg, View.VISIBLE);
        v.setTextViewText(R.id.widget_msg, text);
        v.setTextViewText(R.id.widget_updated, "");
    }

    static String usd(double x) {
        DecimalFormat f = new DecimalFormat("#,##0.00", DecimalFormatSymbols.getInstance(Locale.US));
        return (x < 0 ? "-$" : "$") + f.format(Math.abs(x));
    }
}
