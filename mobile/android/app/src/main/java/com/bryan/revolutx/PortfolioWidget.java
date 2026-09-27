package com.bryan.revolutx;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.widget.RemoteViews;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * The home-screen widget: the whole book now and its change over 24 h, read-only.
 * WidgetRefreshWorker fetches; this class only draws what it saved. A tap opens the app on Portfolio.
 */
public class PortfolioWidget extends AppWidgetProvider {

    // saved by WidgetRefreshWorker (in SecureStore)
    static final String W_TOTAL = "w_total";
    static final String W_THEN = "w_then";
    static final String W_TS = "w_ts";
    static final String W_PARTIAL = "w_partial";
    static final String W_STATUS = "w_status";   // "", "offline", "nokey", "badkey", "http:NNN"

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        render(ctx);
        WidgetRefreshWorker.schedule(ctx);
        WidgetRefreshWorker.refreshNow(ctx);
    }

    @Override
    public void onEnabled(Context ctx) {
        WidgetRefreshWorker.schedule(ctx);
    }

    @Override
    public void onDisabled(Context ctx) {
        WidgetRefreshWorker.cancel(ctx);
    }

    static void render(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PortfolioWidget.class));
        if (ids == null || ids.length == 0) return;
        mgr.updateAppWidget(ids, views(ctx));
    }

    private static RemoteViews views(Context ctx) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_portfolio);

        Intent open = new Intent(ctx, MainActivity.class)
            .putExtra(MainActivity.EXTRA_TAB, "portfolio")
            .putExtra(MainActivity.EXTRA_FROM_WIDGET, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        v.setOnClickPendingIntent(
            R.id.widget_root,
            PendingIntent.getActivity(ctx, 42, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
        );

        SharedPreferences p;
        try {
            p = SecureStore.get(ctx);
        } catch (Exception e) {
            message(v, "Open the app to set up");
            return v;
        }
        String status = p.getString(W_STATUS, "");
        boolean hasValue = p.contains(W_TOTAL);

        if (SecureStore.key(ctx) == null || "nokey".equals(status)) {
            message(v, "Open the app to set up");
            return v;
        }
        if ("badkey".equals(status)) {
            message(v, "Key not accepted - open the app");
            return v;
        }
        if (!hasValue) {
            message(v, status.isEmpty() ? "Loading…" : "offline".equals(status) ? "Offline - tap to open" : "Server busy - tap to open");
            return v;
        }

        double total = Double.longBitsToDouble(p.getLong(W_TOTAL, 0));
        v.setViewVisibility(R.id.widget_msg, View.GONE);
        v.setViewVisibility(R.id.widget_total, View.VISIBLE);
        v.setViewVisibility(R.id.widget_change, View.VISIBLE);
        v.setTextViewText(R.id.widget_total, usd(total));

        if (p.contains(W_THEN)) {
            double then = Double.longBitsToDouble(p.getLong(W_THEN, 0));
            double ch = total - then;
            String pct = then != 0 ? String.format(Locale.US, " (%s%.1f%%)", ch >= 0 ? "+" : "-", Math.abs(ch / then * 100)) : "";
            v.setTextViewText(R.id.widget_change, (ch >= 0 ? "▲ " : "▼ ") + usd(Math.abs(ch)) + pct);
            v.setTextColor(R.id.widget_change, ch >= 0 ? 0xFF00C98F : 0xFFFF4D6A);
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
        return v;
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
