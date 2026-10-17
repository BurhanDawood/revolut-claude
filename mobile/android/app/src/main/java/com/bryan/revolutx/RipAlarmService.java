package com.bryan.revolutx;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;

/**
 * v12: rings the rip alarm through silent mode, like a clock app. The notification system obeys the ringer mode; the
 * alarm stream does not. So this foreground service (type mediaPlayback) plays the tone Bryan picked for rx_alarm
 * itself, on the alarm stream at the phone's alarm volume, looping, and vibrates the rip-alarm pattern as an alarm
 * vibration. Its notification is on the silent rx_alarm_ring, so the tone never plays twice.
 * It stops (sound, vibration, audio focus, foreground, notification) on Stop, Open, a tap, a swipe, Back on AlarmActivity
 * (all through RipAlarm.stop) or 10 minutes after it started. A new alarm replaces the ringing one. Not exported.
 */
public class RipAlarmService extends Service {

    static final String ACTION_RING = "com.bryan.revolutx.ALARM_RING";
    private static final String TAG = "RipAlarmService";

    static final AudioAttributes ALARM_ATTRS = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build();

    /** The running service (same process, main thread only), so RipAlarm.stop silences it at once. */
    private static RipAlarmService running;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable timeout = this::stopAlarm;
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        // an alarm keeps ringing whatever else wants the audio, as the clock app does
    };
    private MediaPlayer player;
    private Ringtone ringtone;
    private Vibrator vibrator;
    private AudioFocusRequest focusRequest;
    private boolean hasFocus;
    private int alarmId = -1;

    /** Stops the ringing alarm, if any. Called on the main thread (receiver, activities). */
    static void stopRinging() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            new Handler(Looper.getMainLooper()).post(RipAlarmService::stopRinging);
            return;
        }
        if (running != null) running.stopAlarm();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !ACTION_RING.equals(intent.getAction())) {
            if (alarmId == -1) stopSelf(startId);
            return START_NOT_STICKY;
        }
        // RipAlarm.show validated these already; checked again because this is what reaches the intents
        String coin = intent.getStringExtra(MainActivity.EXTRA_COIN);
        if (coin == null || !coin.matches(MainActivity.COIN_RE)) coin = "";
        String inbox = intent.getStringExtra(MainActivity.EXTRA_INBOX);
        if (inbox == null || !inbox.matches(MainActivity.INBOX_RE)) inbox = "";
        String title = intent.getStringExtra(RipAlarm.EXTRA_TITLE);
        if (title == null || title.isEmpty()) title = coin.isEmpty() ? "🚨 RIP ALARM" : "🚨 RIP ALARM - " + coin;
        String body = intent.getStringExtra(RipAlarm.EXTRA_BODY);
        if (body == null) body = "";
        int id = RipAlarm.notificationId(coin);

        // 1. foreground straight away, on the silent channel
        ensureRingChannel();
        Notification n = RipAlarm.ringingNotification(this, id, title, body, coin, inbox);
        try {
            ServiceCompat.startForeground(
                this, id, n, Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0
            );
        } catch (Exception e) {
            Log.w(TAG, "could not go foreground, showing the v11 notification: " + e.getClass().getSimpleName());
            stopAlarm();
            RipAlarm.showNotification(this, id, title, body, coin, inbox);
            stopSelf();
            return START_NOT_STICKY;
        }
        running = this;

        // 5. a new alarm replaces the ringing one: one sound at a time, the older notification and screen go
        int previous = alarmId;
        silence();
        if (previous != -1 && previous != id) {
            NotificationManagerCompat.from(this).cancel(previous);
            AlarmActivity.finishShowing(previous);
        }
        alarmId = id;

        // 2. sound and 3. vibration, 4. stopped after 10 minutes if nothing else stops it
        requestFocus();
        playTone();
        vibrate();
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, RipAlarm.TIMEOUT_MS);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(timeout);
        silence();
        if (running == this) running = null;
        super.onDestroy();
    }

    /** Everything off: sound, vibration, audio focus, foreground, the notification and the alarm screen. */
    void stopAlarm() {
        handler.removeCallbacks(timeout);
        silence();
        int id = alarmId;
        alarmId = -1;
        if (running == this) running = null;
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
            // not foreground
        }
        if (id != -1) {
            NotificationManagerCompat.from(this).cancel(id);
            AlarmActivity.finishShowing(id);
        }
        stopSelf();
    }

    private void ensureRingChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        try {
            nm.createNotificationChannel(MainActivity.alarmRingChannel());   // a no-op when it exists
        } catch (Exception ignored) {
            // leave it as it is
        }
    }

    // ── sound ──

    /** The tone Bryan picked for rx_alarm, else the default alarm, ringtone, notification sound: the first that plays. */
    private void playTone() {
        Uri picked = channelTone();
        if (play(picked) || playRingtone(picked)) return;
        for (int type : new int[] { RingtoneManager.TYPE_ALARM, RingtoneManager.TYPE_RINGTONE, RingtoneManager.TYPE_NOTIFICATION }) {
            if (play(RingtoneManager.getDefaultUri(type))) return;
        }
        Log.w(TAG, "no tone could be played; vibrating only");
    }

    private Uri channelTone() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel c = nm != null ? nm.getNotificationChannel(Push.CHANNEL_ALARM) : null;
        return c != null ? c.getSound() : null;
    }

    /** MediaPlayer on the alarm stream, looping. False (and nothing left open) when this tone cannot be played. */
    private boolean play(Uri uri) {
        if (uri == null) return false;
        MediaPlayer p = new MediaPlayer();
        try {
            p.setAudioAttributes(ALARM_ATTRS);
            p.setDataSource(this, uri);
            p.setLooping(true);
            p.prepare();
            p.start();
            player = p;
            return true;
        } catch (Exception e) {
            Log.w(TAG, "tone not playable, trying the next: " + e.getClass().getSimpleName());
            p.release();
            return false;
        }
    }

    /**
     * A tone picked from the phone's own files may not be readable by the app (no storage permission). Android's
     * Ringtone then plays it through the system, still on the alarm stream and looping (Android 9+).
     */
    private boolean playRingtone(Uri uri) {
        if (uri == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false;
        try {
            Ringtone r = RingtoneManager.getRingtone(this, uri);
            if (r == null) return false;
            r.setAudioAttributes(ALARM_ATTRS);
            r.setLooping(true);
            r.play();
            ringtone = r;
            return true;
        } catch (Exception e) {
            Log.w(TAG, "tone not playable as a ringtone either: " + e.getClass().getSimpleName());
            return false;
        }
    }

    private void requestFocus() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(ALARM_ATTRS)
                .setOnAudioFocusChangeListener(focusListener, handler)
                .build();
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(focusListener, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
        hasFocus = true;
    }

    private void abandonFocus() {
        if (!hasFocus) return;
        hasFocus = false;
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
            focusRequest = null;
        } else {
            am.abandonAudioFocus(focusListener);
        }
    }

    // ── vibration ──

    /** The rip-alarm pattern, repeating from the start, as an alarm vibration so silent mode does not block it. */
    @SuppressWarnings("deprecation")
    private void vibrate() {
        Vibrator v;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = (VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
            v = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        }
        if (v == null || !v.hasVibrator()) return;
        long[] pattern = MainActivity.ALARM_VIBRATION;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                v.vibrate(
                    VibrationEffect.createWaveform(pattern, 0),
                    VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM)
                );
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createWaveform(pattern, 0), ALARM_ATTRS);
            } else {
                v.vibrate(pattern, 0, ALARM_ATTRS);
            }
            vibrator = v;
        } catch (Exception e) {
            Log.w(TAG, "could not vibrate: " + e.getClass().getSimpleName());
        }
    }

    /** Sound, vibration and audio focus off; the service and its notification stay. */
    private void silence() {
        if (player != null) {
            try {
                player.stop();
            } catch (Exception ignored) {
                // not started
            }
            player.release();
            player = null;
        }
        if (ringtone != null) {
            try {
                ringtone.stop();
            } catch (Exception ignored) {
                // already stopped
            }
            ringtone = null;
        }
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
        abandonFocus();
    }
}
