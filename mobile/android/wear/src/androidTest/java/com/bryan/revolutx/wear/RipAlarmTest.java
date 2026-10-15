package com.bryan.revolutx.wear;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Desk #59 (15 Oct), CI only: what the watch does with the phone's Rip alarm, without a phone. A test tone (beeps, made here)
 * is kept as if the phone had sent it on /rx/watch/sound/<id>, then the phone's /rx/watch/alarm bytes for the server's test alarm
 * go through KeyListener.onAlarm, the listener's own handling (CI has no paired phone to deliver them). The job checks that the alarm stream plays and the notification is up, with Do Not Disturb on.
 */
@RunWith(AndroidJUnit4.class)
public class RipAlarmTest {

    static final String SOUND = "c0ffee0123456789";

    @Test
    public void ring() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        RipRing.keepSound(ctx, SOUND, new ByteArrayInputStream(beeps()));
        // what the phone sends for the server's test alarm (#523; WatchAlarmTest checks the phone builds exactly this),
        // through the watch listener's own alarm method
        byte[] payload = ("{\"coin\":\"TEST\",\"test\":true,\"id\":\"4711\",\"sound\":\"" + SOUND + "\"}")
            .getBytes(StandardCharsets.UTF_8);
        assertNotNull(RipRing.Alarm.parse(payload));
        KeyListener.onAlarm(ctx, payload);
        // the app's process ends with the test, so the test stays while the CI job looks at the ringing watch
        Thread.sleep(6_000);
        assertTrue("ringing", RipRing.isRinging());
        Thread.sleep(30_000);
        assertFalse("silent after 30 s", RipRing.isRinging());
    }

    /** A real coin's alarm with the logo the phone sends (a stand-in picture made here): the face flashes it. Silenced at once. */
    @Test
    public void ripIconWithLogo() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        android.graphics.Bitmap b = android.graphics.Bitmap.createBitmap(48, 48, android.graphics.Bitmap.Config.ARGB_8888);
        android.graphics.Canvas c = new android.graphics.Canvas(b);
        android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        p.setShader(new android.graphics.LinearGradient(0, 0, 48, 48, 0xFF9945FF, 0xFF14F195, android.graphics.Shader.TileMode.CLAMP));
        c.drawCircle(24, 24, 24, p);   // a SOL-like disc
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        b.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, png);
        String logo = android.util.Base64.encodeToString(png.toByteArray(), android.util.Base64.NO_WRAP);
        byte[] payload = ("{\"coin\":\"SOL\",\"pct\":34.2,\"price\":182.4,\"id\":\"4712\",\"sound\":\"" + SOUND
            + "\",\"logo\":\"" + logo + "\"}").getBytes(StandardCharsets.UTF_8);
        KeyListener.onAlarm(ctx, payload);
        Thread.sleep(1500);
        RipRing.stopRinging(ctx);   // quiet for the screenshots; the icon stays (RipState)
        assertTrue("ripping", RipState.active(ctx));
        Thread.sleep(25_000);       // the CI job takes the face's screenshots meanwhile
    }

    @Test
    public void clearRip() {
        RipState.clear(InstrumentationRegistry.getInstrumentation().getTargetContext());
    }

    /** 1.2 s of two-tone beeps, 16-bit mono WAV. */
    private static byte[] beeps() {
        int rate = 22050;
        int n = rate * 12 / 10;
        ByteBuffer pcm = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < n; i++) {
            double t = (double) i / rate;
            boolean on = (int) (t * 10) % 2 == 0;
            double f = t < 0.6 ? 880 : 1175;
            pcm.putShort((short) (on ? 9000 * Math.sin(2 * Math.PI * f * t) : 0));
        }
        ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes()).putInt(36 + n * 2).put("WAVE".getBytes()).put("fmt ".getBytes()).putInt(16).putShort((short) 1)
            .putShort((short) 1).putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16).put("data".getBytes()).putInt(n * 2);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(h.array(), 0, 44);
        out.write(pcm.array(), 0, n * 2);
        return out.toByteArray();
    }
}
