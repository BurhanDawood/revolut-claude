package com.bryan.revolutx.wear;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Desk #59 W3: the watch's only server call, GET {BASE}/api/watch with the dashboard key in x-api-token. Read-only; the
 * watch has no write call. One fetch at a time; callers say how old the last answer may be:
 *   the app: 25 s (it asks every 30 s while on screen), the Tile: 50 s, a complication: 4 min (Wear OS asks every 5),
 *   a tap or a new key: 0.
 * Offline or a server error keeps the last numbers ("updated HH:MM"). After a fetch the other surfaces are told to redraw.
 * Tiles (13 Oct 23:45): the same read carries ?coins=<the Tile coins> (batch 630), so one answer serves every Tile, and a changed
 * Tile coin is fetched at once. choices() is the coin list for the Tile coins screen (?choices=1). Both are GET /api/watch.
 */
final class Repo {

    static final int FROM_APP = 1;
    static final int FROM_TILE = 2;
    static final int FROM_COMPLICATION = 3;
    static final int FROM_KEY = 4;
    static final int FROM_TAP = 5;

    static final long AGE_SCREEN = 50_000;
    static final long AGE_APP = 25_000;   // the app re-fetches every 30 s while it is on screen (the server caches 30 s)
    static final long AGE_TILE = 30_000;  // a Tile asks on every swipe to it, never faster than the server's 30 s cache
    static final long AGE_COMPLICATION = 240_000;

    /** One fetch at a time; the key handover takes it too, so an old key's answer never lands after a new key or a CLEAR. */
    static final Object LOCK = new Object();

    private Repo() {}

    /** Fetches unless the last good answer is younger than maxAgeMs. Blocking: never on the main thread. */
    static Snapshot refresh(Context ctx, long maxAgeMs, int from) {
        Context app = ctx.getApplicationContext();
        if (!OnWatch.is(app)) return null;   // the watch APK on a phone by mistake: no fetch, no hello
        synchronized (LOCK) {
            SharedPreferences v = WatchStore.values(app);
            String key = WatchStore.key(app);
            if (key == null) {
                v.edit().putString(WatchStore.V_STATUS, "nokey").apply();
                PhoneLink.helloAtMost(app, PhoneLink.HELLO_NOKEY_MS);
                return null;
            }
            PhoneLink.helloAtMost(app, PhoneLink.HELLO_RECHECK_MS);   // the phone re-confirms the key, or clears it
            long now = System.currentTimeMillis();
            boolean ok = "".equals(v.getString(WatchStore.V_STATUS, "x"));
            String coins = TileCoins.wanted(app);
            Snapshot last = WatchStore.snapshot(app);
            boolean sameCoins = last != null && coins.equals(last.asked);
            if (ok && sameCoins && now - v.getLong(WatchStore.V_FETCHED, 0) < maxAgeMs) return last;
            // a failed try is not repeated for 20 s (three complications ask at once; an offline watch is not hammered)
            if (!ok && maxAgeMs > 0 && now - v.getLong(WatchStore.V_TRIED, 0) < 20_000) return WatchStore.snapshot(app);

            SharedPreferences.Editor e = v.edit().putLong(WatchStore.V_TRIED, now);
            HttpURLConnection c = null;
            try {
                // W1 again at the call: only ever the pinned server
                c = open(key, coins.isEmpty() ? "" : "?coins=" + coins);   // tickers only: [A-Z0-9], checked by TileCoins
                int code = c.getResponseCode();
                if (code == 401 || code == 403) {
                    e.putString(WatchStore.V_STATUS, "badkey");
                    PhoneLink.helloAtMost(app, PhoneLink.HELLO_BADKEY_MS);   // maybe the phone has a newer key
                } else if (code != 200) {
                    e.putString(WatchStore.V_STATUS, "http:" + code);
                } else {
                    Snapshot s = Snapshot.parse(read(c.getInputStream()));
                    s.asked = coins;
                    String json = s.toJson();
                    if (json == null) throw new IllegalStateException();
                    e.putString(WatchStore.V_SNAPSHOT, json).putLong(WatchStore.V_FETCHED, now).putString(WatchStore.V_STATUS, "");
                }
            } catch (IOException io) {
                e.putString(WatchStore.V_STATUS, "offline");
            } catch (Exception other) {
                e.putString(WatchStore.V_STATUS, "http:?");
            } finally {
                if (c != null) c.disconnect();
            }
            e.commit();
        }
        notifySurfaces(app, from);
        return WatchStore.snapshot(app);
    }

    /** W1 at the call: only ever the pinned server's /api/watch, GET, no redirects, the key in its header only. */
    private static HttpURLConnection open(String key, String query) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(WatchStore.BASE + "/api/watch" + query).openConnection();
        c.setConnectTimeout(10000);   // C4: <= 10 s, a CLEAR waits on this lock
        c.setReadTimeout(10000);
        c.setRequestMethod("GET");
        c.setInstanceFollowRedirects(false);   // the key is never carried to another host
        c.setUseCaches(false);
        c.setRequestProperty("x-api-token", key);
        c.setRequestProperty("Accept", "application/json");
        return c;
    }

    /**
     * The coins the Tile coins screen offers: the server's choices[] (?choices=1, A-Z), held coins first. An older server
     * without choices[], or no connection: the coins the last answer knows (holdings, movers, Tile coins). Blocking.
     */
    static List<String> choices(Context ctx) {
        Context app = ctx.getApplicationContext();
        List<String> all = new ArrayList<>();
        if (OnWatch.is(app)) {
            synchronized (LOCK) {
                String key = WatchStore.key(app);
                HttpURLConnection c = null;
                if (key != null) {
                    try {
                        c = open(key, "?choices=1");
                        if (c.getResponseCode() == 200) {
                            JSONArray a = new JSONObject(read(c.getInputStream())).optJSONArray("choices");
                            for (int i = 0; a != null && i < a.length() && all.size() < 500; i++) {
                                Object o = a.opt(i);
                                String coin = o instanceof JSONObject ? ((JSONObject) o).optString("coin", "") : String.valueOf(o);
                                coin = coin.toUpperCase(Locale.US);
                                if (TileCoins.valid(coin) && !all.contains(coin)) all.add(coin);
                            }
                        }
                    } catch (Exception ignored) {
                        // offline or an older server: the fallback below
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
            }
        }
        Snapshot s = WatchStore.snapshot(app);
        List<String> held = new ArrayList<>();
        if (s != null) {
            for (Snapshot.Coin h : s.holdings) if (!held.contains(h.coin)) held.add(h.coin);
            if (all.isEmpty()) {
                for (Snapshot.Coin m : s.movers) if (!all.contains(m.coin)) all.add(m.coin);
                for (Snapshot.Quote q : s.quotes) if (!all.contains(q.coin)) all.add(q.coin);
                for (String h : held) if (!all.contains(h)) all.add(h);
            }
        }
        Collections.sort(all);
        Collections.sort(held);
        List<String> out = new ArrayList<>();
        for (String h : held) if (all.contains(h)) out.add(h);   // held first, then the rest A-Z
        for (String c : all) if (!out.contains(c)) out.add(c);
        return out;
    }

    /** The Tiles and the face's complications redraw from the saved numbers (the caller redraws itself). */
    static void notifySurfaces(Context ctx, int from) {
        Context app = ctx.getApplicationContext();
        if (from != FROM_TILE) Tiles.updateAll(app);
        if (from != FROM_COMPLICATION) {
            for (Class<?> c : ComplicationBase.ALL) {
                try {
                    ComplicationDataSourceUpdateRequester.Companion.create(app, new ComponentName(app, c)).requestUpdateAll();
                } catch (Exception ignored) {
                    // not on the face
                }
            }
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = s.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                if (out.size() > 256 * 1024) throw new IOException("too large");
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
