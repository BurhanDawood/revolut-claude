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
        freshAlarm(ctx);
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
        android.app.Notification n = active(ctx);
        android.util.Log.i("RxRipRing", "after the 30 s cap: stop=" + RipRing.lastStop + ", notification " + (n == null ? "gone"
            : (n.fullScreenIntent == null ? "kept, quiet, no full-screen page" : "STILL WITH ITS FULL-SCREEN PAGE")) + ", face icon " + (RipState.active(ctx) ? "kept" : "cleared"));
        assertTrue("the notification no longer brings the alarm page back", n == null || n.fullScreenIntent == null);
        assertTrue("the face icon stays for its 60 min", RipState.active(ctx));
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
        freshAlarm(ctx);
        byte[] payload = ("{\"coin\":\"SOL\",\"pct\":34.2,\"price\":182.4,\"id\":\"4712\",\"sound\":\"" + SOUND
            + "\",\"logo\":\"" + logo + "\"}").getBytes(StandardCharsets.UTF_8);
        KeyListener.onAlarm(ctx, payload);
        Thread.sleep(1500);
        RipRing.stopRinging(ctx);   // quiet for the screenshots; the icon stays (RipState)
        assertTrue("ripping", RipState.active(ctx));
        Thread.sleep(25_000);       // the CI job takes the face's screenshots meanwhile
    }

    /**
     * 15 Oct 14:56: the same TEST alarm through the real Data Layer: MessageClient.sendMessage to this watch's own node on
     * /rx/watch/alarm, so Play services has to find KeyListener by its manifest filter and start it (the app is not asked).
     * Passes when the listener recorded the arrival (RipDiag, the line on the app's first screen). Silenced at once.
     */
    @Test
    public void viaDataLayer() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        android.content.SharedPreferences p = ctx.getSharedPreferences("rx_watch_rip_diag", Context.MODE_PRIVATE);
        freshAlarm(ctx);
        long before = p.getLong("at", 0);
        com.google.android.gms.wearable.Node local = com.google.android.gms.tasks.Tasks.await(
            com.google.android.gms.wearable.Wearable.getNodeClient(ctx).getLocalNode(), 15, java.util.concurrent.TimeUnit.SECONDS);
        byte[] payload = "{\"coin\":\"TEST\",\"test\":true,\"id\":\"4713\",\"sound\":\"\"}".getBytes(StandardCharsets.UTF_8);
        com.google.android.gms.tasks.Tasks.await(com.google.android.gms.wearable.Wearable.getMessageClient(ctx)
            .sendMessage(local.getId(), KeyListener.PATH_ALARM, payload), 15, java.util.concurrent.TimeUnit.SECONDS);
        long until = System.currentTimeMillis() + 20_000;
        while (p.getLong("at", 0) == before && System.currentTimeMillis() < until) Thread.sleep(250);
        android.util.Log.i("RxRipRing", "Data Layer test: " + (p.getLong("at", 0) != before ? "delivered to KeyListener" : "NOT delivered") + " (local node " + local.getId() + ")");
        Thread.sleep(1500);
        RipRing.stopRinging(ctx);
        assertTrue("delivered over the Data Layer to KeyListener", p.getLong("at", 0) != before);
    }


    // ── Bryan 15 Oct 16:22: every way to stop it ──

    /** A fresh TEST alarm (the 2-min duplicate guard reset first), ringing within 5 s. */
    private static void ringTest(Context ctx, String id) throws Exception {
        freshAlarm(ctx);
        KeyListener.onAlarm(ctx, ("{\"coin\":\"TEST\",\"test\":true,\"id\":\"" + id + "\",\"sound\":\"" + SOUND + "\"}").getBytes(StandardCharsets.UTF_8));
        long until = System.currentTimeMillis() + 5000;
        while (!RipRing.isRinging() && System.currentTimeMillis() < until) Thread.sleep(100);
        assertTrue("ringing", RipRing.isRinging());
        Thread.sleep(2500);   // ringing for a while, as when Bryan reaches for it
    }

    private static void freshAlarm(Context ctx) {
        ctx.getSharedPreferences("rx_watch_rip_diag", Context.MODE_PRIVATE).edit().remove("at").remove("coin").commit();
    }

    private static android.app.Notification active(Context ctx) {
        android.app.NotificationManager nm = ctx.getSystemService(android.app.NotificationManager.class);
        for (android.service.notification.StatusBarNotification sb : nm.getActiveNotifications()) {
            if (sb.getId() == RipRing.NOTIFICATION_ID) return sb.getNotification();
        }
        return null;
    }

    /** Waits up to ms for silence; logs and checks the whole stop: no sound, no notification, no face icon. */
    private static void expectStopped(Context ctx, String how, long ms) throws Exception {
        long t0 = System.currentTimeMillis();
        while (RipRing.isRinging() && System.currentTimeMillis() - t0 < ms) Thread.sleep(50);
        Thread.sleep(500);
        long took = System.currentTimeMillis() - t0;
        boolean silent = !RipRing.isRinging();
        boolean noNotif = active(ctx) == null;
        boolean noIcon = !RipState.active(ctx);
        android.util.Log.i("RxRipRing", "STOP TEST " + how + ": " + (silent ? "silent" : "STILL RINGING") + " after " + took + " ms, reason \""
            + RipRing.lastStop + "\", notification " + (noNotif ? "gone" : "STILL THERE") + ", face icon " + (noIcon ? "cleared" : "STILL ON"));
        assertTrue(how + ": silent", silent);
        assertTrue(how + ": notification gone", noNotif);
        assertTrue(how + ": face icon cleared", noIcon);
    }

    /** -e how action | swipe | icon | app: the notification's Stop, a swipe, the face's icon, opening the watch app. */
    @Test
    public void stopBy() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String how = InstrumentationRegistry.getArguments().getString("how", "action");
        ringTest(ctx, "4720");
        android.app.Notification n = active(ctx);
        assertNotNull("the alarm's notification", n);
        switch (how) {
            case "action": n.actions[0].actionIntent.send(); break;   // its Stop button
            case "swipe": n.deleteIntent.send(); break;               // swiped away
            case "icon": RipComplication.tap(ctx).send(); break;      // the face's flashing icon
            default: ctx.startActivity(new android.content.Intent(ctx, MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)); break;
        }
        expectStopped(ctx, how, 5000);
    }

    /** Rings and waits: the CI job presses a side button meanwhile (Back or Home on the alarm page, or wakes the screen). */
    @Test
    public void stopByButton() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ringTest(ctx, "4721");
        android.util.Log.i("RxRipRing", "STOP TEST button: ringing, press now");
        expectStopped(ctx, "button", 20_000);
        assertTrue("stopped by a side button", RipRing.lastStop.startsWith("side button"));
    }

    /** The same alarm delivered twice (and a third time over the Data Layer): one ring, one sound. */
    @Test
    public void duplicate() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        int before = RipRing.starts;
        ringTest(ctx, "4722");
        byte[] again = ("{\"coin\":\"TEST\",\"test\":true,\"id\":\"4722\",\"sound\":\"" + SOUND + "\"}").getBytes(StandardCharsets.UTF_8);
        KeyListener.onAlarm(ctx, again);
        com.google.android.gms.wearable.Node local = com.google.android.gms.tasks.Tasks.await(
            com.google.android.gms.wearable.Wearable.getNodeClient(ctx).getLocalNode(), 15, java.util.concurrent.TimeUnit.SECONDS);
        com.google.android.gms.tasks.Tasks.await(com.google.android.gms.wearable.Wearable.getMessageClient(ctx)
            .sendMessage(local.getId(), KeyListener.PATH_ALARM, again), 15, java.util.concurrent.TimeUnit.SECONDS);
        Thread.sleep(4000);
        int rings = RipRing.starts - before;
        android.util.Log.i("RxRipRing", "DUPLICATE TEST: 3 deliveries -> " + rings + " ring(s)");
        assertTrue("one ring for three deliveries", rings == 1);
        RipRing.stopAll(ctx, "test end");
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
