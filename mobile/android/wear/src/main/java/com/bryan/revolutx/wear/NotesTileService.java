package com.bryan.revolutx.wear;

import android.content.Context;
import androidx.wear.protolayout.LayoutElementBuilders;
import java.util.Map;

/**
 * Desk #59 Tiles (Bryan 13 Oct 23:45, 14 Oct 14:01), Tile "PM notes": "n unread", the newest note's title and the first lines
 * of its body (notes[], batch 632); a tap opens the notes on the watch (NotesActivity, read-only). Before batch 632 the unread
 * count alone.
 */
public class NotesTileService extends BaseTile {

    @Override
    LayoutElementBuilders.LayoutElement layout(Context app, Snapshot s, Screen screen, Map<String, Img> imgs) {
        LayoutElementBuilders.Column.Builder col = Tiles.column();
        if (s == null) {
            col.addContent(Tiles.text("PM notes", 13, Fmt.GREY, false)).addContent(Tiles.spacer(4))
                .addContent(Tiles.text(Fmt.emptyLine(app), 14, Fmt.WHITE, false));
            return Tiles.page(col.build(), Tiles.open(app, "app", MainActivity.class, null, null));
        }
        String unread = s.unread == 1 ? "1 unread" : s.unread + " unread";
        if (s.notes.isEmpty()) {
            col.addContent(Tiles.text("PM notes", 13, Fmt.GREY, false))
                .addContent(Tiles.text(String.valueOf(s.unread), 44, s.unread > 0 ? Fmt.ACCENT : Fmt.GREY, true))
                .addContent(Tiles.text(unread, 14, Fmt.WHITE, false));
        } else {
            Snapshot.Note n = s.notes.get(0);
            String when = Fmt.noteTime(n.at);
            col.addContent(Tiles.text("PM notes · " + unread, 13, s.unread > 0 ? Fmt.ACCENT : Fmt.GREY, true))
                .addContent(Tiles.spacer(4))
                .addContent(Tiles.text(n.title.isEmpty() ? "(no title)" : n.title, 16, Fmt.WHITE, true, 2))
                .addContent(Tiles.text((when.isEmpty() ? "" : when) + (n.coin.isEmpty() ? "" : (when.isEmpty() ? "" : " · ") + n.coin), 12, Fmt.GREY, false))
                .addContent(Tiles.spacer(3))
                .addContent(Tiles.text(n.body, 13, 0xFFCCCCCC, false, 4));
        }
        return Tiles.page(col.build(), Tiles.open(app, "notes", NotesActivity.class, null, null));
    }
}
