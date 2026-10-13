package com.bryan.revolutx;

import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Called by the shell as Capacitor.Plugins.WidgetBridge.setConfig({ key, base }) whenever it has a
 * checked dashboard key. Stores both for the widget (and push registration), then refreshes the widget. A changed key also
 * goes to the watch app (WatchBridge). The key is never logged.
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
        if (changed) {
            Push.registerSavedToken(getContext());
            WatchBridge.keyChanged(getContext());   // desk #59: the watch drops the old key and takes this one
        }
        call.resolve();
    }

    /**
     * Desk #59 W2: Capacitor.Plugins.WidgetBridge.clearConfig() when the shell drops its key. Removes the key here, tells the
     * watch to delete its copy, and leaves the widget on "Open the app to set up".
     */
    @PluginMethod
    public void clearConfig(PluginCall call) {
        SecureStore.get(getContext()).edit().remove(SecureStore.KEY).apply();
        WatchBridge.cleared(getContext());
        WidgetRefreshWorker.refreshNow(getContext());
        call.resolve();
    }
}
