package com.bryan.revolutx;

import static org.junit.Assert.assertNotNull;

import android.content.Context;
import android.content.Intent;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Desk #59 (Bryan 15 Oct 14:56), CI only, on a phone emulator: the server's test Rip alarm push, handed to the app's FCM
 * service through Firebase's own entry, FirebaseMessagingService.handleIntent (what Firebase's receiver calls on its
 * background thread; a plain startService is ignored by Firebase), as the com.google.android.c2dm.intent.RECEIVE intent Firebase passes on, with the
 * push's data as extras, with no app screen open (the job force-stops the app first). The service must ring and run the
 * watch forward itself; the forward's record is the card's "Watch link" line. CI has no watch paired, so the expected record
 * is "no watch found" (or Play services' reason), not "sent".
 */
@RunWith(AndroidJUnit4.class)
public class FcmToWatchTest {

    @Test
    public void testPushRunsTheWatchForward() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ctx.getSharedPreferences("rx_watch_link", Context.MODE_PRIVATE).edit().clear().commit();
        // exactly the data the server sends for send_test_alarm (#523, appPushSend's alarm message)
        Intent i = new Intent("com.google.android.c2dm.intent.RECEIVE").setClass(ctx, RxMessagingService.class)
            .putExtra("from", "1234567890")
            .putExtra("google.message_id", "0:ci-" + System.currentTimeMillis())
            .putExtra("google.delivered_priority", "high")
            .putExtra("google.original_priority", "high")
            .putExtra("google.sent_time", System.currentTimeMillis())
            .putExtra("google.ttl", 600)
            .putExtra("alarm", "1").putExtra("tab", "home").putExtra("coin", "").putExtra("channel", "rx_alarm")
            .putExtra("cat", "needs").putExtra("inbox", "4711")
            .putExtra("title", RxWatchPlugin.TEST_TITLE)
            .putExtra("body", "This is a test of the rip alarm. Nothing moved and nothing trades. Tap Stop or swipe it away.");
        Fcm fcm = new Fcm(ctx);
        fcm.handleIntent(i);   // Firebase's dispatch -> RxMessagingService.onMessageReceived, on this (background) thread
        JSONObject last = null;
        for (int t = 0; t < 120 && last == null; t++) {
            Thread.sleep(250);
            last = WatchAlarm.last(ctx);
        }
        Log.i("RxWatchAlarm", "FCM test push -> watch forward record: " + last);
        Log.i("RxWatchAlarm", "Watch link status: " + RxWatchPlugin.status(ctx));
        assertNotNull("the FCM service ran the watch forward and recorded it", last);
        Thread.sleep(4000);   // the CI job looks at the ringing phone meanwhile
        RipAlarm.stop(ctx, RipAlarm.notificationId(""));
    }

    /** The app's FCM service with the app's context, as Android would create it for Firebase. */
    static final class Fcm extends RxMessagingService {
        Fcm(Context ctx) {
            attachBaseContext(ctx);
        }
    }
}
