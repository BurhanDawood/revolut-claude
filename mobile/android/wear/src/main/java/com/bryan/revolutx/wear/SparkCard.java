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
 * Desk #59 (Bryan 14 Oct 00:06): the live 6-hour line as the hero. One routine draws it for the watch face (CardComplication's
 * image, AmbientCardComplication's outline), the top of the watch app (SparkCardView), the Tiles and the coin screen, so every
 * graph looks the same. The band is the face's middle, 450 x 250 face units from y 150: the total ("$4,863" + smaller ".98")
 * over the upper part, then the line - thick, smoothed, a fill fading from 28% to nothing, #00ffc8 when the 6 h change is
 * >= 0 and #ff4d6a when down (the dashboard's colours) - from the left edge to x 392, where its last point (and the dot) sits
 * inside the round screen at any height; then "6h -$133.89 (-2.68%)" in the line's colour. The pulsing dot is the app's ring
 * (scale 0.4 -> 1.6, opacity 0.7 -> 0, ease-out) on a 1.5 s cycle. Keep LINE_* in step with the watchface module's
 * res/raw/watchface.xml, which pulses its own dot there.
 */
final class SparkCard {

    static final float W = 450f;          // the whole face width: the line runs edge to edge
    static final float H = 250f;
    static final float FACE_Y = 150f;     // where the band sits on the face
    static final float LINE_RIGHT = 392f; // the last point: inside the circle with its ring at the band's lowest point
    static final float BOX_TOP = 62f;     // the line's box (the fill reaches its bottom)
    static final float BOX_H = 143f;
    static final float PAD = 10f;         // inside the box, above and below the line
    static final float STROKE = 4f;       // a thick line
    static final int N = 90;              // the app's RX_SPARK.n

    static final int UP = 0xFF00FFC8;     // the dashboard's --accent
    static final int DOWN = 0xFFFF4D6A;   // --danger
    static final int MUTED = 0xFF888888;  // --text-muted

    static final long PULSE_MS = 1500;
    static final long SLIDE_MS = 900;     // the app's "transition: d .9s ease"
    private static final Interpolator EASE_OUT = new PathInterpolator(0f, 0f, 0.58f, 1f);
    static final Interpolator EASE = new PathInterpolator(0.25f, 0.1f, 0.25f, 1f);

    /** What the card shows; built once per answer. */
    static final class Model {
        String dollars = "--";
        String cents = "";
        @Nullable float[] ys;    // N heights, 0 = top of the line's inner box, 1 = bottom; null = no line
        boolean up = true;
        String range = "";       // "6h", "24h", or "Today" when there is no series
        String change = "";
        int color = UP;
        @Nullable String stale;  // the last answer's time when it is over 15 minutes old or the last fetch failed
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
            m.range = "6h";
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
        m.stale = stale(ctx);
        return m;
    }

    /** Null while the last answer is good and under 15 minutes old; otherwise its time, so old numbers never pass as live. */
    @Nullable
    private static String stale(Context ctx) {
        long at = WatchStore.values(ctx).getLong(WatchStore.V_FETCHED, 0);
        if (at <= 0) return null;
        boolean fresh = WatchStore.status(ctx).isEmpty() && System.currentTimeMillis() - at < 15 * 60_000L;
        return fresh ? null : Fmt.hhmm(at);
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
     * The band at sc pixels per face unit. ys: the line to draw (the app's view passes the one it is sliding between two
     * answers), or null for m's own. pulse: the dot's phase 0..1, or < 0 for no dot (the face pulses its own).
     */
    static void draw(Canvas c, float sc, Model m, @Nullable float[] ys, float pulse) {
        if (ys == null) ys = m.ys;
        if (ys != null) {
            drawLine(c, 0, BOX_TOP * sc, LINE_RIGHT * sc, BOX_H * sc, PAD * sc, sc, STROKE, ys, m.color, true, pulse);
        }
        drawTotal(c, sc, m, false);

        // under the line: "6h -$133.89 (-2.68%)" in its colour (or why there are no numbers), centred in the circle
        Paint cap = new Paint(Paint.ANTI_ALIAS_FLAG);
        cap.setTextAlign(Paint.Align.CENTER);
        cap.setTextSize(21 * sc);
        float base = 238 * sc;
        if (m.message != null) {
            cap.setColor(MUTED);
            cap.setTextSize(17 * sc);
            c.drawText(m.message, W * sc / 2, base, cap);
            return;
        }
        String text = (m.range + " " + m.change).trim();
        cap.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        cap.setColor(m.color);
        if (m.stale == null) {
            c.drawText(text, W * sc / 2, base, cap);
        } else {   // old numbers: their time after them, grey
            Paint grey = new Paint(cap);
            grey.setTypeface(Typeface.DEFAULT);
            grey.setColor(MUTED);
            String t = "  " + m.stale;
            float w1 = cap.measureText(text);
            float w2 = grey.measureText(t);
            float x = (W * sc - w1 - w2) / 2 + w1 / 2;
            c.drawText(text, x, base, cap);
            grey.setTextAlign(Paint.Align.LEFT);
            c.drawText(t, x + w1 / 2, base, grey);
        }
    }

    /** "$4,863" with a smaller ".98", centred over the upper part of the graph; outline only for always-on. */
    private static void drawTotal(Canvas c, float sc, Model m, boolean outline) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        p.setColor(Fmt.WHITE);
        if (outline) {
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(1.6f * sc);
        }
        p.setTextSize(46 * sc);
        float wd = p.measureText(m.dollars);
        Paint pc = new Paint(p);
        pc.setTextSize(27 * sc);
        float wc = m.cents.isEmpty() ? 0 : pc.measureText(m.cents);
        float x0 = (W * sc - wd - wc) / 2;
        c.drawText(m.dollars, x0, 50 * sc, p);
        if (wc > 0) c.drawText(m.cents, x0 + wd, 50 * sc, pc);
    }

    /**
     * The line (smoothed), its fill (fill = true) and (pulse >= 0) the dot with its ring, in the box left/top/w/h (pixels) with
     * pad inside above and below; sc = pixels per unit, stroke in units. The band, the Tiles and the coin screen use this.
     */
    static void drawLine(Canvas c, float left, float boxTop, float w, float h, float pad, float sc, float stroke, float[] ys,
                         int color, boolean fill, float pulse) {
        float top = boxTop + pad;
        float ih = h - 2 * pad;
        float bottom = boxTop + h;
        int n = ys.length;
        float[] x = new float[n];
        float[] y = new float[n];
        float minY = bottom;
        for (int i = 0; i < n; i++) {
            x[i] = left + w * i / (n - 1);
            y[i] = top + ih * ys[i];
            minY = Math.min(minY, y[i]);
        }
        // smooth: each point is a control point, the curve passes through the midpoints, and ends on the last point
        Path line = new Path();
        line.moveTo(x[0], y[0]);
        for (int i = 1; i < n - 1; i++) line.quadTo(x[i], y[i], (x[i] + x[i + 1]) / 2, (y[i] + y[i + 1]) / 2);
        line.lineTo(x[n - 1], y[n - 1]);
        if (fill) {
            Path area = new Path(line);
            area.lineTo(x[n - 1], bottom);
            area.lineTo(x[0], bottom);
            area.close();
            Paint f = new Paint(Paint.ANTI_ALIAS_FLAG);
            f.setStyle(Paint.Style.FILL);
            f.setShader(new LinearGradient(0, minY, 0, bottom, withAlpha(color, 0.28f), withAlpha(color, 0f), Shader.TileMode.CLAMP));
            c.drawPath(area, f);
        }
        Paint s = new Paint(Paint.ANTI_ALIAS_FLAG);
        s.setStyle(Paint.Style.STROKE);
        s.setStrokeWidth(stroke * sc);
        s.setStrokeJoin(Paint.Join.ROUND);
        s.setStrokeCap(Paint.Cap.ROUND);
        s.setColor(color);
        c.drawPath(line, s);
        if (pulse < 0) return;
        float cx = x[n - 1];
        float cy = y[n - 1];
        float e = EASE_OUT.getInterpolation(pulse);
        float scale = 0.4f + 1.2f * e;
        Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        ring.setStyle(Paint.Style.STROKE);
        ring.setColor(withAlpha(color, 0.7f * (1 - e)));
        ring.setStrokeWidth(2.5f * scale * sc);
        c.drawCircle(cx, cy, 10 * scale * sc, ring);
        Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG);
        dot.setColor(color);
        c.drawCircle(cx, cy, 5 * sc, dot);
    }

    /** The phase a still picture (a Tile) shows the ring at: part-way out, so it reads as the live dot. */
    static final float STILL_PULSE = 0.3f;

    /**
     * A Tile's line: values (oldest first) resampled like the band, drawn w x h pixels with room for the dot and its ring at
     * the right end; null when there are fewer than 2 values.
     */
    static byte[] linePng(@Nullable double[] values, int color, int w, int h, float sc) {
        if (values == null || values.length < 2) return null;
        float[] ys = heights(resample(values));
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        float room = 14 * sc;   // the ring at STILL_PULSE reaches about 11 units past the last point
        drawLine(new Canvas(b), 0, 0, w - room, h, room * 0.75f, sc, 3f, ys, color, true, STILL_PULSE);
        return png(b);
    }

    /**
     * The coin screen's card, in the band's layout: the price with its cents smaller, the coin's 24 h line, "24h +8.10%" in
     * its colour (green/red by the 24 h move).
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
        m.range = "24h";
        m.change = Double.isNaN(q.pct) ? "" : (m.up ? "+" : "−") + String.format(Locale.US, "%.2f", Math.abs(q.pct)) + "%";
        m.stale = stale(ctx);
        return m;
    }

    /** A coin is green when its 24 h move is >= 0; without a %, by its line (last >= first); else green. */
    static boolean up(Snapshot.Quote q) {
        if (!Double.isNaN(q.pct)) return q.pct >= 0;
        if (q.spark != null && q.spark.length >= 2) return q.spark[q.spark.length - 1] >= q.spark[0];
        return true;
    }

    /**
     * The face's image: the band without a dot (the face pulses its own on top). A bitmap: Wear OS's face runtime cannot keep an
     * image sent as PNG bytes ("Failed to serialize icon of type 3" on the emulator).
     */
    static Bitmap band(Model m, float sc) {
        Bitmap b = Bitmap.createBitmap(Math.round(W * sc), Math.round(H * sc), Bitmap.Config.ARGB_8888);
        draw(new Canvas(b), sc, m, null, -1f);
        return b;
    }

    /** Always-on: the total in outline and the line as a thin grey outline - no fill, no dot, no colour, no caption. */
    static Bitmap ambientBand(Model m, float sc) {
        Bitmap b = Bitmap.createBitmap(Math.round(W * sc), Math.round(H * sc), Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        if (m.ys != null) drawLine(c, 0, BOX_TOP * sc, LINE_RIGHT * sc, BOX_H * sc, PAD * sc, sc, 1.6f, m.ys, 0xFFBBBBBB, false, -1f);
        if (m.message == null) drawTotal(c, sc, m, true);
        return b;
    }

    /** The band as a PNG (CI's render test). */
    static byte[] png(Model m, float sc) {
        return png(band(m, sc));
    }

    static byte[] png(Bitmap b) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.PNG, 100, out);
        b.recycle();
        return out.toByteArray();
    }

    static int withAlpha(int color, float a) {
        return (Math.round(Math.max(0f, Math.min(1f, a)) * 255) << 24) | (color & 0xFFFFFF);
    }
}
