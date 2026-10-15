#!/usr/bin/env bash
# Desk #59 (Bryan 15 Oct 14:56), CI only (android.yml's phone-emulator job, on a booted phone emulator with Play services).
# The server's test Rip alarm push goes to the app's FCM service with the app not running (force-stopped first, then put on
# the temporary allow-list as a high-priority push does); the job prints the watch forward's record (the Rip alarm card's
# "Watch link" line), the RxWatchAlarm log, whether the phone rang, and a screenshot ("IMG <name> <base64>" lines).
# No key and no server: the emulator never signs in. No watch is paired here, so the forward ends at "no watch found".
set -u
APP=mobile/android/app/build/outputs/apk/debug/app-debug.apk
TEST=mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
OUT="$RUNNER_TEMP/phone-shots"
mkdir -p "$OUT"
shot() {
  adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null
  convert "$OUT/$1.png" -resize 360x -quality 70 "$OUT/$1.jpg" 2>/dev/null || cp "$OUT/$1.png" "$OUT/$1.jpg"
  echo "IMG $1 $(base64 -w0 "$OUT/$1.jpg")"
}
adb install -r "$APP" && adb install -r "$TEST" || { echo "::error::install failed"; exit 1; }
adb shell pm grant com.bryan.revolutx android.permission.POST_NOTIFICATIONS
echo "== Play services on this phone: $(adb shell dumpsys package com.google.android.gms 2>/dev/null | grep -m1 versionName | sed 's/^ *//')"
adb shell am force-stop com.bryan.revolutx   # the app is not running, as when Android has killed it
adb shell input keyevent KEYCODE_HOME
adb logcat -c
adb shell cmd deviceidle tempwhitelist -d 60000 com.bryan.revolutx
echo "== the server's test Rip alarm push -> the FCM service (no app screen open)"
adb shell am instrument -w -e class com.bryan.revolutx.FcmToWatchTest com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner > "$OUT/test.txt" 2>&1 &
T=$!
sleep 8
shot phone-ringing
echo "-- audio on the alarm stream:"
adb shell dumpsys audio 2>/dev/null | grep -iE "USAGE_ALARM" | grep -i started | head -n 3
wait $T
grep -E "OK \(|FAIL|Assertion|Error|Exception" "$OUT/test.txt" | head -n 8
echo "-- the app's log (RxWatchAlarm):"
adb logcat -d -s RxWatchAlarm:* 2>/dev/null | tail -n 20
if adb logcat -d | grep -q "FATAL EXCEPTION"; then adb logcat -d | grep -A20 "FATAL EXCEPTION" | head -n 40; echo "::error::the phone app crashed"; fi
exit 0
