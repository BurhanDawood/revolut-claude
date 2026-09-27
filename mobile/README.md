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
      PortfolioWidget.java       the widget (draws saved values; a tap opens Portfolio)
      WidgetRefreshWorker.java   WorkManager: GET /api/portfolio/state every 30 min, on key save, on tap
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

**Back button.** When the open tab's frame has moved off its start page, Back goes back inside that frame. Otherwise Back minimises the app. It never exits to a blank page.

**Offline.** When the shell cannot load (no network, or a 502/503/504 from Railway), the app shows `www/index.html`. Its Retry button reloads `/app`.

**Look.** Status and navigation bars are dark (`#0d0d0d`) with light icons.

## The widget

The widget is read-only. It uses the dashboard key (which cannot trade) for one read, `GET /api/portfolio/state`, and shows:
- the whole book, `latest.total`;
- the change against `day.total_then`, as ▲/▼ $ and %;
- "updated HH:MM", from `latest.ts`;
- "partial" when `latest.partial` is true.

It refreshes every 30 minutes (when there is a network), when the shell saves a key, when the widget is added, and when it is tapped.

What it shows when something is wrong:

| Situation | Widget shows |
|---|---|
| No key yet | "Open the app to set up" |
| 401 | "Key not accepted - open the app" |
| No network | the last values, marked "offline" |

To add it: long-press the home screen → Widgets → Revolut X. It is 4×1 and can be resized to 4×2.

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

Until all four exist, each build is signed with a one-off key made in that run. That APK installs fine, but the next one will not install over it: uninstall first. The Release title then says "(test signing)". After the real key is added, uninstall the test build once. From then on, every build updates in place.

To make the key (once, on a trusted computer, never in a chat):

```
keytool -genkeypair -v -keystore revolutx.keystore -storetype PKCS12 -alias revolutx -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 revolutx.keystore > revolutx.keystore.b64      # macOS: base64 -i revolutx.keystore -o revolutx.keystore.b64
```

Then add the four secrets in GitHub → the repo → Settings → Secrets and variables → Actions:
- `ANDROID_KEYSTORE_B64` = the contents of the `.b64` file;
- the two passwords;
- the alias `revolutx`.

Keep a private backup of the keystore and its passwords: a lost key means every phone must uninstall once. Never commit it. `*.jks`, `*.keystore` and `google-services.json` are git-ignored.

## Push notifications

The app side ships in v1 and stays off until Firebase is set up:
- With `google-services.json` present at build time, `BuildConfig.HAS_FCM` is true.
- On each start the app asks for notification permission (Android 13+) and gets the FCM token.
- It sends `POST {base}/api/app/devices` with `{ token, platform: 'android', app_version }` and header `x-api-token`.
- A 404 (the route does not exist yet) is ignored quietly; the app tries again on the next start.
- Channels: **Alerts** (`alerts`, high importance, the default) and **Info** (`info`).
- Tapping a notification opens the tab in `data.tab` (default `home`).

**What the server sends** (FCM HTTP v1), for when the Dev thread builds the server half:
- `message.notification`: `{ title, body }`;
- `message.data`: `{ tab: 'portfolio' }` (optional);
- `message.android.notification.channel_id`: `'alerts'` or `'info'`.

For data-only messages, put `title`/`body`/`channel` in `data`.

Approve/Reject from a notification is not in v1. Approving needs the full key, which the app does not hold. Approvals stay in Telegram.

**Firebase setup (Bryan, in the browser):**
1. At console.firebase.google.com, create a project "Revolut X".
2. Add an Android app with package `com.bryan.revolutx`.
3. Download `google-services.json`. Base64 it (`base64 -w0 google-services.json`, or on macOS `base64 -i google-services.json`). Add the result as the GitHub Actions secret `GOOGLE_SERVICES_JSON_B64`. Then run the Android APK workflow again.
4. Project settings → Service accounts → Generate new private key. Put the whole JSON in the Railway variable `FCM_SERVICE_ACCOUNT` on the server service. The server half (device registry + sending) comes from the Dev thread.
