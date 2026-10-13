package com.bryan.revolutx.wear;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.view.animation.Interpolator;
import android.view.animation.PathInterpolator;
import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.util.Locale;

/**
 * Desk #59 (Bryan 13 Oct 23:20 / 23:21): the app's total card - the total with smaller cents, the live 6-hour line (#507) and
 * its change, "LIVE" on the right. One routine draws it for both the watch face (CardComplication's image) and the watch app's
 * screen (SparkCardView), so the two look the same. The line copies the dashboard's rxSparkDraw: the points resampled to 90
 * evenly spaced values, straight segments with round joins, 2 px, a fill fading from 28% to nothing, #00ffc8 when the 6 h
 * change is >= 0 and #ff4d6a when it is down; the pulsing dot is the app's ring (rxSparkPulse: 0.4 -> 1.6, 0.7 -> 0, 2 s).
 *
 * Sizes are in card units, which are the face's units: the face shows the card at 360 x 156 and puts its own pulsing dot on the
 * line's last point from PLOT_TOP / PLOT_H / PAD, so keep those in step with the watchface module's res/raw/watchface.xml.
 */
final class SparkCard {

    static final float W = 360f;
    static final float H = 156f;
    static final float PLOT_TOP = 62f;   // the line's box: 56 high like the app's, 5 padding inside
    static final float PLOT_H = 56f;
    static final float PAD = 5f;
    static final int N = 90;             // the app's RX_SPARK.n

    static final int UP = 0xFF00FFC8;     // the dashboard's --accent
    static final int DOWN = 0xFFFF4D6A;   // --danger
    static final int MUTED = 0xFF888888;  // --text-muted

    static final long PULSE_MS = 2000;
    static final long SLIDE_MS = 900;     // the app's "transition: d .9s ease"
    private static final Interpolator EASE_OUT = new PathInterpolator(0f, 0f, 0.58f, 1f);
    static final Interpolator EASE = new PathInterpolator(0.25f, 0.1f, 0.25f, 1f);

    /** What the card shows; built once per answer. */
    static final class Model {
        String dollars = "--";
        String cents = "";
        @Nullable float[] ys;    // N heights, 0 = top of the line's inner box, 1 = bottom; null = no line
        boolean up = true;
        String range = "";       // "6 hours", or "Today" when there is no series
        String change = "";
        int color = UP;
        String right = "LIVE";   // or the last answer's time, HH:MM, when the numbers are old
        @Nullable String message;   // instead of the caption when there are no numbers

        /** The line's last point, 0..1 from the top, for the face's dot; -1 without a line. */
        float lastY() {
            return ys == null ? -1f : ys[N - 1];
        }

        String describe() {
            if (message != null) return "Revolut X: " + message;
            return "Portfolio " + dollars + cents + (change.isEmpty() ? "" : ", " + range + " " + change);
        }
    }

    private SparkCard() {}

    /** The card for this answer; s is null before the first one. */
    static Model model(Context ctx, @Nullable Snapshot s) {
        Model m = new Model();
        if (s == null || s.total == null) {
            m.message = Fmt.emptyLine(ctx);
            m.right = "";
            return m;
        }
        String total = Fmt.money(s.total);
        int dot = total.lastIndexOf('.');
        m.dollars = dot > 0 ? total.substring(0, dot) : total;
        m.cents = dot > 0 ? total.substring(dot) : "";
        Double chg;
        Double pct;
        if (s.spark != null && s.spark.length >= 2) {
            m.ys = heights(resample(s.spark));
            m.range = "6 hours";
            chg = s.sparkChgUsd;
            pct = s.sparkChgPct;
        } else {
            m.range = "Today";   // no series: today's P&L, no line
            chg = s.pnlUsd;
            pct = s.pnlPct;
        }
        m.up = !(chg != null && chg < 0);   // the app: up = !(d.change < 0)
        m.color = m.up ? UP : DOWN;
        if (chg != null) {
            String sign = m.up ? "+" : "−";
            m.change = sign + Fmt.money(Math.abs(chg))
                + (pct == null ? "" : " (" + sign + String.format(Locale.US, "%.2f", Math.abs(pct)) + "%)");
        }
        m.right = right(ctx);
        return m;
    }

    /** "LIVE" while the last answer is good and under 15 minutes old; otherwise its time, so old numbers never look live. */
    private static String right(Context ctx) {
        long at = WatchStore.values(ctx).getLong(WatchStore.V_FETCHED, 0);
        if (at <= 0) return "";
        boolean fresh = WatchStore.status(ctx).isEmpty() && System.currentTimeMillis() - at < 15 * 60_000L;
        return fresh ? "LIVE" : Fmt.hhmm(at);
    }

    /** N evenly spaced values (straight line between the server's points, which are evenly spaced in time). */
    static double[] resample(double[] pts) {
        double[] out = new double[N];
        int n = pts.length;
        for (int i = 0; i < N; i++) {
            double t = (double) (n - 1) * i / (N - 1);
            int j = Math.min(n - 2, (int) Math.floor(t));
            double f = t - j;
            out[i] = pts[j] + (pts[j + 1] - pts[j]) * f;
        }
        return out;
    }

    /** 0 = the highest value, 1 = the lowest; a flat line sits at the bottom like the app's. */
    static float[] heights(double[] v) {
        double lo = Double.MAX_VALUE;
        double hi = -Double.MAX_VALUE;
        for (double d : v) {
            lo = Math.min(lo, d);
            hi = Math.max(hi, d);
        }
        double span = hi - lo;
        if (span == 0) span = Math.max(1, Math.abs(hi) * 0.001);
        float[] ys = new float[v.length];
        for (int i = 0; i < v.length; i++) ys[i] = (float) (1 - (v[i] - lo) / span);
        return ys;
    }

    /**
     * Draws the card at sc pixels per card unit. ys: the line to draw (the app's view passes the one it is sliding between
     * two answers), or null for m's own. pulse: the dot's phase 0..1, or < 0 for no dot (the face draws its own).
     */
    static void draw(Canvas c, float sc, Model m, @Nullable float[] ys, float pulse) {
        if (ys == null) ys = m.ys;
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        // the total, the cents smaller, centred
        p.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        p.setColor(Fmt.WHITE);
        p.setTextSize(40 * sc);
        float wd = p.measureText(m.dollars);
        Paint pc = new Paint(p);
        pc.setTextSize(24 * sc);
        float wc = m.cents.isEmpty() ? 0 : pc.measureText(m.cents);
        float x0 = (W * sc - wd - wc) / 2;
        c.drawText(m.dollars, x0, 44 * sc, p);
        if (wc > 0) c.drawText(m.cents, x0 + wd, 44 * sc, pc);

        // the line and its fill
        if (ys != null) drawLine(c, 0, PLOT_TOP * sc, W * sc, PLOT_H * sc, PAD * sc, sc, ys, m.color, pulse);

        // the caption: "6 hours  -$133.89 (-2.68%)" ... "LIVE"
        float base = 146 * sc;
        Paint small = new Paint(Paint.ANTI_ALIAS_FLAG);
        small.setTextSize(15 * sc);
        small.setColor(MUTED);
        if (m.message != null) {
            small.setTextAlign(Paint.Align.CENTER);
            c.drawText(m.message, W * sc / 2, base, small);
            return;
        }
        c.drawText(m.range, 0, base, small);
        if (!m.change.isEmpty()) {
            Paint chg = new Paint(small);
            chg.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
            chg.setColor(m.color);
            c.drawText(m.change, small.measureText(m.range) + 10 * sc, base, chg);
        }
        if (!m.right.isEmpty()) {
            Paint live = new Paint(small);
            live.setTextSize(12 * sc);
            live.setLetterSpacing(0.08f);
            live.setTextAlign(Paint.Align.RIGHT);
            c.drawText(m.right, W * sc, base, live);
        }
    }

    /**
     * The line, its fill and (pulse >= 0) the dot with its ring, in the box left/top/w/h (pixels) with pad inside above and
     * below; sc = pixels per unit for the 2 px line and the dot. The card, the Tiles and the coin screen all draw with this.
     */
    static void drawLine(Canvas c, float left, float boxTop, float w, float h, float pad, float sc, float[] ys, int color, float pulse) {
        float top = boxTop + pad;
        float ih = h - 2 * pad;
        float bottom = boxTop + h;
        Path line = new Path();
        float minY = bottom;
        for (int i = 0; i < ys.length; i++) {
            float x = left + w * i / (ys.length - 1);
            float y = top + ih * ys[i];
            minY = Math.min(minY, y);
            if (i == 0) line.moveTo(x, y);
            else line.lineTo(x, y);
        }
        Path area = new Path(line);
        area.lineTo(left + w, bottom);
        area.lineTo(left, bottom);
        area.close();
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setStyle(Paint.Style.FILL);
        fill.setShader(new LinearGradient(0, minY, 0, bottom, withAlpha(color, 0.28f), withAlpha(color, 0f), Shader.TileMode.CLAMP));
        c.drawPath(area, fill);
        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(2 * sc);
        stroke.setStrokeJoin(Paint.Join.ROUND);
        stroke.setStrokeCap(Paint.Cap.ROUND);
        stroke.setColor(color);
        c.drawPath(line, stroke);
        if (pulse < 0) return;
        float cx = left + w;
        float cy = top + ih * ys[ys.length - 1];
        float e = EASE_OUT.getInterpolation(pulse);
        float scale = 0.4f + 1.2f * e;
        Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        ring.setStyle(Paint.Style.STROKE);
        ring.setColor(withAlpha(color, 0.7f * (1 - e)));
        ring.setStrokeWidth(2 * scale * sc);
        c.drawCircle(cx, cy, 8 * scale * sc, ring);   // the app's ring: 18 px across, a 2 px line
        Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG);
        dot.setColor(color);
        c.drawCircle(cx, cy, 4 * sc, dot);
    }

    /** The phase a still picture (a Tile) shows the ring at: part-way out, so it reads as the live dot. */
    static final float STILL_PULSE = 0.3f;

    /**
     * A Tile's line: values (oldest first) resampled like the card, drawn w x h pixels with room for the dot and its ring at
     * the right end; null when there are fewer than 2 values.
     */
    static byte[] linePng(@Nullable double[] values, int color, int w, int h, float sc) {
        if (values == null || values.length < 2) return null;
        float[] ys = heights(resample(values));
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        float room = 12 * sc;   // the ring at STILL_PULSE reaches about 9 units past the last point
        drawLine(new Canvas(b), 0, 0, w - room, h, room * 0.75f, sc, ys, color, STILL_PULSE);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.PNG, 100, out);
        b.recycle();
        return out.toByteArray();
    }

    /**
     * The coin screen's card, in the card's own layout: the price with its cents smaller, the coin's 24 h line, "24 hours
     * +8.10%" in its colour (green/red by the 24 h move), and LIVE.
     */
    static Model coinModel(Context ctx, Snapshot.Quote q) {
        Model m = new Model();
        String price = Double.isNaN(q.price) ? "--" : Fmt.price(q.price);
        int dot = price.lastIndexOf('.');
        m.dollars = dot > 0 ? price.substring(0, dot) : price;
        m.cents = dot > 0 ? price.substring(dot) : "";
        if (q.spark != null && q.spark.length >= 2) m.ys = heights(resample(q.spark));
        m.up = up(q);
        m.color = m.up ? UP : DOWN;
        m.range = "24 hours";
        m.change = Double.isNaN(q.pct) ? "" : (m.up ? "+" : "\u2212") + String.format(Locale.US, "%.2f", Math.abs(q.pct)) + "%";
        m.right = right(ctx);
        return m;
    }

    /** A coin is green when its 24 h move is >= 0; without a %, by its line (last >= first); else green. */
    static boolean up(Snapshot.Quote q) {
        if (!Double.isNaN(q.pct)) return q.pct >= 0;
        if (q.spark != null && q.spark.length >= 2) return q.spark[q.spark.length - 1] >= q.spark[0];
        return true;
    }

    /** The face's image: the card without a dot (the face pulses its own on top), as a PNG. */
    static byte[] png(Model m, float sc) {
        Bitmap b = Bitmap.createBitmap(Math.round(W * sc), Math.round(H * sc), Bitmap.Config.ARGB_8888);
        draw(new Canvas(b), sc, m, null, -1f);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.PNG, 100, out);
        b.recycle();
        return out.toByteArray();
    }

    static int withAlpha(int color, float a) {
        return (Math.round(Math.max(0f, Math.min(1f, a)) * 255) << 24) | (color & 0xFFFFFF);
    }
}
