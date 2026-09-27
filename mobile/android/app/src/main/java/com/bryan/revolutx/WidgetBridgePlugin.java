package com.bryan.revolutx;

import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Called by the shell as Capacitor.Plugins.WidgetBridge.setConfig({ key, base }) whenever it has a
 * checked dashboard key. Stores both for the widget (and push registration), then refreshes the widget.
 * The key is never logged.
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    @PluginMethod
    public void setConfig(PluginCall call) {
        String key = call.getString("key");
        String base = call.getString("base", Config.BASE);
        if (key == null || key.trim().isEmpty()) {
            call.reject("key missing");
            return;
        }
        Uri u = Uri.parse(base);
        if (!"https".equals(u.getScheme()) || !Config.HOST.equalsIgnoreCase(u.getHost())) {
            call.reject("base must be the app's own server");   // the key only ever goes to our server
            return;
        }
        String b = "https://" + u.getHost();
        boolean changed = !key.trim().equals(SecureStore.key(getContext())) || !b.equals(SecureStore.base(getContext()));
        SecureStore.get(getContext()).edit().putString(SecureStore.KEY, key.trim()).putString(SecureStore.BASE, b).apply();
        WidgetRefreshWorker.schedule(getContext());
        WidgetRefreshWorker.refreshNow(getContext());
        if (changed) Push.registerSavedToken(getContext());
        call.resolve();
    }
}
