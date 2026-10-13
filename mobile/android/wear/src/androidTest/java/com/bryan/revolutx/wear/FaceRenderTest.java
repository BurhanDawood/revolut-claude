package com.bryan.revolutx.wear;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Desk #59, CI only (the emulator job in android.yml; never in a release APK). Draws the card as the face gets it (no dot) and
 * as the app shows it (with the dot), up, down and without a series, into files/ci/ for the job to print. Then saves a sample
 * answer as the last good one (with three coins) and two Tile coins, so the face and the Tiles on the emulator show numbers
 * (Coin 3 stays empty: "Tap to choose a coin"). No key is involved: the emulator has none, and the complications and Tiles
 * fall back to the saved answer.
 */
@RunWith(AndroidJUnit4.class)
public class FaceRenderTest {

    @Test
    public void renderCardsAndSeed() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File dir = new File(ctx.getFilesDir(), "ci");
        assertTrue(dir.isDirectory() || dir.mkdirs());
        float sc = Math.max(1f, ctx.getResources().getDisplayMetrics().widthPixels / 450f);

        Snapshot up = sample(true, true);
        Snapshot down = sample(false, true);
        Snapshot today = sample(false, false);
        write(new File(dir, "card-face-up.png"), SparkCard.png(SparkCard.model(ctx, up), sc));
        write(new File(dir, "card-face-down.png"), SparkCard.png(SparkCard.model(ctx, down), sc));
        write(new File(dir, "card-face-nospark.png"), SparkCard.png(SparkCard.model(ctx, today), sc));
        write(new File(dir, "card-face-nokey.png"), SparkCard.png(SparkCard.model(ctx, null), sc));
        write(new File(dir, "card-app-down.png"), withDot(SparkCard.model(ctx, down), sc, 0.35f));

        down.movers.add(new Snapshot.Coin("SOL", 8.1, 182.4));
        down.movers.add(new Snapshot.Coin("PEPE", -11.4, 0.00000912));
        down.movers.add(new Snapshot.Coin("NEAR", -6.3, 2.874));
        down.holdings.add(new Snapshot.Coin("BTC", -1.2, 2410.55));
        down.holdings.add(new Snapshot.Coin("SOL", 8.1, 912.0));
        down.holdings.add(new Snapshot.Coin("NEAR", -6.3, 301.22));
        down.quotes.add(quote("SOL", 182.4, 8.1, 912.0, true));
        down.quotes.add(quote("NEAR", 2.874, -6.3, 301.22, false));
        TileCoins.set(ctx, 1, "SOL");
        TileCoins.set(ctx, 2, "NEAR");
        TileCoins.set(ctx, 3, null);
        write(new File(dir, "tile-line-sol.png"), SparkCard.linePng(down.quotes.get(0).spark, SparkCard.UP, 300, 80, 2f));
        assertTrue(WatchStore.values(ctx).edit()
            .putString(WatchStore.V_SNAPSHOT, down.toJson())
            .putLong(WatchStore.V_FETCHED, System.currentTimeMillis())
            .putString(WatchStore.V_STATUS, "")
            .commit());
    }

    /** About Bryan's 23:20 screenshot: $4,863.98, 6 hours -$133.89 (-2.68%). */
    private static Snapshot sample(boolean rising, boolean withSpark) {
        Snapshot s = new Snapshot();
        s.total = rising ? 4997.87 : 4863.98;
        s.pnlUsd = rising ? 57.30 : -91.12;
        s.pnlPct = rising ? 1.16 : -1.84;
        s.unread = 3;
        if (withSpark) {
            s.spark = new double[61];
            for (int i = 0; i < 61; i++) {
                double t = i / 60.0;
                double drift = rising ? 133.89 * t : -133.89 * t;
                s.spark[i] = 4997.87 + (rising ? -133.89 : 0) + drift + 18 * Math.sin(i / 4.5) + 9 * Math.sin(i / 1.7);
            }
            s.spark[60] = s.total;
            s.sparkChgUsd = s.spark[60] - s.spark[0];
            s.sparkChgPct = s.sparkChgUsd / s.spark[0] * 100;
        }
        return s;
    }

    private static Snapshot.Quote quote(String coin, double price, double pct, double held, boolean rising) {
        Snapshot.Quote q = new Snapshot.Quote(coin);
        q.price = price;
        q.pct = pct;
        q.held = held;
        q.spark = new double[49];
        for (int i = 0; i < 49; i++) {
            double t = i / 48.0;
            q.spark[i] = price * (1 - pct / 100 * (1 - t)) + price * 0.012 * Math.sin(i / 3.0);
        }
        q.spark[48] = price;
        return q;
    }

    private static byte[] withDot(SparkCard.Model m, float sc, float pulse) {
        Bitmap b = Bitmap.createBitmap(Math.round(SparkCard.W * sc) + 20, Math.round(SparkCard.H * sc), Bitmap.Config.ARGB_8888);
        SparkCard.draw(new Canvas(b), sc, m, null, pulse);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.PNG, 100, out);
        return out.toByteArray();
    }

    private static void write(File f, byte[] png) throws Exception {
        try (FileOutputStream o = new FileOutputStream(f)) {
            o.write(png);
        }
    }
}
