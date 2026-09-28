package com.bryan.revolutx;

import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * v10 (batch 503). Called by the shell's More → Notifications screen:
 *   Capacitor.Plugins.RxNotify.channels()          → { app_blocked, channels: [ { cat, id, exists, blocked, sound, vibrate } ] }
 *   Capacitor.Plugins.RxNotify.openChannel({ cat }) → opens Android's own settings page for rx_c_<cat>
 * Each category's sound and vibration belong to the user (Android's page); the app only reads them. A sound's name is
 * returned, never its URI, and nothing is logged. The only value from JS that reaches an intent is a validated cat.
 */
@CapacitorPlugin(name = "RxNotify")
public class RxNotifyPlugin extends Plugin {

    private static final int MAX_SOUND_NAME = 60;

    @PluginMethod
    public void channels(PluginCall call) {
        Context ctx = getContext();
        JSObject out = new JSObject();
        out.put("app_blocked", !NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        JSArray list = new JSArray();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            for (String cat : Push.CATS) {
                String id = Push.CHANNEL_CAT_PREFIX + cat;
                NotificationChannel ch = nm != null ? nm.getNotificationChannel(id) : null;
                JSObject row = new JSObject();
                row.put("cat", cat);
                row.put("id", id);
                row.put("exists", ch != null);
                row.put("blocked", ch != null && isBlocked(nm, ch));
                row.put("sound", ch != null ? soundName(ctx, ch.getSound()) : "");
                row.put("vibrate", ch != null && ch.shouldVibrate());
                list.put(row);
            }
        }
        out.put("channels", list);
        call.resolve(out);
    }

    @PluginMethod
    public void openChannel(PluginCall call) {
        String cat = call.getString("cat");
        if (cat == null || !cat.matches(Push.CAT_RE)) {
            call.reject("unknown category");
            return;
        }
        Context ctx = getContext();
        String pkg = ctx.getPackageName();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                MainActivity.ensureChannels(ctx);
                Intent channel = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, Push.CHANNEL_CAT_PREFIX + cat);
                try {
                    start(channel);
                } catch (ActivityNotFoundException e) {
                    start(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg));
                }
            } else {
                start(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null)));
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("cannot open notification settings");
        }
    }

    private void start(Intent i) {
        if (getActivity() != null) {
            getActivity().startActivity(i);
        } else {
            getContext().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }

    /** The channel is off, or (Android 9+) its whole group is. */
    private static boolean isBlocked(NotificationManager nm, NotificationChannel ch) {
        if (ch.getImportance() == NotificationManager.IMPORTANCE_NONE) return true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && ch.getGroup() != null) {
            try {
                NotificationChannelGroup g = nm.getNotificationChannelGroup(ch.getGroup());
                return g != null && g.isBlocked();
            } catch (Exception ignored) {
                return false;
            }
        }
        return false;
    }

    /** The sound's display name: "" for none, "Custom sound" when Android cannot name it. Never the URI. */
    private static String soundName(Context ctx, Uri uri) {
        if (uri == null) return "";
        try {
            Ringtone r = RingtoneManager.getRingtone(ctx, uri);
            String t = r != null ? r.getTitle(ctx) : null;
            if (t == null || t.trim().isEmpty()) return "Custom sound";
            t = t.trim();
            return t.length() > MAX_SOUND_NAME ? t.substring(0, MAX_SOUND_NAME) : t;
        } catch (Exception e) {   // includes SecurityException for a sound the app may not read
            return "Custom sound";
        }
    }
}
