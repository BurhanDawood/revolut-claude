package com.bryan.revolutx.wear;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Desk #59 (Bryan 14 Oct 14:01): "PM notes" on the watch - the newest 8 (notes[], batch 632), unread ones with a dot; tap one to
 * read its whole body, scrolled with the crown. Read-only: no marking, no proposal buttons (those stay on the phone). The notes
 * come with the summary read; this screen only asks for a fresh one when it opens.
 */
public class NotesActivity extends Activity {

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private ScrollView scroll;
    private LinearLayout list;
    private int open = -1;   // the note being read, or -1 for the list

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!OnWatch.is(this)) {
            Toast.makeText(this, OnWatch.PHONE_HINT, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF000000);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = Math.round(getResources().getDisplayMetrics().widthPixels * 0.12f);
        list.setPadding(pad, pad, pad, pad * 2);
        scroll.addView(list);
        setContentView(scroll);
        render();
        EXEC.execute(() -> {
            Repo.refresh(getApplicationContext(), Repo.AGE_APP, Repo.FROM_APP);
            main.post(() -> {
                if (!isFinishing() && !isDestroyed()) render();
            });
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (scroll != null) scroll.requestFocus();   // the crown scrolls
    }

    private void render() {
        list.removeAllViews();
        Snapshot s = WatchStore.snapshot(this);
        if (s != null && open >= 0 && open < s.notes.size()) {
            note(s.notes.get(open));
            return;
        }
        open = -1;
        add("PM notes", 16, Fmt.WHITE, true);
        if (s == null) {
            add(Fmt.emptyLine(this), 14, Fmt.GREY, false);
            return;
        }
        add(s.unread == 1 ? "1 unread" : s.unread + " unread", 12, s.unread > 0 ? Fmt.ACCENT : Fmt.GREY, false);
        if (s.notes.isEmpty()) {
            add("The notes appear here once the server sends them. Read them on the phone meanwhile.", 13, Fmt.GREY, false)
                .setPadding(0, dp(10), 0, 0);
            return;
        }
        for (int i = 0; i < s.notes.size(); i++) {
            final int index = i;
            Snapshot.Note n = s.notes.get(i);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(10), dp(8), dp(10), dp(8));
            row.setBackgroundColor(0xFF1A1A1A);
            TextView title = text((n.read ? "" : "● ") + (n.title.isEmpty() ? "(no title)" : n.title), 14, Fmt.WHITE, true);
            if (!n.read) {   // the unread dot in the accent colour
                android.text.SpannableString sp = new android.text.SpannableString(title.getText());
                sp.setSpan(new android.text.style.ForegroundColorSpan(Fmt.ACCENT), 0, 1, 0);
                title.setText(sp);
            }
            title.setMaxLines(2);
            row.addView(title);
            row.addView(text(meta(n), 12, Fmt.GREY, false));
            row.setOnClickListener(v -> {
                open = index;
                render();
                scroll.scrollTo(0, 0);
                scroll.requestFocus();
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.topMargin = dp(5);
            list.addView(row, lp);
        }
    }

    /** One note, whole, scrolled with the crown; "‹ Notes" goes back to the list. */
    private void note(Snapshot.Note n) {
        TextView back = add("‹ Notes", 13, Fmt.ACCENT, true);
        back.setPadding(dp(10), dp(4), dp(10), dp(6));
        back.setOnClickListener(v -> {
            open = -1;
            render();
            scroll.scrollTo(0, 0);
        });
        add(n.title.isEmpty() ? "(no title)" : n.title, 15, Fmt.WHITE, true);
        add(meta(n), 12, Fmt.GREY, false);
        TextView body = add(n.body, 14, 0xFFDDDDDD, false);
        body.setGravity(Gravity.START);
        body.setPadding(0, dp(8), 0, 0);
        body.setLineSpacing(0, 1.15f);
    }

    /** "14:05 · SOL · signal" */
    private static String meta(Snapshot.Note n) {
        StringBuilder b = new StringBuilder(Fmt.noteTime(n.at));
        for (String part : new String[] { n.coin, n.kind }) {
            if (part == null || part.isEmpty()) continue;
            if (b.length() > 0) b.append(" · ");
            b.append(part);
        }
        return b.toString();
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView add(String s, float sp, int color, boolean bold) {
        TextView t = text(s, sp, color, bold);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        list.addView(t, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
