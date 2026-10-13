# Revolut X — Android app

A small Capacitor 8 app that loads the server's app shell (`https://revolut-claude-production.up.railway.app/app`) and adds four native parts to it:
- a fingerprint lock;
- a home-screen widget;
- push notifications;
- proper Back and offline behaviour.

Most changes to the shell ship through the server, with no new APK. The APK only changes when the native side does.

```
mobile/
  capacitor.config.json   appId com.bryan.revolutx, server.url = the live /app shell
  www/index.html          offline page ("No connection to the server" + Retry)
  assets/icon.svg         the shell's /app-icon.svg, the source of the launcher icons
  android/                the native project (committed; `npx cap sync android` refreshes the generated parts)
    app/src/main/java/com/bryan/revolutx/
      MainActivity.java          plugins, Back, offline page, opening a tab from the widget/notifications, push start
      BiometricAuthPlugin.java   Capacitor.Plugins.BiometricAuth.authenticate(...)
      WidgetBridgePlugin.java    Capacitor.Plugins.WidgetBridge.setConfig({ key, base })
      SecureStore.java           EncryptedSharedPreferences (key, base, widget values, push token)
      PortfolioWidget.java       the widget (draws saved values; chip cycles 1D/1W/1M; a tap opens Portfolio)
      SparkChart.java            the widget's line chart, drawn into a Bitmap
      WidgetRefreshWorker.java   WorkManager: GET /api/portfolio/state + /spark every 30 min, on key save, on tap
      Push.java / RxMessagingService.java   FCM token -> POST /api/app/devices; notification display + tab
      RipAlarm.java / RipAlarmService.java / AlarmActivity.java   the rip alarm (v11; v12 rings it on the alarm stream)
      RxFloatPlugin.java / FloatService.java   pop out: the floating window over other apps (v13)
```

## The shell contract

The shell (`APP_SHELL_JS` in `server.js`) runs inside the app's WebView, and Capacitor's bridge is injected into it. Keep these names stable. A change on either side needs the other side to match.

| The shell calls | The app provides |
|---|---|
| `Capacitor.isNativePlatform()` | Capacitor |
| `Capacitor.Plugins.BiometricAuth.authenticate({ reason, cancelTitle, allowDeviceCredential, androidTitle, androidSubtitle })`: resolves on success, rejects on cancel/fail | `BiometricAuthPlugin` (androidx.biometric). If the phone has no fingerprint and no screen lock, it resolves `{ skipped: true }` so the app never locks itself out. |
| `Capacitor.Plugins.WidgetBridge.setConfig({ key, base, watchKey? })` → Promise | `WidgetBridgePlugin`. It stores `key` and `base` in EncryptedSharedPreferences and refreshes the widget. It accepts only `https://revolut-claude-production.up.railway.app` as `base`, so the key never goes anywhere else. Keys are never logged. `watchKey` is the server's watch-only token (shell 625 reads it from `GET /api/watch/key`):<br>• a string: stored and sent to the watch;<br>• `null`: the server has none, so the watch is cleared;<br>• absent (the read failed): the watch is left alone. |
| `Capacitor.Plugins.WidgetBridge.clearConfig()` → Promise | `WidgetBridgePlugin`. Removes the key and the watch key, clears the watch, and leaves the widget on "Open the app to set up". Shell 625 calls it when it starts with no key. |
| `window.rxApp.show('home' \| 'portfolio' \| 'agent' \| 'desk' \| 'more')` | The app calls it after the shell loads, when it was opened by the widget (`portfolio`) or by a notification (`data.tab`, default `home`). |
| `window.rxApp.open({ tab, coin })` (shell 492+) | Called instead of `show` when a notification carries `data.coin` (validated `^[A-Z0-9]{1,15}$`): opens that coin's card. The coin is cleared once delivered; with an older shell the app falls back to `show(tab)`. |
| `window.rxApp.open({ tab: 'inbox', id })` (shell 501+) | Called when a notification carries `data.inbox`, the message's id in the app's notifications feed (validated `^[0-9]{1,15}$`). It opens the feed on that message. A valid id wins over `tab` and `coin`; with an older shell the app falls back to `show('home')`. `inbox` is not a tab the app accepts from `data.tab`. |
| `rxApp.float(path)` / `rxApp.floatOk()` (shell 530+) → `Capacitor.Plugins.RxFloat.available()` / `.open({ path })` | `RxFloatPlugin` + `FloatService` (v13): the floating window over other apps. See [Floating window (pop out)](#floating-window-pop-out). |

**Back button.** When the open tab's frame has moved off its start page, Back goes back inside that frame. Otherwise Back minimises the app. It never exits to a blank page.

**Offline.** When the shell cannot load (no network, or a 502/503/504 from Railway), the app shows `www/index.html`. Its Retry button reloads `/app`.

**Look.** Status and navigation bars are dark (`#0d0d0d`) with light icons.

## The widget

The widget is read-only. It uses the dashboard key (which cannot trade) for reads only:
- `GET /api/portfolio/state`;
- `GET /api/portfolio/spark?range=1d|1w|1m`.

**Default size: 4×2.**
- **Header:** "Revolut X", the whole book (`latest.total`), the change, and "updated HH:MM" (from `latest.ts`), plus "partial" when `latest.partial` is true.
- **Chart:** below the header, a line chart of the chosen range:
  - drawn natively into a Bitmap;
  - 2dp line, green `#00c896` when last ≥ first, red `#ff4d6a` otherwise;
  - a soft gradient under the line and a faint dashed line at the first value;
  - no axes or labels.
- **Range chip:** the "1D 1W 1M" chip in the chart's corner cycles the range. The range is saved per widget.
- **Change in the header:** follows the range. 1D is `latest.total − day.total_then` from `/state`. 1W and 1M use the spark's `change` and `pct`.
- **Taps:** tapping anywhere except the chip opens the app on Portfolio.

**Resized to 4×1:** text only (the header), as in v1.

**Refreshes:**
- every 30 minutes, when there is a network;
- when the shell saves a key;
- when the widget is added or tapped;
- when the range changes.

State and spark are fetched together.

**Size limit:** the bitmap is sized from the widget's current size × screen density, then capped at about 250k pixels (about 1 MB). This keeps RemoteViews well under its limit.

What it shows when something is wrong:

| Situation | Widget shows |
|---|---|
| No key yet | "Open the app to set up" |
| 401 | "Key not accepted - open the app" |
| No network | the last values and points, marked "offline" |
| Spark answers 404 (older server) | no chart, text only |

To add it: long-press the home screen → Widgets → Revolut X.

## The watch (desk #59)

A Galaxy Watch 8 (Wear OS) companion. Two more APKs, built by the same workflow and signed with the same key:

```
android/wear/        revolutx-WATCH-adb-only.apk      applicationId com.bryan.revolutx (the phone app's own), Java
  KeyListener        receives the key from the phone (below)
  WatchStore         the key in EncryptedSharedPreferences; the last numbers in plain private prefs
  Repo               GET /api/watch, the watch's only server call (?coins= for the Tile coins, ?choices=1 for the picker)
  *Tile*, BaseTile   the Tiles: Portfolio (RxTileService), Coin 1-3, Top movers, PM notes
  *Complication      data sources: total, today's P&L, unread PM notes, top mover; the face's band, dot, always-on band
  SparkCard          the one drawing routine for every line: the face's card, the app, the Tiles, the coin screen
  MainActivity       the app: the live card, movers, notes, holdings; a coin opens CoinActivity
  CoinActivity       one coin, live; TileCoinsActivity: the Coin Tiles' picks
android/watchface/   revolutx-WATCHFACE-adb-only.apk  com.bryan.revolutx.watchface, a Watch Face Format v1 face (resources only)
```

**Never open the watch APKs on the phone.** The watch app has the phone app's applicationId, key and versionCode, and Android does not check "watch only" on a sideload, so opening `revolutx-WATCH-adb-only.apk` on a phone *replaces* the phone app (13 Oct). Since then the watch app checks `FEATURE_WATCH`: on a phone it only shows "This is the watch app. On the phone install revolutx-PHONE.apk", and its Tile, complications, key handover and fetch do nothing. To recover: uninstall, install `revolutx-PHONE.apk`, enter the dashboard key once.

**Size.** The watch app's release build is shrunk with R8 (`minifyEnabled`, `shrinkResources`); v15 without it was 13.0 MB, too big for a reliable Wi-Fi ADB push. `wear/proguard-rules.pro` keeps every class the system binds by name (the activities, the Data Layer listener, the Tile and the four complication sources) and what EncryptedSharedPreferences / Tink read by reflection. CI checks each run that those classes are in the merged manifest, kept by name in the R8 mapping and present in the dex, and it uploads the mapping (`watch-mapping.txt`) with the build artifact.

**What it shows.**
- **Tiles** (13 Oct 23:45), each its own - add, remove and order them on the watch:
  - **Portfolio:** the total (cents smaller), the 6-hour line with the dot (still: a Tile cannot animate) and "6 hours −$133.89 (−2.68%)", green or red. No series: today's P&L, no line. Tap: the watch app.
  - **Coin 1, Coin 2, Coin 3:** one coin each - ticker and 24 h %, price, its 24 h line, "held $…", green or red by the 24 h move. Tap: the coin in the watch app. An empty slot says "Tap to choose a coin" and opens the picker for it.
  - **Top movers:** the 5 biggest 24 h moves either way from movers[] and holdings[]. Tap a coin: the coin in the watch app.
  - **PM notes:** the unread count. Tap: the notes on the phone.
  - **Tile coins** (the app's last button, or an empty Coin Tile): three slots, each a list from `GET /api/watch?choices=1` (held coins first, then A-Z). Saved only in the watch app's own prefs; change them any time.
  - **Data:** one read serves every Tile: `GET /api/watch?coins=<the three Tile coins>` adds `coins[]` (batch 630: `price`, `pct_24h`, `usd_held`, a 24 h `spark` of up to 49 prices). A server without it: the coin's numbers from holdings[] / movers[], no line.
- **Face** (14 Oct 00:06, the live line as the hero): the time (medium, white) in the top third; across the middle, edge to edge, the band - the total ("$4,863" + smaller ".98") over the upper part, the thick smoothed 6-hour line with its fill, green `#00ffc8` when the 6 h change is ≥ 0 and red `#ff4d6a` when down, the last point pulsing (an expanding ring, 1.5 s); under it "6h −$133.89 (−2.68%)" in the line's colour and, small, the unread PM notes. Nothing else (old numbers add their time in grey after the change). Always-on: the time and the total in outline, the line as a thin grey outline - no fill, no pulse. On the round screen the line ends at x 392 of 450, so the dot and its ring stay inside the circle at any height.
- **App:** the same top - the time, then the band at the screen's full width, live (below) - then today's P&L, the movers, the PM notes count and a holdings list from `/api/watch`'s `holdings: [{coin, usd, pct}]` (batch 624, numbers only). Tapping a coin opens it on the watch.
- **The band** (face, app, Tiles, coin screen - one routine, `SparkCard`): the line comes from `/api/watch`'s `spark` (batch 628: up to 61 values, oldest first, with `change_usd` / `change_pct`), resampled to 90 points like the dashboard's #507 line. `spark: null` (or an older server): no line, and "Today" with today's P&L instead.
- **How the face does it:** Watch Face Format draws no lines from data, so the watch app draws the band into an image (`CardComplication`; `AmbientCardComplication` for always-on). The dot is the face's own: `DotComplication` (RANGED_VALUE) gives the last point's height and the direction, and the face pulses an ellipse there with WFF's looping animation. Code-based faces are deprecated on Wear OS 6, so the face stays WFF.
- **Why app-v17's face would not apply:** each slot's fallback type was EMPTY; Wear OS's face runtime rejects that ("systemDataSourceFallbackDefaultType EMPTY must be in the supportedTypes list"). Each slot now falls back with its own type. (Google's XML validator does not catch it; CI's emulator job does.)

**Data.** The watch calls one path: `GET https://revolut-claude-production.up.railway.app/api/watch`, with `x-api-token` set to the **watch-only token**. The server accepts that token for this one path and nothing else (desk #59 W6, batch 625). The dashboard key never leaves the phone. Wear OS routes the call through the phone over Bluetooth, or over Wi-Fi. It follows no redirects. When it fails (offline, 5xx), the last numbers stay with "updated HH:MM" and the reason.

**Refresh.**
- **Tiles:** on every swipe to a Tile (a fresh read if the last is over 30 s old - the server's cache), and Wear OS's own schedule (5 min) in between.
- **App:** every 30 s while it is on screen (the server caches 30 s); nothing while the screen is off. A new line slides in over 0.9 s.
- **Face:** every 5 min. That is the floor Wear OS sets for complications; nothing faster is possible without server push. The dot's pulse runs on the watch, continuously (1.5 s), in between.
- **On tap:** at once.
- **Surfaces stay in step:** after any fetch, the Tile and the face redraw from the new numbers.

**The key handover (Fable W1-W8).** "The key" below is the watch-only token, never the dashboard key.
- **Source:** the server holds the watch token as a Railway variable. The shell reads it with the dashboard key (`GET /api/watch/key`) and passes it to `setConfig` as `watchKey`. The phone refuses one that equals its dashboard key.
- **Rotation:** change the variable in Railway and redeploy. The watch then gets a 401 and says hello; the phone re-reads `/api/watch/key` (at most once a minute) and sends the new token. Losing the watch costs one rotation.
- **Channel:** the phone sends the key with Wearable Data Layer *messages* (MessageClient), never a DataItem, so the key is not kept in Play services' synced storage. The Data Layer delivers them only to an app with the same package name and signing key.
- **Messages:**

  | Path | Direction | Payload |
  |---|---|---|
  | `/rx/watch/config` | phone → watch | exactly `{"base","key"}` |
  | `/rx/watch/clear` | phone → watch | empty |
  | `/rx/watch/hello` | watch → phone | empty: "send me the current one" |

- **The watch refuses** any payload that is not exactly those two fields. It also refuses any `base` other than `https://revolut-claude-production.up.railway.app`, and any key that is not one printable token.
- **Storage:** a new key *replaces* the old one (commit), and the last numbers are dropped with it. The key lives only in the watch app's EncryptedSharedPreferences. It is never put in the Tile, a complication, or a log, on either side.
- **When the phone sends:**
  - on each app start: the watch key; or a CLEAR when the server said it has none or the phone has no dashboard key; or nothing when it has not learned one yet (a failed read never clears the watch);
  - on a watch-key change: a CLEAR, then the new key;
  - on `watchKey: null` and on `clearConfig()`: a CLEAR;
  - in answer to the watch's hello, after re-reading `/api/watch/key`.
- **When the watch sends hello:** when it opens (at most every 10 min, so a CLEAR it missed while away still arrives), and when the server refuses its key.
- **CLEAR on the watch** deletes the key and the last numbers.

**Installing on the watch (once; later builds install the same way, over the old one).**
1. **Developer options:** on the watch, open Settings → About watch → Software information. Tap "Software version" 7 times.
2. **Wi-Fi debugging:**
   - Settings → Developer options → turn on ADB debugging, then Wireless debugging.
   - The watch and the computer must be on the same Wi-Fi.
3. **Pair:**
   - Wireless debugging → Pair new device. It shows an IP:port and a 6-digit code.
   - On the computer, with Android platform-tools installed, run `adb pair IP:PORT CODE`.
   - Then run `adb connect IP:PORT`. Use the address shown on the Wireless debugging page itself, not the pairing one.
4. **Install:** download `revolutx-WATCH-adb-only.apk` and `revolutx-WATCHFACE-adb-only.apk` from the same Release as the phone APK (on the computer, not the phone), then run:
   - `adb install -r revolutx-WATCH-adb-only.apk`
   - `adb install -r revolutx-WATCHFACE-adb-only.apk`
5. **Connect:** the server needs the watch token first. In Railway, set it on the server service: random, at least 24 printable characters, different from every other key, never pasted in chat. Then redeploy. Open Revolut X on the phone once: it fetches the watch token and sends it, and the watch app shows the numbers.
6. **Tiles:** swipe left from the face → + → the Revolut X Tile you want (Portfolio, Coin 1-3, Top movers, PM notes). Pick the coins in the app → Tile coins, or tap an empty Coin Tile.
7. **Face:** long-press the face → + → Revolut X face. If a slot is empty, Edit → tap the slot → Revolut X → the matching item: the notes line is "Revolut X: unread PM notes" (the band, the dot and the always-on band are fixed to the Revolut X sources). Wear OS may also ask to allow the face to show Revolut X data.
8. **Turn off Wireless debugging** afterwards; it drains the battery.

The phone APK and the watch APK must come from the same signing key. A test-signed build (Release title "(test signing)") pairs only with other APKs from that same run.

## Build

**CI (the normal way).** `.github/workflows/android.yml` runs on every push to `mobile-app` and on demand (Actions → Android APK → Run workflow). It:
1. runs `npm ci`;
2. runs `npx cap sync android`;
3. checks that nothing in `mobile/` names or holds a key or token (dashboard, family page, watch, or any 32+ character literal in the Java);
4. runs `./gradlew :app:assembleRelease :wear:assembleRelease :watchface:assembleRelease` with `versionCode = github.run_number`;
5. checks the watch APK: every system-bound class is in the merged manifest, kept by name by R8 and in the dex; prints the three APK sizes in the run summary;
   checks the face: no `classes.dex` (a WFF face carries no code; app-v17's face still had one) and `watchface.xml` valid for its format version with Google's validator (google/watchface, pinned);
6. uploads `revolutx-PHONE.apk`, `revolutx-WATCH-adb-only.apk`, `revolutx-WATCHFACE-adb-only.apk` and the watch's R8 mapping as an artifact;
7. on `mobile-app` only, publishes the three APKs as a prerelease **Release** tagged `app-v<run>`. A run on any other branch builds and checks but publishes nothing.
8. on a manual run only, `wear-emulator` (Wear OS 6 and 5 emulators): installs the watch app, applies app-v17's face and the new one with Wear OS's developer broadcast, and prints logcat and small screenshots in the log (`ci/wear-emulator-check.sh`). The emulator never gets a key; a CI-only test (`wear/src/androidTest`, never in a release APK) saves a sample answer instead.

To install on the phone: open the Release page in the phone's browser, download `revolutx-PHONE.apk`, and open it. Allow "install unknown apps" for the browser the first time.

**Locally.** Needs Node 22, JDK 21 and the Android SDK (Android Studio).

```
cd mobile
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

`npx cap open android` opens it in Android Studio.

### Signing (updates install over the previous app)

Android installs an update only if it is signed with the same key as the installed app. CI reads the release key from four repository secrets:
- `ANDROID_KEYSTORE_B64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Until all four exist, each build is signed with a one-off key made in that run. That APK installs, but the next one will not install over it: uninstall first. The Release title then says "(test signing)". After the real key is added, uninstall the test build once. From then on, every build updates in place.

**Creating the key (once): the "Android signing setup (run once)" workflow.** It generates the keystore inside the Actions runner:
- PKCS12, RSA 2048, validity 10000 days, alias `revolutx`;
- random, masked passwords.

It pipes all four values straight into `gh secret set`, prints nothing secret, and deletes the files. It refuses to run if `ANDROID_KEYSTORE_B64` already exists, so the key is never replaced.

It needs a temporary repository secret, `SIGNING_SETUP_TOKEN`: a fine-grained GitHub token for this repository only, with "Secrets: Read and write". Delete the token and the secret afterwards.

Steps:
1. github.com → your picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - Repository access: Only select repositories → `revolut-claude`.
   - Permissions → Repository → Secrets: Read and write.
   - Expiration: 1 day. Generate, then copy the token.
2. The repo → Settings → Secrets and variables → Actions → New repository secret. Name `SIGNING_SETUP_TOKEN`, value: paste the token.
3. The repo → Actions → Android signing setup (run once) → Run workflow → branch `mobile-app` → Run. It should go green.
4. Actions → Android APK → Run workflow → branch `mobile-app`. That Release is the first release-signed build: its title has no "(test signing)".
5. Delete the `SIGNING_SETUP_TOKEN` secret. Then delete the token itself (Developer settings → Fine-grained tokens → Delete).

The key exists only inside GitHub secrets, so nobody holds a copy. If the secrets are ever lost, phones must uninstall once and the setup workflow is run again.

## Notification channels

On Android, sound and vibration belong to the notification channel, not to the message. The server (batch 498) sorts every alert into a category. It applies Bryan's on/off, sound, vibrate and quiet-hours choices from More → Notifications, then picks one of these channels for each push:

| id | name in Android settings | importance | sound | vibration |
|---|---|---|---|---|
| `rx_loud` | Sound and vibrate | HIGH | default notification sound | on |
| `rx_sound` | Sound only | HIGH | default notification sound | off |
| `rx_buzz` | Vibrate only | HIGH | none | on (0, 250, 150, 250 ms) |
| `rx_quiet` | Silent | LOW | none | off |
| `alerts` | Alerts | HIGH | Android default | Android default |
| `info` | Info | DEFAULT | Android default | Android default |

`alerts` and `info` stay for older server messages and older installs. A channel id the app doesn't know is shown on `alerts`.

**Caps contract.** On every start the app registers its token with `POST /api/app/devices`, and the body includes `"caps": "ch2"`. The server sends the `rx_*` channels only to devices registered with `ch2`. Every other device keeps getting `alerts` and `info`. So it doesn't matter whether the app or the server is updated first: opening v8 once is enough. The server also sends `data.cat` (the category id).

**Channel settings are fixed.**
- Once Android has created a channel, the app can't change its sound or vibration. Never reuse these ids with different settings: a new behaviour needs a new id (and a new caps value).
- Changing a channel's sound, vibration or importance in Android's own settings (Settings → Apps → Revolut X → Notifications) overrides the app's choice for that channel. Android keeps that change even when the app updates.

### v10: a channel per alert category (caps `ch3`)

v10 adds one channel per alert category, in the group **Alert categories** (`rx_cats`). The six older channels above go into the group **Other** (`rx_other`) where Android allows it.

| id | name in Android settings | description | importance | sound | vibration |
|---|---|---|---|---|---|
| `rx_c_needs` | Needs you | Approvals, anything held for your confirmation, a failed trade | HIGH | default notification sound | on (Android's pattern) |
| `rx_c_money` | Money moved | Buys and sells filled, card payments, deposits, swaps | HIGH | default notification sound | on (Android's pattern) |
| `rx_c_price` | Price moves | Dips, spikes, pumps, targets and floors hit | HIGH | default notification sound | on (Android's pattern) |
| `rx_c_loops` | Loops & trails | Loops arming, trails, buy-backs, sales held or skipped | HIGH | default notification sound | on (Android's pattern) |
| `rx_c_agent` | Agent & desk | The budget agent and spec-desk messages | HIGH | default notification sound | on (Android's pattern) |
| `rx_c_reports` | Reports | Morning brief, weekly reviews, research | HIGH | default notification sound | on (Android's pattern) |
| `rx_c_system` | System | Backups, restarts, connection problems | HIGH | default notification sound | on (Android's pattern) |

The list of categories lives in one place: `Push.CATS` / `Push.CAT_RE` (`needs|money|price|loops|agent|reports|system`).

**Each category's sound and vibration are Bryan's to set**, on Android's page for that channel (Sound picker with every tone on the phone, Vibration switch). The app only creates the channel with the defaults above and never overrides the user's choice. Calling `createNotificationChannel` again on each start only updates the name and description. These ids are never deleted, re-created or reused with other settings.

**ch3 contract.** The app registers with `"caps": "ch2,ch3"`. For devices with `ch3`, the server (batch 503) sends a push on `rx_c_<category>` whenever that category's Sound is on. Sound off still uses `rx_buzz` / `rx_quiet`, and quiet hours are unchanged. Devices without `ch3` keep the v8 behaviour. The app accepts `rx_c_` + one of the seven ids (shown at high priority); any other unknown id still goes to `alerts`.

**RxNotify contract** (`Capacitor.Plugins.RxNotify`, v10+; the shell checks it exists):

| call | result |
|---|---|
| `channels()` | `{ app_blocked, channels: [ { cat, id, exists, blocked, sound, vibrate } ] }`: 7 rows in the order above (empty below Android 8). `app_blocked`: the app's notifications are off. `exists`: the channel is there (when not: `blocked` false, `sound` "", `vibrate` false). `blocked`: the channel or its group is turned off. `sound`: the tone's name (max 60 chars), "" for no sound, or "Custom sound" when Android can't name it; never the URI. `vibrate`: the channel vibrates. |
| `openChannel({ cat })` | Rejects `"unknown category"` unless `cat` is exactly one of the seven. Makes sure the channels exist, then opens Android's settings page for `rx_c_<cat>` (falling back to the app's notification page, or the app details page below Android 8). Resolves once opened. |

The shell's More → Notifications shows "🔔 <sound> · vibrates  Change ›" per category, calls `openChannel` on Change, and calls `channels()` again when the app comes back to the foreground, so a newly picked sound shows up after Back.

### v11: the rip alarm (caps `alarm`)

When a coin Bryan holds is up 30%+ in 24 h, the server (batch 514) sends **one** alarm per coin per day. The phone rings and vibrates like an alarm clock, through quiet hours and Do Not Disturb.

| id | name in Android settings | description | importance | sound | vibration |
|---|---|---|---|---|---|
| `rx_alarm` | Rip alarm | Rings like an alarm when a coin you hold is up 30%+ in a day | HIGH | the phone's alarm tone (else ringtone, else notification sound), `USAGE_ALARM` | its own pattern: three quick taps then a long buzz, twice (`0, 150, 100, 150, 100, 150, 400, 900, 600, 150, 100, 150, 100, 150, 400, 900`) |

The channel also has `setBypassDnd(true)` (Android honours it only if the app has Do Not Disturb access) and public lock-screen visibility. It is created with the others on every start and is outside the two groups. Same rule as every channel: never deleted, re-created or reused, and its tone is Bryan's to change on Android's page for it (the app never overrides it). `USAGE_ALARM` is what plays it at alarm volume and lets it through Do Not Disturb's default "alarms allowed" rule.

**alarm contract.** The app registers with `"caps": "ch2,ch3,alarm"`. To a device with `alarm` the server sends a **data-only** FCM message (no `notification` block), `android.priority = "high"`, so it always reaches `RxMessagingService.onMessageReceived`, even with the app closed:

```json
{ "alarm": "1", "channel": "rx_alarm", "cat": "needs", "tab": "home", "coin": "AST", "inbox": "12345",
  "title": "🚨 RIP ALARM - AST +46.8% in 24 h", "body": "Now $0.008 - you hold $148.70 of AST. …" }
```

Devices without `alarm` get an ordinary loud notification instead. When `data.alarm` is `"1"` the app handles it before anything else (`RipAlarm.show`) and shows nothing else for that message:
- `coin` must match `^[A-Z0-9]{1,15}$` and `inbox` must be digits, else they are dropped; `title` (max 80 chars) and `body` (max 300) are only ever shown as plain text. Nothing else from the payload reaches an intent.
- A notification on `rx_alarm`: `CATEGORY_ALARM`, `PRIORITY_MAX`, **`FLAG_INSISTENT`** (sound and vibration repeat until it is tapped, stopped or swiped), `setTimeoutAfter(10 min)` (it stops by itself), auto-cancel, one **Stop** button (a broadcast that cancels it, silencing it at once). Id `9000 + (coin.hashCode() & 0xfff)`, so a repeat for the same coin replaces the alarm.
- Tapping it opens the same deep link as any notification (`home`, the coin, the feed id).
- **Full-screen intent** → `AlarmActivity`: over the lock screen, turning the screen on. Dark, big title and body, two buttons: **Open <coin>** (stops the alarm, asks to unlock, then opens the coin's page) and **Stop**. Back is Stop. Native views only: no web content, no network, no JS bridge. It closes itself after 10 minutes.
- If Android refuses the full-screen intent (Android 14+ can ask the user to allow "full-screen notifications" for the app), the heads-up notification still rings with the insistent sound. `RxNotify.channels()` reports this as `full_screen: false` on the alarm row.

**One new permission:** `USE_FULL_SCREEN_INTENT`, so the alarm can take over the screen like an alarm clock (Bryan asked for that). Nothing else was added.

**RxNotify (v11).** `channels()` adds an 8th row after the seven categories: `{ cat: "alarm", id: "rx_alarm", exists, blocked, sound, vibrate, full_screen }` (same meanings as above). `openChannel({ cat: "alarm" })` opens Android's page for `rx_alarm`; the accepted values are exactly the seven category ids plus `alarm`. The server's More → Notifications shows the 🚨 Rip alarm card with "🔔 <tone> · alarm vibration   Change ›" (batch 515).

**Testing it.** The Firebase console's "test message" cannot send data-only messages. Use the server's test path, or FCM HTTP v1 directly (`POST https://fcm.googleapis.com/v1/projects/<project>/messages:send`, a service-account OAuth token in the `Authorization` header, never pasted anywhere) with
`{ "message": { "token": "<device token>", "android": { "priority": "high" }, "data": { "alarm": "1", "title": "🚨 RIP ALARM - TEST +31% in 24 h", "body": "test", "coin": "AST", "inbox": "" } } }`.

### v12: the rip alarm rings through silent mode

v11 rang the alarm as a notification, and the notification system obeys the ringer mode: on silent it made no sound and no vibration (Bryan, 30 Sep: *"I need it to ring through silent mode like my alarms do"*). Clock apps ring through silent because they play the sound themselves on the alarm stream, which the ringer mode does not mute. v12 does the same. The server does not change: it still sends the v11 alarm message above.

| id | name in Android settings | description | importance | sound | vibration |
|---|---|---|---|---|---|
| `rx_alarm_ring` | Rip alarm (screen) | Shows the rip alarm; its sound comes from the Rip alarm tone | HIGH | none | off |

`rx_alarm_ring` also has `setBypassDnd(true)` and public lock-screen visibility. It is created with the others on every start, and again by the service before it posts (in case the app has not been opened since the update). It has no sound because Android fixes a channel's sound when it is created: posting the ringing alarm on `rx_alarm` would play the tone twice whenever the phone is not on silent.

**`rx_alarm` is now the tone picker.** It stays exactly as it was (nothing renamed or re-created), and More → Notifications → Rip alarm → "Change ›" still opens its Android page. The tone picked there is what the alarm plays. Its on/off is still the alarm's on/off: if `rx_alarm` (or `rx_alarm_ring`) is blocked, or notifications are off for the app, the app does not start the service and shows the v11 notification instead (which Android then hides), so it never rings with no way to stop it.

**`RipAlarmService`** (foreground service, `foregroundServiceType="mediaPlayback"`, not exported). `RxMessagingService` hands every `data.alarm = "1"` message to `RipAlarm.show`, which validates it exactly as v11 did and starts the service (a high-priority FCM message may start a foreground service from the background). The service:
1. goes foreground at once with the alarm's notification on `rx_alarm_ring`: title and body, `CATEGORY_ALARM`, `PRIORITY_MAX`, the full-screen intent to `AlarmActivity`, **Stop**, the v11 deep link on tap, `setOngoing(true)`; no `FLAG_INSISTENT` and no `setTimeoutAfter` (the service repeats it and stops it);
2. plays the tone on the **alarm stream** (`MediaPlayer`, `USAGE_ALARM` / `CONTENT_TYPE_SONIFICATION`), looping, at the phone's **alarm volume** (the app never changes a volume). The tone is `rx_alarm`'s sound, else the default alarm, ringtone, then notification sound: the first one that opens. A tone picked from the phone's own files that the app cannot read is played through Android's `Ringtone` (still the alarm stream, looping; Android 9+) before falling back. It holds `AUDIOFOCUS_GAIN_TRANSIENT` with the same attributes while ringing;
3. vibrates the v11 pattern (three quick taps then a long buzz), repeating, as an **alarm vibration** (`VibrationAttributes.USAGE_ALARM` on Android 13+, alarm `AudioAttributes` below), so silent mode does not block it either;
4. stops everything (sound, vibration, audio focus, foreground, notification, alarm screen) on **Stop** (notification or alarm screen), **Open <coin>** or a tap on the notification (then opens the deep link), a **swipe** (`setDeleteIntent`), **Back** on the alarm screen, or **10 minutes** after it started;
5. a new alarm while one rings replaces it: one sound at a time, same notification id per coin as v11.

Every stop goes through `RipAlarm.stop`, which stops the running service directly (same process) and cancels the notification. A tap reaches `MainActivity` with `rx_alarm_stop_id`, which stops the alarm before opening the coin (Android 12+ does not let a receiver or service open an activity after a tap).

**Fallback.** If the service cannot be started (for example `ForegroundServiceStartNotAllowedException`) the app logs the reason (`Log.w`, no payload) and posts the v11 notification on `rx_alarm` (insistent, full-screen, 10-minute timeout). Silent mode then mutes it, as in v11.

**Permissions added in v12:**
- `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_MEDIA_PLAYBACK`: the service is a foreground service, and Android 14+ requires a type and its permission; it only plays the alarm sound.
- `VIBRATE`: in v11 Android vibrated for the channel; now the app vibrates itself, which Android refuses without it (a normal permission, granted at install, no prompt).

`USE_FULL_SCREEN_INTENT` from v11 stays. Nothing is scheduled on the phone (the server sends the alarm), so there is no exact-alarm permission.

## Floating window (pop out)

v13 (server batch 530, desk #37 Option B). A window drawn over **every** app: drag it to move it, and drag its bottom-right corner to resize it from a thumbnail to nearly full screen. It shows a coin's candle chart or one Home widget, read-only.

**The two paths.** The float loads nothing else, and only from the app's own server origin (`Config.BASE`, the host in `capacitor.config.json` `server.url`):

| path | shows |
|---|---|
| `/coin?c=SYM&float=1` | that coin's chart alone, on black, with interval chips and volume |
| `/?app=1&float=<widget-id>` | one Home widget, scaled to the window |

The pages offer **Pop out** in a Home widget's press-and-hold menu and in a coin tile's hold menu, and a **⧉** button on the coin page. The shell calls `rxApp.float(path)`, which calls the plugin below.

**Permission: "Display over other apps"** (`SYSTEM_ALERT_WINDOW`). Android only lets an app draw on top of other apps when the user allows it on Android's own settings page (Settings → Apps → Revolut X → Display over other apps). The app cannot grant it itself, and there is no in-app prompt. The float also runs as a foreground service so Android does not kill it while another app is in front: `FOREGROUND_SERVICE_SPECIAL_USE` (Android 14+ needs a type and its permission; the service's `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` says "Floating read-only price chart the user opened"). `FOREGROUND_SERVICE` was already there from v12. These are the only two permissions v13 adds.

**`Capacitor.Plugins.RxFloat`** (`RxFloatPlugin`, v13+):

| call | result |
|---|---|
| `available()` | `{ ok: true }` on Android 8+ (API 26), else `{ ok: false }`. It does not check the permission. |
| `open({ path })` | Rejects `"that cannot be popped out"` unless `path` matches `^/(\?app=1&float=[a-z-]{1,40}\|coin\?c=[A-Z0-9]{1,15}&float=1)$`. Without the permission it opens Android's "Display over other apps" page for the app (`ACTION_MANAGE_OVERLAY_PERMISSION`, `package:com.bryan.revolutx`) and resolves `{ ok: false, needs_permission: true }`; the page then says *Allow "Display over other apps" for Revolut X, then tap Pop out again.* With it, it starts `FloatService` on `Config.BASE + path` and resolves `{ ok: true }`. If a float is already open, it loads the new path in that window: there is never a second one. |

**`FloatService`** (foreground service, `foregroundServiceType="specialUse"`, not exported). One `TYPE_APPLICATION_OVERLAY` window (`FLAG_NOT_FOCUSABLE | FLAG_LAYOUT_NO_LIMITS | FLAG_LAYOUT_IN_SCREEN` since v14, translucent, top-left gravity): taps outside it go to the app underneath. A rounded dark frame with:
- **a 28 dp top bar**, the drag handle. Dragging it moves the window, kept on screen. **⤢** toggles between the last small size and full; **✕** closes the window and stops the service (its notification goes with it).
- **the WebView**, filling the rest: JavaScript and DOM storage on, the default WebView profile (so `/dashboard-auth.js` finds the dashboard key the app's pages already saved in localStorage; the key is never put in a URL), no Capacitor bridge, no file or content access, no pop-up windows. `shouldOverrideUrlLoading` allows only `https://` on the server host; any other navigation is blocked and not opened. (The page's own scripts still load, e.g. the chart library from jsdelivr/unpkg; only navigations are locked.)
- **a 28 dp resize handle** at the bottom right (◢). Dragging it resizes the window; the WebView relayouts and the pages rescale on `resize`.

**Sizes.** Minimum 160 × 120 dp. "Full" is the screen less the status bar, the navigation bar and a cutout, with an 8 dp margin; the window never goes beyond it. The first time: about 60% of the screen width at 4:3, top right.

**Remembered** (SharedPreferences `rx_float`, no secrets): the last path, x, y, width and height, whether it was full, and the last small size (for ⤢). The window reopens at that size and place, clamped to the current screen. Rotating or folding the phone clamps it back on screen (full stays full).

**v14 (Bryan 1 Oct: the window sat too low and its corner ran off the bottom).** v13's window lacked `FLAG_LAYOUT_IN_SCREEN`, so Android measured `y` from below the status bar while the code already added the status bar: it was counted twice. With the flag, `x`/`y` are absolute screen coordinates: dragging up stops right under the status bar, and full ends just above the gesture bar. After the window appears and after each layout change (a drag: once, on release), it checks where it really is (`getLocationOnScreen`); if a launcher still offsets it by more than 2 px it corrects once and logs `float offset corrected by N px`. On the first open after the update, a place saved by v13 (`rx_float` without `gv`, or `gv < 2`) is dropped once for the first-run default (the path stays) and `gv = 2` is written.

**`window.RxFloatHost.open(coin)`**, the one JS method the float page gets. A tap inside the window calls it with a ticker or `''`. `coin` must match `^[A-Z0-9]{0,15}$`, else it is treated as `''`. It starts `MainActivity` with `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_REORDER_TO_FRONT`, `rx_tab = "home"` and `rx_coin = coin` when there is one: the same path a notification takes, so the app comes to the front on that coin (`rxApp.open({ tab: 'home', coin })`). The float stays open.

**Notification** (while it floats):

| id | name in Android settings | importance | sound | vibration |
|---|---|---|---|---|
| `rx_float` | Floating chart | LOW | none | off |

Text "Revolut X chart is floating" and one action, **Close**, which stops the service. A tap on it opens the app. Created by the service before it posts. Same rule as every channel: never deleted, re-created or reused with other settings.

**Robustness.** If `addView` fails (the permission was revoked), the service stops without posting anything. It is fine for Android to kill it for memory: it does not restart itself (`START_NOT_STICKY`); Pop out opens it again at the remembered size.

**No money.** The float shows two read-only pages. It has no Trade, Sell, Buy or Approve, and it cannot navigate to any other route or origin. v12's rip alarm, notifications, home-screen widget, biometric lock and deep links are unchanged.

## Push notifications

The app side ships in v1 and stays off until Firebase is set up:
- With `google-services.json` present at build time, `BuildConfig.HAS_FCM` is true.
- On each start the app asks for notification permission (Android 13+) and gets the FCM token.
- It sends `POST {base}/api/app/devices` with `{ token, platform: 'android', app_version }` and header `x-api-token`.
- A 404 (the route does not exist yet) is ignored quietly; the app tries again on the next start.
- Channels: **Alerts** (`alerts`, high importance, the default) and **Info** (`info`).
- Tapping a notification opens that message in the app's feed (`data.inbox`, digits). Without one, it opens the tab in `data.tab` (default `home`), on the coin in `data.coin` when it is set.

**What the server sends** (FCM HTTP v1), for when the Dev thread builds the server half:
- `message.notification`: `{ title, body }`;
- `message.data`: `{ tab: 'portfolio' }` (optional);
- `message.android.notification.channel_id`: `'alerts'` or `'info'`.

For data-only messages, put `title`/`body`/`channel` in `data`.

Approve/Reject from a notification is not in v1. Approving needs the full key, which the app does not hold. Approvals stay in Telegram.

**Firebase setup (Bryan, in the browser):**
1. At console.firebase.google.com, create a project "Revolut X".
2. Add an Android app with package `com.bryan.revolutx`.
3. Download `google-services.json` and add it as a GitHub Actions secret. Then run the Android APK workflow again. Use either:
   - `GOOGLE_SERVICES_JSON`: paste the file's contents as they are (easiest from a phone);
   - `GOOGLE_SERVICES_JSON_B64`: the base64 of the file. This one wins if both exist.
4. Project settings → Service accounts → Generate new private key. Put the whole JSON in the Railway variable `FCM_SERVICE_ACCOUNT` on the server service. The server half (device registry + sending) comes from the Dev thread.
