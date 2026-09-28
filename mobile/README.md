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
```

## The shell contract

The shell (`APP_SHELL_JS` in `server.js`) runs inside the app's WebView, and Capacitor's bridge is injected into it. Keep these names stable. A change on either side needs the other side to match.

| The shell calls | The app provides |
|---|---|
| `Capacitor.isNativePlatform()` | Capacitor |
| `Capacitor.Plugins.BiometricAuth.authenticate({ reason, cancelTitle, allowDeviceCredential, androidTitle, androidSubtitle })`: resolves on success, rejects on cancel/fail | `BiometricAuthPlugin` (androidx.biometric). If the phone has no fingerprint and no screen lock, it resolves `{ skipped: true }` so the app never locks itself out. |
| `Capacitor.Plugins.WidgetBridge.setConfig({ key, base })` → Promise | `WidgetBridgePlugin`. It stores both in EncryptedSharedPreferences and refreshes the widget. It accepts only `https://revolut-claude-production.up.railway.app` as `base`, so the key never goes anywhere else. The key is never logged. |
| `window.rxApp.show('home' \| 'portfolio' \| 'agent' \| 'desk' \| 'more')` | The app calls it after the shell loads, when it was opened by the widget (`portfolio`) or by a notification (`data.tab`, default `home`). |
| `window.rxApp.open({ tab, coin })` (shell 492+) | Called instead of `show` when a notification carries `data.coin` (validated `^[A-Z0-9]{1,15}$`): opens that coin's card. The coin is cleared once delivered; with an older shell the app falls back to `show(tab)`. |

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

## Build

**CI (the normal way).** `.github/workflows/android.yml` runs on every push to `mobile-app` and on demand (Actions → Android APK → Run workflow). It:
1. runs `npm ci`;
2. runs `npx cap sync android`;
3. runs `./gradlew assembleRelease` with `versionCode = github.run_number`;
4. uploads `app-release.apk` as an artifact;
5. publishes it as a prerelease **Release** tagged `app-v<run>`.

To install on the phone: open the Release page in the phone's browser, download `app-release.apk`, and open it. Allow "install unknown apps" for the browser the first time.

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

**Caps contract.** On every start the app registers its token with `POST /api/app/devices`, and the body includes `"caps": "ch2"`. The server sends the `rx_*` channels only to devices registered with `ch2`. Every other device keeps getting `alerts` and `info`. So it doesn't matter whether the app or the server is updated first: opening v8 once is enough. The server also sends `data.cat` (the category id), which the app doesn't use yet.

**Channel settings are fixed.**
- Once Android has created a channel, the app can't change its sound or vibration. Never reuse these ids with different settings: a new behaviour needs a new id (and a new caps value).
- Changing a channel's sound, vibration or importance in Android's own settings (Settings → Apps → Revolut X → Notifications) overrides the app's choice for that channel. Android keeps that change even when the app updates.

## Push notifications

The app side ships in v1 and stays off until Firebase is set up:
- With `google-services.json` present at build time, `BuildConfig.HAS_FCM` is true.
- On each start the app asks for notification permission (Android 13+) and gets the FCM token.
- It sends `POST {base}/api/app/devices` with `{ token, platform: 'android', app_version }` and header `x-api-token`.
- A 404 (the route does not exist yet) is ignored quietly; the app tries again on the next start.
- Channels: **Alerts** (`alerts`, high importance, the default) and **Info** (`info`).
- Tapping a notification opens the tab in `data.tab` (default `home`), on the coin in `data.coin` when it is set.

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
