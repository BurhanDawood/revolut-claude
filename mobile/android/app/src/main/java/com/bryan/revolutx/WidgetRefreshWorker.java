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
 * Reads GET {base}/api/portfolio/state with the dashboard key (a read; the widget never writes)
 * and saves what the widget shows. Every 30 min with a network, when the shell saves a key, and on a tap.
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
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(SecureStore.base(ctx) + "/api/portfolio/state").openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestProperty("x-api-token", key);
            c.setRequestProperty("Accept", "application/json");
            c.setUseCaches(false);
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
                }
            }
        } catch (IOException io) {
            e.putString(PortfolioWidget.W_STATUS, "offline");   // last values stay
        } catch (Exception other) {
            e.putString(PortfolioWidget.W_STATUS, "http:?");
        } finally {
            if (c != null) c.disconnect();
        }
        e.apply();
        PortfolioWidget.render(ctx);
        return Result.success();
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
