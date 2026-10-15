package com.bryan.revolutx.wear;

import android.util.Log;
import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.wearable.ChannelClient;
import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.Wearable;
import java.util.concurrent.TimeUnit;
import com.google.android.gms.wearable.WearableListenerService;

/**
 * Desk #59 W1/W2: the phone app's key handover (its WatchBridge). Messages only, never a DataItem. The Data Layer delivers
 * them only from an app with this same package name and signing key on the paired phone.
 *   /rx/watch/config  exactly {"base","key"}; anything else, or a base that is not WatchStore.BASE, is refused
 *   /rx/watch/clear   the key and the last values are deleted
 *   /rx/watch/alarm   desk #59 (15 Oct): the Rip alarm, {"coin","pct","price","id","sound"} - rung here by RipRing
 *   /rx/watch/sound/<id>  a channel: the audio of the phone's Rip alarm tone (kept, the newest only)
 * Nothing about the key is logged.
 */
public class KeyListener extends WearableListenerService {

    static final String PATH_CONFIG = "/rx/watch/config";
    static final String PATH_CLEAR = "/rx/watch/clear";
    static final String PATH_ALARM = "/rx/watch/alarm";
    static final String PATH_SOUND = "/rx/watch/sound/";

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
        } else if (PATH_ALARM.equals(path)) {
            onAlarm(this, event.getData());
        } else if (PATH_CLEAR.equals(path)) {
            synchronized (Repo.LOCK) {
                WatchStore.clear(this);
            }
            Repo.notifySurfaces(this, Repo.FROM_KEY);
        }
    }

    /** /rx/watch/alarm from the phone (WatchAlarm): read, logged, rung. CI's RipAlarmTest calls this with the phone's bytes. */
    static void onAlarm(android.content.Context ctx, byte[] data) {
        RipRing.Alarm a = data == null ? null : RipRing.Alarm.parse(data);
        Log.i("RxRipRing", "received the Rip alarm from the phone: " + (a == null ? "unreadable, ignored" : a.coin));
        if (a == null) return;
        RipState.start(ctx, a);   // the face flashes the coin's icon for 60 min (RipComplication)
        RipRing.ring(ctx, a);
    }

    /** The phone's Rip alarm tone (WatchAlarm), on its own channel: kept for RipRing. */
    @Override
    public void onChannelOpened(ChannelClient.Channel channel) {
        if (!OnWatch.is(this)) return;
        String path = channel.getPath();
        if (path == null || !path.startsWith(PATH_SOUND)) return;
        String id = path.substring(PATH_SOUND.length());
        ChannelClient cc = Wearable.getChannelClient(this);
        try {
            RipRing.keepSound(this, id, Tasks.await(cc.getInputStream(channel), 10, TimeUnit.SECONDS));
        } catch (Exception e) {
            Log.w("RxRipRing", "tone not received: " + e.getClass().getSimpleName());
        } finally {
            cc.close(channel);
        }
    }
}
