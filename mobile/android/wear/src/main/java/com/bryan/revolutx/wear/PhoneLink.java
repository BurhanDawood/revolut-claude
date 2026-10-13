package com.bryan.revolutx.wear;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.wear.remote.interactions.RemoteActivityHelper;
import com.google.android.gms.wearable.CapabilityClient;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/** The two things the watch asks of the phone: "send me the key" (hello) and "open the dashboard". Neither carries data. */
final class PhoneLink {

    static final String CAP_PHONE = "rx_phone";   // declared by the phone app (app/src/main/res/values/wear.xml)
    static final String PATH_HELLO = "/rx/watch/hello";

    static final long HELLO_START_MS = 10 * 60_000;   // app start: the phone re-confirms (a CLEAR it missed arrives here)
    static final long HELLO_NOKEY_MS = 60_000;
    static final long HELLO_BADKEY_MS = 5 * 60_000;
    static final long HELLO_RECHECK_MS = 60 * 60_000;   // Tile/face use without opening the app: a missed CLEAR within the hour

    private static final Executor REMOTE = Executors.newSingleThreadExecutor();

    private PhoneLink() {}

    /** Asks the phone app for its current key (it answers with config or clear), at most once per minMs. */
    static void helloAtMost(Context ctx, long minMs) {
        Context app = ctx.getApplicationContext();
        long now = System.currentTimeMillis();
        if (now - WatchStore.values(app).getLong(WatchStore.V_HELLO, 0) < minMs) return;
        WatchStore.values(app).edit().putLong(WatchStore.V_HELLO, now).apply();
        try {
            Wearable.getCapabilityClient(app).getCapability(CAP_PHONE, CapabilityClient.FILTER_REACHABLE)
                .addOnSuccessListener(info -> {
                    for (Node n : info.getNodes()) Wearable.getMessageClient(app).sendMessage(n.getId(), PATH_HELLO, new byte[0]);
                });
        } catch (Exception ignored) {
            // no phone reachable: the next start or refresh asks again
        }
    }

    /** Opens the Revolut X phone app on a tab (and coin), through its revolutx://open link. */
    static void openOnPhone(Context ctx, String tab, String coin) {
        String uri = "revolutx://open/" + (tab != null && tab.matches("home|portfolio|agent|desk|more") ? tab : "portfolio");
        if (coin != null && coin.matches("[A-Z0-9]{1,15}")) uri += "?coin=" + coin;
        Intent i = new Intent(Intent.ACTION_VIEW).addCategory(Intent.CATEGORY_BROWSABLE).setData(Uri.parse(uri));
        try {
            new RemoteActivityHelper(ctx.getApplicationContext(), REMOTE).startRemoteActivity(i, null);
        } catch (Exception ignored) {
            // no phone connected
        }
    }
}
