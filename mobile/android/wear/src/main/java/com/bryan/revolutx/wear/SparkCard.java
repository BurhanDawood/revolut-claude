package com.bryan.revolutx.wear;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.DashPathEffect;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.view.animation.Interpolator;
import android.view.animation.PathInterpolator;
import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Desk #59 (Bryan 14 Oct 14:01): the whole face, drawn by one routine for the watch face (CardComplication's full-face image,
 * AmbientCardComplication's outline) and the first screen of the watch app (SparkCardView, which also draws the time and date
 * the face draws natively). Face units, 450 x 450, round:
 *   the total, smaller, at the top (baseline 70); the time, the largest, in the middle of the screen (the face's own clock) with
 *   the date small under it as one block;
 *   the 6-hour line raised so its peaks rise behind the time and date (box y 120..360, the line in 130..350), thick, smoothed,
 *   a fill fading from 28%, #00ffc8 when the 6 h change is >= 0 and #ff4d6a when down; its last point at x 392 so the dot and
 *   its ring stay inside the circle at any height; under it "6h -$121.01 (-2.51%)", as large as fits the circle there.
 * The pulsing dot is the app's ring (0.4 -> 1.6, 0.7 -> 0, ease-out), 1.5 s. Keep the numbers in step with the watchface
 * module's res/raw/watchface.xml, which places its own clock, date and dot on this image.
 * Also the coin charts: drawLine (the line), drawCandles (hourly candles with volume and a dotted live-price line).
 */
final class SparkCard {

    static final float W = 450f;
    static final float H = 450f;
    static final float TOTAL_BASE = 70f;
    static final float BOX_TOP = 120f;    // the line's box (the fill reaches its bottom)
    static final float BOX_H = 240f;
    static final float PAD = 10f;         // inside the box: the line spans y 130..350
    static final float LINE_RIGHT = 392f; // the last point: inside the circle with its ring at the box's lowest point
    static final float CAPTION_BASE = 380f;   // where the circle is still ~330 wide
    static final float STROKE = 4f;       // a thick line
    static final int N = 90;              // the app's RX_SPARK.n

    static final int UP = 0xFF00FFC8;     // the dashboard's --accent
    static final int DOWN = 0xFFFF4D6A;   // --danger
    static final int MUTED = 0xFF888888;  // --text-muted

    static final long PULSE_MS = 1500;
    static final long SLIDE_MS = 900;     // the app's "transition: d .9s ease"
    private static final Interpolator EASE_OUT = new PathInterpolator(0f, 0f, 0.58f, 1f);
    static final Interpolator EASE = new PathInterpolator(0.25f, 0.1f, 0.25f, 1f);

    /** What the face shows; built once per answer. */
    static final class Model {
        String dollars = "--";
        String cents = "";
        @Nullable float[] ys;    // N heights, 0 = top of the line's inner box, 1 = bottom; null = no line
        boolean up = true;
        String range = "";       // "6h", or "Today" when there is no series
        String change = "";
        int color = UP;
        @Nullable String stale;  // the last answer's time when it is over 15 minutes old or the last fetch failed: no pulse then
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

    /** The face for this answer; s is null before the first one. */
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
    static String stale(Context ctx) {
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
     * The face at sc pixels per face unit, on black. ys: the line to draw (the app's view passes the one it is sliding between
     * two answers), or null for m's own. pulse: the dot's phase 0..1, or < 0 for no dot (the face pulses its own).
     * clock: null, or draw the time (24 h when true) and date too (the app; the face has its own clock on top of this image).
     */
    static void draw(Canvas c, float sc, Model m, @Nullable float[] ys, float pulse, @Nullable Boolean clock) {
        if (ys == null) ys = m.ys;
        c.drawColor(0xFF000000);
        // old numbers on the face: a still dot here (the face's own pulsing dot is off then)
        float dot = pulse < 0 && m.stale != null ? 0f : pulse;
        if (ys != null) drawLine(c, 0, BOX_TOP * sc, LINE_RIGHT * sc, BOX_H * sc, PAD * sc, sc, STROKE, ys, m.color, true, dot);
        // a soft dark glow behind the time and date, so they stay readable where the line's peaks rise behind them
        Paint scrim = new Paint(Paint.ANTI_ALIAS_FLAG);
        scrim.setColor(0x73000000);
        scrim.setMaskFilter(new BlurMaskFilter(22 * sc, BlurMaskFilter.Blur.NORMAL));
        c.drawRoundRect(new RectF(92 * sc, 172 * sc, 358 * sc, 312 * sc), 44 * sc, 44 * sc, scrim);   // the centred time and date
        drawTotal(c, sc, m, false);
        if (clock != null) drawClock(c, sc, clock);

        Paint cap = new Paint(Paint.ANTI_ALIAS_FLAG);
        cap.setTextAlign(Paint.Align.CENTER);
        float base = CAPTION_BASE * sc;
        if (m.message != null) {
            cap.setColor(MUTED);
            cap.setTextSize(fit(cap, m.message, 20 * sc, 300 * sc));
            c.drawText(m.message, W * sc / 2, base, cap);
            return;
        }
        // "6h -$121.01 (-2.51%)" alone, as large as fits the circle there (old numbers: the dot stops pulsing instead)
        String text = (m.range + " " + m.change).trim();
        cap.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        cap.setTextSize(fit(cap, text, 36 * sc, 318 * sc));
        cap.setColor(m.color);
        c.drawText(text, W * sc / 2, base, cap);
    }

    /** The largest size up to max at which text fits width. */
    static float fit(Paint p, String text, float max, float width) {
        float size = max;
        p.setTextSize(size);
        while (size > 8 && p.measureText(text) > width) {
            size -= 1;
            p.setTextSize(size);
        }
        return size;
    }

    /** "$4,863" with a smaller ".98", centred at the top; outline only for always-on. */
    private static void drawTotal(Canvas c, float sc, Model m, boolean outline) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        p.setColor(outline ? 0xFFDDDDDD : Fmt.WHITE);
        if (outline) {
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(1.3f * sc);
        }
        p.setTextSize(34 * sc);
        float wd = p.measureText(m.dollars);
        Paint pc = new Paint(p);
        pc.setTextSize(21 * sc);
        float wc = m.cents.isEmpty() ? 0 : pc.measureText(m.cents);
        float x0 = (W * sc - wd - wc) / 2;
        c.drawText(m.dollars, x0, TOTAL_BASE * sc, p);
        if (wc > 0) c.drawText(m.cents, x0 + wd, TOTAL_BASE * sc, pc);
    }

    /** The app's copy of the face's clock: the time, the largest, in the centre, and "Wed 14 Oct" under it, with a soft dark shadow. */
    static void drawClock(Canvas c, float sc, boolean is24) {
        Date now = new Date();
        Paint t = new Paint(Paint.ANTI_ALIAS_FLAG);
        t.setColor(Fmt.WHITE);
        t.setTextAlign(Paint.Align.CENTER);
        t.setTextSize(104 * sc);
        t.setShadowLayer(6 * sc, 0, 2 * sc, 0xCC000000);
        String time = new SimpleDateFormat(is24 ? "HH:mm" : "h:mm", Locale.getDefault()).format(now);
        c.drawText(time, W * sc / 2, 260 * sc, t);
        Paint d = new Paint(t);
        d.setTextSize(22 * sc);
        d.setColor(0xFFDDDDDD);
        c.drawText(new SimpleDateFormat("EEE d MMM", Locale.getDefault()).format(now), W * sc / 2, 300 * sc, d);
    }

    /**
     * The line (smoothed), its fill (fill = true) and (pulse >= 0) the dot with its ring, in the box left/top/w/h (pixels) with
     * pad inside above and below; sc = pixels per unit, stroke in units. The face, the Tiles and the coin screen use this.
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
            Paint f = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.DITHER_FLAG);
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
        drawDot(c, x[n - 1], y[n - 1], sc, color, pulse);
    }

    static void drawDot(Canvas c, float cx, float cy, float sc, int color, float pulse) {
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

    /**
     * Desk #59 (14 Oct 14:01): the exchange-style chart - hourly candles [t, o, h, l, c, v] (oldest first), green #00ffc8 up /
     * red down with wicks, volume bars along the bottom in the same colours (none where v is unknown), and a dotted line at the
     * live price. Drawn in the box left/top/w/h (pixels); sc = pixels per unit.
     */
    static void drawCandles(Canvas c, float left, float top, float w, float h, float sc, double[][] k, double live) {
        int n = k.length;
        if (n == 0) return;
        double lo = Double.MAX_VALUE;
        double hi = -Double.MAX_VALUE;
        double vmax = 0;
        for (double[] x : k) {
            lo = Math.min(lo, Math.min(x[3], x[4]));
            hi = Math.max(hi, Math.max(x[2], x[4]));
            if (!Double.isNaN(x[5])) vmax = Math.max(vmax, x[5]);
        }
        if (!Double.isNaN(live)) {
            lo = Math.min(lo, live);
            hi = Math.max(hi, live);
        }
        if (hi <= lo) hi = lo + Math.max(1e-9, Math.abs(lo) * 0.001);
        float volH = vmax > 0 ? h * 0.22f : 0;     // volume along the bottom
        float priceH = h - volH - (vmax > 0 ? 4 * sc : 0);
        float slot = w / n;
        float body = Math.max(1.5f * sc, slot * 0.62f);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        for (int i = 0; i < n; i++) {
            double[] x = k[i];
            boolean up = x[4] >= x[1];
            int col = up ? UP : DOWN;
            float cx = left + slot * (i + 0.5f);
            float yh = top + (float) ((hi - x[2]) / (hi - lo)) * priceH;
            float yl = top + (float) ((hi - x[3]) / (hi - lo)) * priceH;
            float yo = top + (float) ((hi - x[1]) / (hi - lo)) * priceH;
            float yc = top + (float) ((hi - x[4]) / (hi - lo)) * priceH;
            p.setColor(col);
            p.setStrokeWidth(Math.max(1f, 1.2f * sc));
            c.drawLine(cx, yh, cx, yl, p);
            float bt = Math.min(yo, yc);
            float bb = Math.max(Math.max(yo, yc), bt + Math.max(1f, sc));
            c.drawRect(cx - body / 2, bt, cx + body / 2, bb, p);
            if (vmax > 0 && !Double.isNaN(x[5]) && x[5] > 0) {
                float vh = (float) (x[5] / vmax) * volH;
                p.setColor(withAlpha(col, 0.55f));
                c.drawRect(cx - body / 2, top + h - vh, cx + body / 2, top + h, p);
            }
        }
        if (!Double.isNaN(live)) {   // the live price, dotted, across the chart
            float y = top + (float) ((hi - live) / (hi - lo)) * priceH;
            Paint d = new Paint(Paint.ANTI_ALIAS_FLAG);
            d.setStyle(Paint.Style.STROKE);
            d.setColor(0xCCFFFFFF);
            d.setStrokeWidth(1.2f * sc);
            d.setPathEffect(new DashPathEffect(new float[] { 2.5f * sc, 3.5f * sc }, 0));
            Path dl = new Path();
            dl.moveTo(left, y);
            dl.lineTo(left + w, y);
            c.drawPath(dl, d);
        }
    }

    /** The phase a still picture (a Tile) shows the ring at: part-way out, so it reads as the live dot. */
    static final float STILL_PULSE = 0.3f;

    /**
     * A Tile's line: values (oldest first) resampled like the face, drawn w x h pixels with room for the dot and its ring at
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

    /** A Tile's or the coin screen's candle chart, w x h pixels; null without candles. */
    static byte[] candlesPng(@Nullable double[][] k, double live, int w, int h, float sc) {
        if (k == null || k.length < 2) return null;
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        drawCandles(new Canvas(b), 0, 0, w, h, sc, k, live);
        return png(b);
    }

    /** A coin is green when its 24 h move is >= 0; without a %, by its line (last >= first); else green. */
    static boolean up(Snapshot.Quote q) {
        if (!Double.isNaN(q.pct)) return q.pct >= 0;
        if (q.spark != null && q.spark.length >= 2) return q.spark[q.spark.length - 1] >= q.spark[0];
        return true;
    }

    /**
     * The face's image: the whole face without its clock, date, dot and notes (the face draws those on top). Opaque RGB_565 (the
     * face is black under it): half the bytes of a transparent one, so it travels to the face runtime as a bitmap comfortably.
     */
    static Bitmap face(Model m, float sc) {
        Bitmap b = Bitmap.createBitmap(Math.round(W * sc), Math.round(H * sc), Bitmap.Config.RGB_565);
        draw(new Canvas(b), sc, m, null, -1f, null);
        return b;
    }

    /** Always-on: the total in outline and the line as a thin grey outline - no fill, no dot, no colour, no caption. */
    static Bitmap ambientFace(Model m, float sc) {
        Bitmap b = Bitmap.createBitmap(Math.round(W * sc), Math.round(H * sc), Bitmap.Config.RGB_565);
        Canvas c = new Canvas(b);
        c.drawColor(0xFF000000);
        if (m.ys != null) drawLine(c, 0, BOX_TOP * sc, LINE_RIGHT * sc, BOX_H * sc, PAD * sc, sc, 1.6f, m.ys, 0xFF999999, false, -1f);
        if (m.message == null) drawTotal(c, sc, m, true);
        return b;
    }

    /** The face's image as a PNG (CI's render test). */
    static byte[] png(Model m, float sc) {
        return png(face(m, sc));
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
