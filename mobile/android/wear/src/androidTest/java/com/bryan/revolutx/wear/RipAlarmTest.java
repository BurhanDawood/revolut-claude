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
 * is kept as if the phone had sent it on /rx/watch/sound/<id>, then the /rx/watch/alarm payload goes through the same parse
 * and ring as KeyListener's. The job checks that the alarm stream plays and the notification is up, with Do Not Disturb on.
 */
@RunWith(AndroidJUnit4.class)
public class RipAlarmTest {

    static final String SOUND = "c0ffee0123456789";

    @Test
    public void ring() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        RipRing.keepSound(ctx, SOUND, new ByteArrayInputStream(beeps()));
        byte[] payload = ("{\"coin\":\"SOL\",\"pct\":34.2,\"price\":182.4,\"id\":\"9001\",\"sound\":\"" + SOUND + "\"}")
            .getBytes(StandardCharsets.UTF_8);
        RipRing.Alarm a = RipRing.Alarm.parse(payload);
        assertNotNull(a);
        RipRing.ring(ctx, a);
        // the app's process ends with the test, so the test stays while the CI job looks at the ringing watch
        Thread.sleep(6_000);
        assertTrue("ringing", RipRing.isRinging());
        Thread.sleep(30_000);
        assertFalse("silent after 30 s", RipRing.isRinging());
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
