package com.bryan.revolutx.wear;

import android.content.Context;
import android.content.pm.PackageManager;

/**
 * Desk #59 install guard. This APK has the phone app's applicationId and key, and Android's installer does not enforce
 * uses-feature type.watch on a sideload, so tapping it on a phone replaces the phone app (13 Oct). On anything that is not
 * a watch every entry point does nothing: the app shows PHONE_HINT, the Tile shows it, complications give no data, the
 * key handover and the fetch are skipped.
 */
final class OnWatch {

    static final String PHONE_HINT = "This is the watch app. On the phone install revolutx-PHONE.apk";

    private OnWatch() {}

    static boolean is(Context ctx) {
        try {
            return ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_WATCH);
        } catch (Exception e) {
            return false;
        }
    }
}
