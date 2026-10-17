package com.bryan.revolutx;

import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.WearableListenerService;

/**
 * Desk #59: answers the watch app's hello (it asks on its start and when the server refuses its key): re-reads the watch-only
 * key from the server (W7, a rotation), then sends it, or a clear. Only our own watch app can send it (same package, same
 * signing key). Runs on the listener's background thread. Nothing is logged.
 */
public class WatchListener extends WearableListenerService {

    @Override
    public void onMessageReceived(MessageEvent event) {
        if (WatchBridge.PATH_HELLO.equals(event.getPath())) WatchBridge.answerHello(getApplicationContext(), event.getSourceNodeId());
    }
}
