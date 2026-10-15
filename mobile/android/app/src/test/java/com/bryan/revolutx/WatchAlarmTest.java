package com.bryan.revolutx;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Desk #59 (15 Oct 13:14): what the phone forwards to the watch for each Rip alarm push - the exact data the server sends
 * (appPushSend's alarm message, server.js), through WatchAlarm.payload, the phone handler's own decision.
 */
public class WatchAlarmTest {

    private static Map<String, String> push(String coin, String title, String body, String inbox) {
        Map<String, String> d = new HashMap<>();   // { alarm, tab, coin, channel, cat, inbox, title, body }
        d.put("alarm", "1");
        d.put("tab", "home");
        d.put("coin", coin);
        d.put("channel", "rx_alarm");
        d.put("cat", "needs");
        d.put("inbox", inbox);
        d.put("title", title);
        d.put("body", body);
        return d;
    }

    /** send_test_alarm (#523): no coin, a TEST title. v35 dropped it (no coin); now it goes as coin TEST, no numbers. */
    @Test
    public void serverTestAlarmIsForwarded() {
        JSONObject o = WatchAlarm.payload(push("", "🚨 RIP ALARM - TEST (not a real move)",
            "This is a test of the rip alarm. Nothing moved and nothing trades. Tap Stop or swipe it away.", "4711"));
        assertNotNull(o);
        assertEquals("TEST", o.optString("coin"));
        assertTrue(o.optBoolean("test"));
        assertFalse(o.has("pct"));
        assertFalse(o.has("price"));
        assertEquals("4711", o.optString("id"));
        System.out.println("test push -> watch: " + o);
    }

    @Test
    public void realAlarmCarriesCoinAndNumbers() {
        JSONObject o = WatchAlarm.payload(push("SOL", "🚨 RIP ALARM - SOL +34.2% in 24 h",
            "Now $182.40 - you hold $912.00 of SOL. Tap to open SOL's page.", "4712"));
        assertNotNull(o);
        assertEquals("SOL", o.optString("coin"));
        assertEquals(34.2, o.optDouble("pct"), 1e-9);
        assertEquals(182.40, o.optDouble("price"), 1e-9);
        assertFalse(o.optBoolean("test"));
        System.out.println("real push -> watch: " + o);
    }

    @Test
    public void noCoinAndNotATestIsNotForwarded() {
        assertNull(WatchAlarm.payload(push("", "🚨 RIP ALARM", "", "")));
    }
}
