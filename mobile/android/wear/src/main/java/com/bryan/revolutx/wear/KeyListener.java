package com.bryan.revolutx.wear;

import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.WearableListenerService;

/**
 * Desk #59 W1/W2: the phone app's key handover (its WatchBridge). Messages only, never a DataItem. The Data Layer delivers
 * them only from an app with this same package name and signing key on the paired phone.
 *   /rx/watch/config  exactly {"base","key"}; anything else, or a base that is not WatchStore.BASE, is refused
 *   /rx/watch/clear   the key and the last values are deleted
 * Nothing about the key is logged.
 */
public class KeyListener extends WearableListenerService {

    static final String PATH_CONFIG = "/rx/watch/config";
    static final String PATH_CLEAR = "/rx/watch/clear";

    @Override
    public void onMessageReceived(MessageEvent event) {
        if (!OnWatch.is(this)) return;   // the watch APK on a phone by mistake: no key is taken
        String path = event.getPath();
        if (PATH_CONFIG.equals(path)) {
            byte[] data = event.getData();
            if (data == null) return;
            synchronized (Repo.LOCK) {
                if (!WatchStore.acceptConfig(this, data)) return;
            }
            Repo.refresh(this, 0, Repo.FROM_KEY);   // runs on the listener's own background thread
        } else if (PATH_CLEAR.equals(path)) {
            synchronized (Repo.LOCK) {
                WatchStore.clear(this);
            }
            Repo.notifySurfaces(this, Repo.FROM_KEY);
        }
    }
}
