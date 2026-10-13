package com.bryan.revolutx;

import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.WearableListenerService;

/**
 * Desk #59: answers the watch app's hello (it asks on its start and when the server refuses its key) with the current
 * key or a clear. Only our own watch app can send it (same package, same signing key). Nothing is logged.
 */
public class WatchListener extends WearableListenerService {

    @Override
    public void onMessageReceived(MessageEvent event) {
        if (WatchBridge.PATH_HELLO.equals(event.getPath())) WatchBridge.sendCurrent(getApplicationContext(), event.getSourceNodeId());
    }
}
