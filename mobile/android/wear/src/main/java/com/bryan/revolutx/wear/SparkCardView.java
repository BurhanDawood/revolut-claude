package com.bryan.revolutx.wear;

import android.content.Context;
import android.graphics.Canvas;
import android.os.SystemClock;
import android.view.View;
import java.util.Arrays;

/**
 * Desk #59 (Bryan 13 Oct 23:21): the card at the top of the watch app, live while it is on screen: the dot pulses (the app's
 * 2 s ring) and a new answer's line slides from the old one over 0.9 s, like the dashboard's. Drawn by SparkCard, the routine
 * the face's image uses, so the two look the same. It only draws; MainActivity fetches.
 */
final class SparkCardView extends View {

    private SparkCard.Model model;
    private float[] from;   // the line being slid from, or null
    private float[] shown;  // the line as last drawn
    private long slideStart;
    private final long born = SystemClock.uptimeMillis();

    SparkCardView(Context ctx) {
        super(ctx);
    }

    void set(SparkCard.Model m) {
        float[] next = m.ys;
        if (next != null && shown != null && model != null && model.ys != null && !Arrays.equals(next, model.ys)) {
            from = shown.clone();
            slideStart = SystemClock.uptimeMillis();
        } else if (next == null || shown == null) {
            from = null;
            shown = next;
        }
        model = m;
        invalidate();
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        int w = MeasureSpec.getSize(widthSpec);
        setMeasuredDimension(w, Math.round(w * SparkCard.H / SparkCard.W));
    }

    @Override
    protected void onDraw(Canvas c) {
        if (model == null) return;
        long now = SystemClock.uptimeMillis();
        float[] ys = model.ys;
        if (ys != null && from != null && from.length == ys.length) {
            float t = (now - slideStart) / (float) SparkCard.SLIDE_MS;
            if (t >= 1f) {
                from = null;
            } else {
                float e = SparkCard.EASE.getInterpolation(t);
                float[] mid = new float[ys.length];
                for (int i = 0; i < ys.length; i++) mid[i] = from[i] + (ys[i] - from[i]) * e;
                ys = mid;
            }
        }
        shown = ys;
        float pulse = ys == null ? -1f : ((now - born) % SparkCard.PULSE_MS) / (float) SparkCard.PULSE_MS;
        SparkCard.draw(c, getWidth() / SparkCard.W, model, ys, pulse);
        if (ys != null) postInvalidateOnAnimation();   // only runs while the screen draws: it stops when the app is off screen
    }
}
