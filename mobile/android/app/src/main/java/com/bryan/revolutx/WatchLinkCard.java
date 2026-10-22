package com.bryan.revolutx;

import android.content.Context;
import android.webkit.WebView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Desk #59 (Bryan 15 Oct 14:56): adds the "Watch link" block (assets/watch-link.js, RxWatchPlugin) to the shell's Rip alarm
 * card, after each load of the shell. App only: the shell itself (the server's page) is unchanged.
 */
final class WatchLinkCard {

    private static String js;

    private WatchLinkCard() {}

    static void install(Context ctx, WebView wv) {
        String s = script(ctx);
        if (s != null) wv.evaluateJavascript(s, null);
    }

    private static synchronized String script(Context ctx) {
        if (js != null) return js;
        try (InputStream in = ctx.getAssets().open("watch-link.js")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            js = out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            js = null;
        }
        return js;
    }
}
