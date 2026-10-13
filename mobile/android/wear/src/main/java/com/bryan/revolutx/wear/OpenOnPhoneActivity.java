package com.bryan.revolutx.wear;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Toast;

/** The Tile's "Open on phone": opens the dashboard's Portfolio tab on the phone, then closes. */
public class OpenOnPhoneActivity extends Activity {

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        PhoneLink.openOnPhone(this, "portfolio", null);
        Toast.makeText(this, "Opening on your phone", Toast.LENGTH_SHORT).show();
        finish();
    }
}
