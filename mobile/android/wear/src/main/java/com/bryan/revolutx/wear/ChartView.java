package com.bryan.revolutx.wear;

import android.content.Context;
import android.graphics.Canvas;
import android.os.SystemClock;
import android.view.View;

/**
 * Desk #59 (Bryan 14 Oct 14:01): the coin screen's chart, the same as its Coin Tile's - the last 24 hourly candles with volume
 * and a dotted live-price line (SparkCard.drawCandles), or, without candles, the 24 h line with its pulsing dot.
 */
final class ChartView extends View {

    private Snapshot.Quote q;
    private final long born = SystemClock.uptimeMillis();

    ChartView(Context ctx) {
        super(ctx);
    }

    void set(Snapshot.Quote quote) {
        q = quote;
        invalidate();
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        int w = MeasureSpec.getSize(widthSpec);
        setMeasuredDimension(w, Math.round(w * 0.5f));
    }

    @Override
    protected void onDraw(Canvas c) {
        if (q == null) return;
        float sc = getResources().getDisplayMetrics().density;
        if (q.candles != null && q.candles.length >= 2) {
            SparkCard.drawCandles(c, 0, 0, getWidth(), getHeight(), sc, q.candles, q.price);
            return;
        }
        if (q.spark == null || q.spark.length < 2) return;
        float room = 14 * sc;
        float pulse = ((SystemClock.uptimeMillis() - born) % SparkCard.PULSE_MS) / (float) SparkCard.PULSE_MS;
        SparkCard.drawLine(c, 0, 0, getWidth() - room, getHeight(), room * 0.75f, sc, 3f,
            SparkCard.heights(SparkCard.resample(q.spark)), SparkCard.up(q) ? SparkCard.UP : SparkCard.DOWN, true, pulse);
        postInvalidateOnAnimation();
    }
}
