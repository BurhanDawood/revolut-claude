package com.bryan.revolutx.wear;

import android.content.Context;
import androidx.wear.protolayout.LayoutElementBuilders;
import java.util.Map;

/** Desk #59 Tiles (Bryan 13 Oct 23:45), Tile "PM notes": the unread count (unread_pm_notes); a tap opens them on the phone. */
public class NotesTileService extends BaseTile {

    @Override
    LayoutElementBuilders.LayoutElement layout(Context app, Snapshot s, Screen screen, Map<String, Img> imgs) {
        LayoutElementBuilders.Column.Builder col = Tiles.column().addContent(Tiles.text("Revolut X", 12, Fmt.GREY, false));
        if (s == null) {
            col.addContent(Tiles.spacer(4)).addContent(Tiles.text(Fmt.emptyLine(app), 14, Fmt.WHITE, false));
            return Tiles.page(col.build(), Tiles.open(app, "app", MainActivity.class, null, null));
        }
        col.addContent(Tiles.text(String.valueOf(s.unread), 44, s.unread > 0 ? Fmt.ACCENT : Fmt.GREY, true))
            .addContent(Tiles.text(s.unread == 1 ? "unread PM note" : "unread PM notes", 14, Fmt.WHITE, false))
            .addContent(Tiles.spacer(4))
            .addContent(Tiles.text("Tap to read on the phone", 11, Fmt.GREY, false));
        return Tiles.page(col.build(), Tiles.open(app, "phone", OpenOnPhoneActivity.class, OpenOnPhoneActivity.EXTRA_TAB, "home"));
    }
}
