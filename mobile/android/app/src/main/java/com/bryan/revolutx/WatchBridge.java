package com.bryan.revolutx;

import android.content.Context;
import com.google.android.gms.wearable.CapabilityClient;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Desk #59 W1/W2: hands the dashboard key to the Revolut X watch app over the Wearable Data Layer.
 *
 * Messages only (MessageClient), never a DataItem, so the key is not kept in Play services' synced storage on either side.
 * The Data Layer delivers them only to an app with this same package name and signing key on a paired watch.
 *   /rx/watch/config  payload exactly {"base","key"}; base is always Config.BASE (the watch refuses any other)
 *   /rx/watch/clear   empty: the watch deletes its key and its last values
 *   /rx/watch/hello   watch -> phone, empty: "send me the current one" (WatchListener answers with config or clear)
 * Sent on each phone-app start (config, or clear when there is no key), on a key change (clear, then the new config) and
 * on removal (clear). Each config replaces the watch's one key; nothing is appended. The key is never logged.
 */
final class WatchBridge {

    static final String CAP_WATCH = "rx_watch";   // declared by the watch app (wear/src/main/res/values/wear.xml)
    static final String PATH_CONFIG = "/rx/watch/config";
    static final String PATH_CLEAR = "/rx/watch/clear";
    static final String PATH_HELLO = "/rx/watch/hello";

    private WatchBridge() {}

    /** Phone-app start: the current key, or a clear when there is none. */
    static void sync(Context ctx) {
        Context app = ctx.getApplicationContext();
        eachWatch(app, node -> sendCurrent(app, node));
    }

    /** The shell saved a different key: clear first, then the new one. */
    static void keyChanged(Context ctx) {
        Context app = ctx.getApplicationContext();
        eachWatch(app, node ->
            Wearable.getMessageClient(app).sendMessage(node, PATH_CLEAR, new byte[0])
                .addOnCompleteListener(t -> sendCurrent(app, node))
        );
    }

    /** The key was removed. */
    static void cleared(Context ctx) {
        Context app = ctx.getApplicationContext();
        eachWatch(app, node -> Wearable.getMessageClient(app).sendMessage(node, PATH_CLEAR, new byte[0]));
    }

    /** One watch: the key as it is now, or a clear. Also WatchListener's answer to a hello. */
    static void sendCurrent(Context app, String node) {
        byte[] payload = configPayload(app);
        if (payload == null) Wearable.getMessageClient(app).sendMessage(node, PATH_CLEAR, new byte[0]);
        else Wearable.getMessageClient(app).sendMessage(node, PATH_CONFIG, payload);
    }

    /** {"base","key"}, or null without a key. */
    private static byte[] configPayload(Context app) {
        try {
            String key = SecureStore.key(app);
            if (key == null || key.isEmpty()) return null;
            return new JSONObject().put("base", Config.BASE).put("key", key).toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;   // storage unavailable: treated as no key
        }
    }

    private interface NodeAction {
        void run(String nodeId);
    }

    /**
     * Every reachable watch that has the Revolut X watch app. No watch, no Wear OS app or no Play services: the Task fails and
     * nothing is sent. Any node that can reach us with a hello also gets the key: the real gate is the Data Layer's rule that
     * only an app with this same package name AND signing certificate can send to us or receive from us.
     */
    private static void eachWatch(Context app, NodeAction action) {
        Wearable.getCapabilityClient(app).getCapability(CAP_WATCH, CapabilityClient.FILTER_REACHABLE)
            .addOnSuccessListener(info -> {
                for (Node n : info.getNodes()) action.run(n.getId());
            })
            .addOnFailureListener(e -> { /* no watch reachable: the watch's hello asks again later */ });
    }
}
