package com.bryan.revolutx;

import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import java.lang.ref.WeakReference;

/**
 * v11: the rip alarm's full-screen page, shown over the lock screen by the notification's full-screen intent.
 * Plain native views: no web content, no network, no JS bridge. "Open <coin>" and "Stop" both cancel the notification
 * (which stops the sound at once); Back is Stop. It closes by itself when the alarm times out (10 minutes).
 */
public class AlarmActivity extends AppCompatActivity {

    private static WeakReference<AlarmActivity> showing = new WeakReference<>(null);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private int alarmId;
    private String coin;
    private String inbox;

    /** Closes the alarm screen for this alarm if it is open (the notification's Stop button). */
    static void finishShowing(int id) {
        AlarmActivity a = showing.get();
        if (a != null && a.alarmId == id && !a.isFinishing()) a.finish();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                stopAlarm();
            }
        });
        bind(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);   // a newer alarm replaces the one on screen
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (showing.get() == this) showing = new WeakReference<>(null);
        super.onDestroy();
    }

    private void bind(Intent in) {
        alarmId = in.getIntExtra(RipAlarm.EXTRA_ID, RipAlarm.notificationId(""));
        coin = in.getStringExtra(MainActivity.EXTRA_COIN);
        if (coin == null || !coin.matches(MainActivity.COIN_RE)) coin = "";
        inbox = in.getStringExtra(MainActivity.EXTRA_INBOX);
        if (inbox == null || !inbox.matches(MainActivity.INBOX_RE)) inbox = "";
        String title = in.getStringExtra(RipAlarm.EXTRA_TITLE);
        String body = in.getStringExtra(RipAlarm.EXTRA_BODY);
        showing = new WeakReference<>(this);
        setContentView(buildView(title == null ? "🚨 RIP ALARM" : title, body == null ? "" : body));
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::finish, RipAlarm.TIMEOUT_MS);
    }

    private LinearLayout buildView(String title, String body) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xFF0D0D0D);
        int pad = dp(28);
        root.setPadding(pad, pad, pad, pad);

        TextView t = new TextView(this);
        t.setText(title);
        t.setTextColor(0xFFFFFFFF);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        root.addView(t, row());

        TextView b = new TextView(this);
        b.setText(body);
        b.setTextColor(0xFFCCCCCC);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        b.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams bl = row();
        bl.topMargin = dp(20);
        bl.bottomMargin = dp(48);
        root.addView(b, bl);

        root.addView(button(coin.isEmpty() ? "Open app" : "Open " + coin, 0xFF00FFC8, 0xFF0D0D0D, v -> openCoin()), row());
        LinearLayout.LayoutParams sl = row();
        sl.topMargin = dp(16);
        root.addView(button("Stop", 0xFFE5484D, 0xFFFFFFFF, v -> stopAlarm()), sl);
        return root;
    }

    private Button button(String label, int bg, int fg, android.view.View.OnClickListener onClick) {
        Button btn = new Button(this);
        btn.setText(label);
        btn.setAllCaps(false);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setTextColor(fg);
        GradientDrawable d = new GradientDrawable();
        d.setColor(bg);
        d.setCornerRadius(dp(18));
        btn.setBackground(d);
        btn.setMinHeight(dp(80));
        btn.setOnClickListener(onClick);
        return btn;
    }

    private void stopAlarm() {
        RipAlarm.stop(this, alarmId);   // cancels the notification (silences it) and finishes this screen
    }

    private void openCoin() {
        RipAlarm.stop(this, alarmId);
        final Intent open = RipAlarm.openIntent(this, coin, inbox);
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km != null && km.isKeyguardLocked()) {
            // ask to unlock first, then open the coin's page
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    startActivity(open);
                    finish();
                }

                @Override
                public void onDismissCancelled() {
                    finish();
                }

                @Override
                public void onDismissError() {
                    startActivity(open);
                    finish();
                }
            });
            return;
        }
        startActivity(open);
        finish();
    }

    private LinearLayout.LayoutParams row() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
