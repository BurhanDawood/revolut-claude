package com.bryan.revolutx;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.DashPathEffect;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import org.json.JSONArray;

/**
 * The widget's line chart, drawn into a Bitmap: a 2dp line (green when last >= first, red otherwise),
 * a soft gradient of the same colour under it, and a faint dashed line at the first value. No axes, no labels.
 */
final class SparkChart {

    static final int UP = 0xFF00C896;
    static final int DOWN = 0xFFFF4D6A;
    /** RemoteViews bitmaps travel through a Binder transaction; stay far below its limit (~250k px = ~1 MB ARGB). */
    private static final int MAX_PIXELS = 250_000;

    private SparkChart() {}

    /** points: [[unix_s, usd], ...] ascending. Returns null when there is nothing to draw. */
    static Bitmap draw(JSONArray points, int widthPx, int heightPx, float density) {
        if (points == null || points.length() < 2 || widthPx < 8 || heightPx < 8) return null;
        float scale = 1f;
        if ((long) widthPx * heightPx > MAX_PIXELS) scale = (float) Math.sqrt(MAX_PIXELS / (double) ((long) widthPx * heightPx));
        int w = Math.max(8, Math.round(widthPx * scale)), h = Math.max(8, Math.round(heightPx * scale));
        float dp = density * scale;

        int n = points.length();
        double[] t = new double[n], v = new double[n];
        for (int i = 0; i < n; i++) {
            JSONArray p = points.optJSONArray(i);
            if (p == null) return null;
            t[i] = p.optDouble(0);
            v[i] = p.optDouble(1);
        }
        double first = v[0], last = v[n - 1];
        double lo = first, hi = first;
        for (double x : v) {
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
        }
        if (hi - lo < 1e-9) {
            hi += 1;
            lo -= 1;
        }
        double t0 = t[0], t1 = t[n - 1];
        if (t1 - t0 < 1e-9) t1 = t0 + 1;

        float pad = 3 * dp, top = pad, bottom = h - pad;
        float left = 1 * dp, right = w - 1 * dp;
        int color = last >= first ? UP : DOWN;

        Path line = new Path();
        for (int i = 0; i < n; i++) {
            float x = (float) (left + (t[i] - t0) / (t1 - t0) * (right - left));
            float y = (float) (bottom - (v[i] - lo) / (hi - lo) * (bottom - top));
            if (i == 0) line.moveTo(x, y);
            else line.lineTo(x, y);
        }

        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);

        Path fill = new Path(line);
        fill.lineTo(right, h);
        fill.lineTo(left, h);
        fill.close();
        Paint fp = new Paint(Paint.ANTI_ALIAS_FLAG);
        fp.setStyle(Paint.Style.FILL);
        fp.setShader(new LinearGradient(0, top, 0, h, (color & 0x00FFFFFF) | 0x4D000000, color & 0x00FFFFFF, Shader.TileMode.CLAMP));
        c.drawPath(fill, fp);

        float yFirst = (float) (bottom - (first - lo) / (hi - lo) * (bottom - top));
        Paint dash = new Paint(Paint.ANTI_ALIAS_FLAG);
        dash.setStyle(Paint.Style.STROKE);
        dash.setStrokeWidth(Math.max(1f, 1 * dp));
        dash.setColor(0x40E8E8E8);
        dash.setPathEffect(new DashPathEffect(new float[] { 4 * dp, 4 * dp }, 0));
        Path base = new Path();
        base.moveTo(left, yFirst);
        base.lineTo(right, yFirst);
        c.drawPath(base, dash);

        Paint lp = new Paint(Paint.ANTI_ALIAS_FLAG);
        lp.setStyle(Paint.Style.STROKE);
        lp.setStrokeWidth(2 * dp);
        lp.setStrokeJoin(Paint.Join.ROUND);
        lp.setStrokeCap(Paint.Cap.ROUND);
        lp.setColor(color);
        c.drawPath(line, lp);
        return bmp;
    }
}
