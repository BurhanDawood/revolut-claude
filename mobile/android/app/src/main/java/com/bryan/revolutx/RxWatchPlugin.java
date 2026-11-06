package com.bryan.revolutx;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Desk #59 (Bryan 15 Oct 14:56): the Rip alarm card's "Watch link" line (WatchLinkCard puts it under "Change ›"), because the
 * watch's own log cannot be read while it is on Bluetooth.
 *   Capacitor.Plugins.RxWatch.status()   → { nodes: [ { name, id, nearby, app } ], error?, last: { at, path, ok, result, to } | null }
 *   Capacitor.Plugins.RxWatch.sendTest() → the same, after a TEST Rip alarm went straight to the watch over MessageClient
 *                                          (WatchAlarm.send, the FCM handler's own path, without the server)
 * Nothing is written to the server; the test alarm carries the coin "TEST" and nothing else.
 */
@CapacitorPlugin(name = "RxWatch")
public class RxWatchPlugin extends Plugin {

    static final String TEST_TITLE = "🚨 RIP ALARM - TEST (not a real move)";   // what the server's test alarm (#523) sends

    @PluginMethod
    public void status(PluginCall call) {
        Context app = getContext().getApplicationContext();
        new Thread(() -> call.resolve(status(app)), "rx-watch-status").start();
    }

    @PluginMethod
    public void sendTest(PluginCall call) {
        Context app = getContext().getApplicationContext();
        new Thread(() -> {
            Map<String, String> data = new HashMap<>();
            data.put("alarm", "1");
            data.put("coin", "");
            data.put("title", TEST_TITLE);
            data.put("body", "This is a test of the rip alarm. Nothing moved and nothing trades.");
            WatchAlarm.send(app, data);
            call.resolve(status(app));
        }, "rx-watch-test").start();
    }

    static JSObject status(Context app) {
        JSObject out = new JSObject();
        try {
            out.put("nodes", WatchAlarm.nodesJson(app));
        } catch (Exception e) {
            out.put("nodes", new JSONArray());
            out.put("error", WatchAlarm.why(e));
        }
        JSONObject last = WatchAlarm.last(app);
        out.put("last", last == null ? JSONObject.NULL : last);
        return out;
    }
}
