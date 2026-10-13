package com.bryan.revolutx.wear;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Toast;

/** A Tile's "open on the phone": the dashboard's Portfolio tab, or the tab in EXTRA_TAB (PhoneLink checks it); then closes. */
public class OpenOnPhoneActivity extends Activity {

    static final String EXTRA_TAB = "tab";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!OnWatch.is(this)) {
            Toast.makeText(this, OnWatch.PHONE_HINT, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        PhoneLink.openOnPhone(this, getIntent() != null ? getIntent().getStringExtra(EXTRA_TAB) : null, null);
        Toast.makeText(this, "Opening on your phone", Toast.LENGTH_SHORT).show();
        finish();
    }
}
