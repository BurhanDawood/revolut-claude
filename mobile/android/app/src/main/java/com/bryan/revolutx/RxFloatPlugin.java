package com.bryan.revolutx;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * v13 (batch 530): pop out. The shell's rxApp.float(path) calls
 *   Capacitor.Plugins.RxFloat.available()      → { ok }: Android 8+ (the overlay window type needs it)
 *   Capacitor.Plugins.RxFloat.open({ path })   → { ok: true } once FloatService shows (or reloads) the floating window;
 *                                                { ok: false, needs_permission: true } after opening Android's
 *                                                "Display over other apps" page for the app
 * Only the two float paths below are accepted, and only ever on the app's own server origin (Config.BASE).
 */
@CapacitorPlugin(name = "RxFloat")
public class RxFloatPlugin extends Plugin {

    /** A coin's chart alone (/coin?c=SYM&float=1) or one Home widget (/?app=1&float=<widget-id>). Nothing else. */
    static final String PATH_RE = "^/(\\?app=1&float=[a-z-]{1,40}|coin\\?c=[A-Z0-9]{1,15}&float=1)$";

    @PluginMethod
    public void available(PluginCall call) {
        JSObject out = new JSObject();
        out.put("ok", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O);
        call.resolve(out);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String path = call.getString("path");
        if (path == null || !path.matches(PATH_RE) || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("that cannot be popped out");
            return;
        }
        Context ctx = getContext();
        JSObject out = new JSObject();
        if (!Settings.canDrawOverlays(ctx)) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName()));
            try {
                if (getActivity() != null) getActivity().startActivity(allow);
                else ctx.startActivity(allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                call.reject("cannot open the Display over other apps setting");
                return;
            }
            out.put("ok", false);
            out.put("needs_permission", true);
            call.resolve(out);
            return;
        }
        try {
            FloatService.open(ctx, Config.BASE + path);
        } catch (Exception e) {
            call.reject("the floating window could not start");
            return;
        }
        out.put("ok", true);
        call.resolve(out);
    }
}
