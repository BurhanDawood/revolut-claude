package com.bryan.revolutx;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * Reads GET {base}/api/portfolio/state and GET {base}/api/portfolio/spark with the dashboard key (reads; the
 * widget never writes) and saves what the widget shows. Every 30 min with a network, when the shell saves a key, and on a tap.
 */
public class WidgetRefreshWorker extends Worker {

    private static final String PERIODIC = "rx_widget_periodic";
    private static final String NOW = "rx_widget_now";

    public WidgetRefreshWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    static void schedule(Context ctx) {
        PeriodicWorkRequest r = new PeriodicWorkRequest.Builder(WidgetRefreshWorker.class, 30, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, r);
    }

    static void refreshNow(Context ctx) {
        // no network constraint: offline must still be shown as "offline" straight away
        WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, new OneTimeWorkRequest.Builder(WidgetRefreshWorker.class).build());
    }

    static void cancel(Context ctx) {
        WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences p;
        try {
            p = SecureStore.get(ctx);
        } catch (Exception e) {
            return Result.success();
        }
        String key = SecureStore.key(ctx);
        if (key == null) {
            p.edit().putString(PortfolioWidget.W_STATUS, "nokey").apply();
            PortfolioWidget.render(ctx);
            return Result.success();
        }
        SharedPreferences.Editor e = p.edit();
        String base = SecureStore.base(ctx);
        boolean stateOk = false;
        HttpURLConnection c = null;
        try {
            c = open(base + "/api/portfolio/state", key);
            int code = c.getResponseCode();
            if (code == 401 || code == 403) {
                e.putString(PortfolioWidget.W_STATUS, "badkey");
            } else if (code != 200) {
                e.putString(PortfolioWidget.W_STATUS, "http:" + code);   // last values stay
            } else {
                JSONObject s = new JSONObject(read(c.getInputStream()));
                JSONObject latest = s.optJSONObject("latest");
                if (latest == null || latest.isNull("total")) {
                    e.putString(PortfolioWidget.W_STATUS, "http:" + code);
                } else {
                    e.putLong(PortfolioWidget.W_TOTAL, Double.doubleToRawLongBits(latest.getDouble("total")));
                    e.putLong(PortfolioWidget.W_TS, latest.optLong("ts", System.currentTimeMillis() / 1000));
                    e.putBoolean(PortfolioWidget.W_PARTIAL, latest.optBoolean("partial", false));
                    JSONObject day = s.optJSONObject("day");
                    if (day != null && !day.isNull("total_then") && day.optDouble("total_then", 0) != 0) {
                        e.putLong(PortfolioWidget.W_THEN, Double.doubleToRawLongBits(day.getDouble("total_then")));
                    } else {
                        e.remove(PortfolioWidget.W_THEN);
                    }
                    e.putString(PortfolioWidget.W_STATUS, "");
                    stateOk = true;
                }
            }
        } catch (IOException io) {
            e.putString(PortfolioWidget.W_STATUS, "offline");   // last values stay
        } catch (Exception other) {
            e.putString(PortfolioWidget.W_STATUS, "http:?");
        } finally {
            if (c != null) c.disconnect();
        }
        // the chart: one spark per range the placed widgets show. Offline or a server error keeps the last points.
        if (stateOk) {
            for (String range : PortfolioWidget.rangesInUse(ctx)) {
                HttpURLConnection sc = null;
                try {
                    sc = open(base + "/api/portfolio/spark?range=" + range, key);
                    int code = sc.getResponseCode();
                    if (code == 404) {   // an older server without the route: text only
                        e.putBoolean(PortfolioWidget.W_SPARK_NA, true);
                        break;
                    }
                    if (code == 200) {
                        JSONObject sp = new JSONObject(read(sc.getInputStream()));
                        e.putBoolean(PortfolioWidget.W_SPARK_NA, false);
                        e.putString(PortfolioWidget.W_SPARK + range, sp.toString());
                    }
                } catch (Exception ignored) {
                    // keep the last points
                } finally {
                    if (sc != null) sc.disconnect();
                }
            }
        }
        e.apply();
        PortfolioWidget.render(ctx);
        return Result.success();
    }

    private static HttpURLConnection open(String url, String key) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setRequestProperty("x-api-token", key);
        c.setRequestProperty("Accept", "application/json");
        c.setUseCaches(false);
        return c;
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = s.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
