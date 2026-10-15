#!/usr/bin/env bash
# Desk #59, CI only (android.yml's wear-emulator job, on a booted Wear OS emulator). Installs the watch app and the faces,
# applies each face with Wear OS's developer broadcast, and prints what happened: the logcat lines about watch faces and
# complications, and small JPEG screenshots as base64 lines ("IMG <name> <base64>") that a reader can decode. Nothing secret
# is used or printed: the emulator has no key; FaceRenderTest saves a sample answer instead.
#   $1: a folder with revolutx-WATCH-adb-only.apk and revolutx-WATCHFACE-adb-only.apk (this run's release build) and,
#       optionally, face-v17.apk (app-v17's face, the one that would not apply on Bryan's watch).
set -u
REL="$1"
WEAR_DBG=mobile/android/wear/build/outputs/apk/debug/wear-debug.apk
WEAR_TEST=mobile/android/wear/build/outputs/apk/androidTest/debug/wear-debug-androidTest.apk
OUT="$RUNNER_TEMP/wear-shots"
mkdir -p "$OUT"
FACE_ID=com.bryan.revolutx.watchface

shot() {   # shot <name>: a 300 px JPEG of the screen, printed as one base64 line
  adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null
  convert "$OUT/$1.png" -resize 300x300 -quality 70 "$OUT/$1.jpg" 2>/dev/null || cp "$OUT/$1.png" "$OUT/$1.jpg"
  echo "IMG $1 $(base64 -w0 "$OUT/$1.jpg")"
}

logs() {   # logs <title>: what Wear OS said about faces and complications since the last clear
  echo "::group::logcat: $1"
  adb logcat -d -v brief 2>/dev/null \
    | grep -iE 'watchface|watch face|wff|revolutx|complication|AndroidRuntime|FATAL|DEBUG_SURFACE|XmlPull|Parse' \
    | grep -viE 'chatty|GnssLocation' | tail -n 150
  echo "::endgroup::"
}

to_face() {   # the HOME intent shows the watch face (the HOME key toggles to the app list); unplugged, so no charging screen
  adb shell dumpsys battery unplug >/dev/null 2>&1
  adb shell dumpsys battery set status 3 >/dev/null 2>&1
  adb shell cmd statusbar collapse >/dev/null 2>&1   # an open notification list stays over the face otherwise
  adb shell input keyevent KEYCODE_BACK
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1
  sleep 3
  local top
  top=$(adb shell dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//')
  if echo "$top" | grep -qi 'launcher'; then   # still the app list: the HOME key goes back to the face from there
    adb shell input keyevent KEYCODE_HOME
    sleep 3
    top=$(adb shell dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//')
  fi
  echo "on screen: $top"
}

set_face() {   # set_face: Google's documented developer command for a Watch Face Format face
  adb shell am broadcast -a com.google.android.wearable.app.DEBUG_SURFACE --es operation set-watchface --es watchFaceId "$FACE_ID"
  to_face
  sleep 20
  echo "bound watch face services:"
  adb shell dumpsys activity services 2>/dev/null | grep -iE 'ServiceRecord.*(watchface|wff)' | head -n 10
}

runtime_logs() {   # what Google's WFF runtime process said, and every error line, without the system's flavour noise
  echo "::group::WFF runtime: $1"
  local rt
  rt=$(adb shell pidof com.google.wear.watchface.runtime 2>/dev/null | tr -d '\r')
  [ -n "$rt" ] && adb logcat -d --pid="$rt" 2>/dev/null | grep -E 'DWF|Exception|Error|  at ' | grep -vE 'ApkAssets|Model: connect|ModelTime|ModelLanguage' | head -n 160
  echo "-- the watch app (RxWatch):"
  adb logcat -d -s RxWatch 2>/dev/null | tail -n 40
  echo "-- errors:"
  adb logcat -d '*:E' 2>/dev/null | grep -viE 'fitbit|ApkAssets|IntentReceiverLeaked|unregisterReceiver|ActivityThread' | tail -n 40
  echo "::endgroup::"
}

echo "== device: $(adb shell getprop ro.build.version.release) / API $(adb shell getprop ro.build.version.sdk), $(adb shell wm size)"
adb shell settings put system screen_off_timeout 600000 >/dev/null 2>&1
adb shell svc power stayon true >/dev/null 2>&1

echo "== 1. the release watch app (R8) starts"
adb install -r "$REL/revolutx-WATCH-adb-only.apk" || { echo "::error::the release watch app did not install"; exit 1; }
adb logcat -c
adb shell am start -W -n com.bryan.revolutx/com.bryan.revolutx.wear.MainActivity
sleep 6
shot app-release-nokey
if adb logcat -d | grep -q "FATAL EXCEPTION"; then logs "release app crash"; echo "::error::the release watch app crashed"; fi
adb uninstall com.bryan.revolutx >/dev/null

echo "== 2. the debug watch app, with a sample answer saved (no key)"
adb install -r "$WEAR_DBG" && adb install -r "$WEAR_TEST" || { echo "::error::the debug watch app did not install"; exit 1; }
adb shell am instrument -w -e class com.bryan.revolutx.wear.FaceRenderTest#renderCardsAndSeed com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner
for f in card-face-up card-face-down card-face-nospark card-face-nokey card-face-ambient card-app-down tile-line-sol tile-candles-sol; do
  adb exec-out run-as com.bryan.revolutx cat "files/ci/$f.png" > "$OUT/$f.png" 2>/dev/null
  convert "$OUT/$f.png" -background black -flatten -quality 80 "$OUT/$f.jpg" 2>/dev/null || cp "$OUT/$f.png" "$OUT/$f.jpg"
  echo "IMG $f $(base64 -w0 "$OUT/$f.jpg")"
done

if [ -f "$REL/face-v17.apk" ]; then
  echo "== 3. app-v17's face"
  adb install -r "$REL/face-v17.apk" && {
    adb logcat -c
    set_face
    shot face-v17
    runtime_logs "app-v17 face"
    adb uninstall "$FACE_ID" >/dev/null
  }
fi

echo "== 4. this build's face"
adb install -r "$REL/revolutx-WATCHFACE-adb-only.apk" || { echo "::error::the face did not install"; exit 1; }
adb logcat -c
set_face
shot face-new-a
sleep 0.5
shot face-new-b   # the dot's ring grows and fades over 1.5 s: a, b and c catch it at different sizes
sleep 0.5
shot face-new-c
adb shell settings put system time_12_24 24 >/dev/null 2>&1   # the 24 h clock too
sleep 3
shot face-new-24h
adb shell settings put system time_12_24 12 >/dev/null 2>&1
runtime_logs "this build's face"

echo "== 5. always-on"
adb shell settings put global ambient_enabled 1 >/dev/null 2>&1
adb shell svc power stayon false >/dev/null 2>&1
adb shell input keyevent KEYCODE_SLEEP
sleep 5
shot face-ambient
adb shell input keyevent KEYCODE_WAKEUP
adb shell svc power stayon true >/dev/null 2>&1
sleep 2

echo "== 5b. the same face with the 6 h line rising (green)"
adb shell am instrument -w -e class com.bryan.revolutx.wear.FaceRenderTest#seedUp com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner
sleep 12
to_face
shot face-up
adb shell svc power stayon false >/dev/null 2>&1
adb shell input keyevent KEYCODE_SLEEP
sleep 5
shot face-up-ambient
adb shell input keyevent KEYCODE_WAKEUP
adb shell svc power stayon true >/dev/null 2>&1
sleep 2
adb shell am instrument -w -e class com.bryan.revolutx.wear.FaceRenderTest#renderCardsAndSeed com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner >/dev/null   # back to the red sample
sleep 5

echo "== 6. the watch app's card (live: pulsing dot)"
adb shell am start -W -n com.bryan.revolutx/com.bryan.revolutx.wear.MainActivity
sleep 4
shot app-card
logs "watch app"

echo "== 7. the Tiles (Wear OS's developer broadcast: add-tile, show-tile)"
to_face
adb logcat -c
n=0
for t in RxTileService CoinTile1 CoinTile2 CoinTile3 MoversTileService NotesTileService; do
  r=$(adb shell am broadcast -a com.google.android.wearable.app.DEBUG_SURFACE --es operation add-tile \
        --ecn component "com.bryan.revolutx/com.bryan.revolutx.wear.$t" 2>&1)
  echo "add $t: $r" | tr '\n' ' '; echo
  idx=$(echo "$r" | grep -oE 'Index=\[[0-9]+\]' | grep -oE '[0-9]+' | head -1)
  [ -z "$idx" ] && idx=$n
  n=$((n + 1))
  echo "show $t: $(adb shell am broadcast -a com.google.android.wearable.app.DEBUG_SYSUI --es operation show-tile --ei index "$idx" 2>&1 | tail -1)"
  sleep 6
  shot "tile-$t"
  adb shell am broadcast -a com.google.android.wearable.app.DEBUG_SURFACE --es operation remove-tile \
    --ecn component "com.bryan.revolutx/com.bryan.revolutx.wear.$t" >/dev/null 2>&1
  adb shell input keyevent KEYCODE_HOME
  sleep 1
done
logs "tiles"

echo "== 8. a Coin Tile's screen and the Tile coins picker"
adb shell am start -W -n com.bryan.revolutx/com.bryan.revolutx.wear.CoinActivity --es coin SOL
sleep 4
shot app-coin
adb shell am start -W -n com.bryan.revolutx/com.bryan.revolutx.wear.TileCoinsActivity
sleep 3
shot app-tilecoins
adb shell am start -W -n com.bryan.revolutx/com.bryan.revolutx.wear.NotesActivity
sleep 4
shot app-notes
adb shell input tap 227 150   # the newest note
sleep 2
shot app-note

echo "== 9. the Rip alarm on the watch, with Do Not Disturb on (desk #59, 15 Oct)"
adb shell pm grant com.bryan.revolutx android.permission.POST_NOTIFICATIONS >/dev/null 2>&1
adb shell cmd notification set_dnd priority
echo "zen_mode (1 = DND on): $(adb shell settings get global zen_mode)"
to_face
adb logcat -c
adb shell svc power stayon false >/dev/null 2>&1
adb shell input keyevent KEYCODE_SLEEP   # wrist down, as an alarm usually finds the watch: the alarm opens full screen
sleep 3
adb shell am instrument -w -e class com.bryan.revolutx.wear.RipAlarmTest#ring com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner > "$OUT/rip-test.txt" 2>&1 &
TEST=$!
sleep 5
shot rip-alarm
echo "-- on screen: $(adb shell dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity' | sed 's/^ *//')"
echo "-- the watch app's ring log:"
adb logcat -d -s RxRipRing 2>/dev/null | tail -n 8
echo "-- audio playing on the alarm stream:"
adb shell dumpsys audio 2>/dev/null | grep -iE "USAGE_ALARM" | head -n 6
echo "-- our notification:"
adb shell dumpsys notification --noredact 2>/dev/null | grep -iE "NotificationRecord.*revolutx|android.title=" | head -n 6
echo "-- vibrating:"
adb shell dumpsys vibrator_manager 2>/dev/null | grep -iE "alarm" | head -n 4
adb shell svc power stayon true >/dev/null 2>&1
adb shell input keyevent KEYCODE_WAKEUP
adb shell input keyevent KEYCODE_BACK
sleep 1
adb shell input swipe 227 420 227 80 300   # the notification list
sleep 2
shot rip-notification
wait $TEST
echo "-- the test (rings at 6 s, silent after 36 s):"
grep -E "OK \(|FAIL|Assertion|Error" "$OUT/rip-test.txt" | head -n 5
echo "-- audio on the alarm stream now (expect none started):"
adb shell dumpsys audio 2>/dev/null | grep -iE "USAGE_ALARM" | grep -i started | head -n 3
shot rip-after
adb shell cmd notification set_dnd off

echo "== 10. the face's flashing Rip alarm icon (15 Oct 13:20)"
on_second() {   # wait until the watch clock's second is even (0, icon on) or odd (1, icon off): the face blinks on [SECOND] % 2
  local i=0
  while [ $(( 10#$(adb shell date +%S | tr -d '\r') % 2 )) -ne "$1" ] && [ $i -lt 20 ]; do sleep 0.2; i=$((i+1)); done
  sleep 0.3
}
face_awake() {   # a screen-off/on round closes any notification list or alarm page and wakes on the face
  to_face
  adb shell svc power stayon false >/dev/null 2>&1
  adb shell input keyevent KEYCODE_SLEEP
  sleep 3
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell svc power stayon true >/dev/null 2>&1
  sleep 2
  echo "-- on screen: $(adb shell dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity' | sed 's/^ *//')"
}
face_awake
sleep 3
on_second 0
shot rip-face-test-a     # the TEST alarm above: the ticker in a green circle, flashing
on_second 1
shot rip-face-test-b
adb shell am instrument -w -e class com.bryan.revolutx.wear.RipAlarmTest#ripIconWithLogo com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner > "$OUT/rip-icon.txt" 2>&1 &
ICON=$!
sleep 6
face_awake
sleep 1
on_second 0
shot rip-face-logo-a     # a real coin: its logo from the phone, flashing
on_second 1
shot rip-face-logo-b
adb shell svc power stayon false >/dev/null 2>&1
adb shell input keyevent KEYCODE_SLEEP
sleep 5
shot rip-face-logo-ambient
adb shell input keyevent KEYCODE_WAKEUP
adb shell svc power stayon true >/dev/null 2>&1
wait $ICON
grep -E "OK \(|FAIL" "$OUT/rip-icon.txt" | head -n 3
adb logcat -d -s RxRipRing 2>/dev/null | grep -iE "flashes|cleared" | tail -n 4
adb shell am instrument -w -e class com.bryan.revolutx.wear.RipAlarmTest#clearRip com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner >/dev/null

echo "== 11. the TEST alarm over the real Data Layer, and the app's 'Last rip alarm' line (15 Oct 14:56)"
adb logcat -c
adb shell am instrument -w -e class com.bryan.revolutx.wear.RipAlarmTest#viaDataLayer com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner > "$OUT/rip-dl.txt" 2>&1
grep -E "OK \(|FAIL|Assertion|Exception" "$OUT/rip-dl.txt" | head -n 5
adb logcat -d -s RxRipRing 2>/dev/null | tail -n 8
adb shell am start -W -n com.bryan.revolutx/.wear.MainActivity >/dev/null 2>&1
sleep 4
shot app-rip-line
adb shell pm revoke com.bryan.revolutx android.permission.POST_NOTIFICATIONS 2>/dev/null   # what the line says when the watch blocks it
adb shell pm set-permission-flags com.bryan.revolutx android.permission.POST_NOTIFICATIONS user-fixed 2>/dev/null   # no prompt
adb shell am instrument -w -e class com.bryan.revolutx.wear.RipAlarmTest#viaDataLayer com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner >/dev/null 2>&1
adb shell am start -W -n com.bryan.revolutx/.wear.MainActivity >/dev/null 2>&1
sleep 3
adb shell input keyevent KEYCODE_BACK   # the app asks for notifications again: declined, as a watch that blocks them
sleep 2
adb shell am start -W -n com.bryan.revolutx/.wear.MainActivity >/dev/null 2>&1
sleep 3
shot app-rip-line-error
adb shell pm clear-permission-flags com.bryan.revolutx android.permission.POST_NOTIFICATIONS user-fixed 2>/dev/null
adb shell pm grant com.bryan.revolutx android.permission.POST_NOTIFICATIONS 2>/dev/null
adb shell am instrument -w -e class com.bryan.revolutx.wear.RipAlarmTest#clearRip com.bryan.revolutx.test/androidx.test.runner.AndroidJUnitRunner >/dev/null

if adb logcat -d | grep -q "FATAL EXCEPTION"; then logs "crash"; echo "::error::the watch app crashed"; fi
exit 0
