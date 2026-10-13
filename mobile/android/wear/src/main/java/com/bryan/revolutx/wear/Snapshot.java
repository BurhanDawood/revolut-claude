package com.bryan.revolutx.wear;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One /api/watch answer: { v, at, updated_ts, partial, total_usd, pnl_day_usd, pnl_day_pct, movers:[{coin,pct,price}],
 * unread_pm_notes, holdings:[{coin,usd,pct}], spark } (holdings: batch 624; a missing field is an empty list). Numbers and counts only.
 * spark (batch 628): { range:'6h', from_ts, to_ts, points:[up to 61 USD totals, oldest first], change_usd, change_pct } or null
 * when the server has no series; then the card draws no line and shows today's P&L instead.
 * coins (batch 630, with ?coins=A,B,C): [{ coin, price, pct_24h (null if not tracked), usd_held, spark (up to 49 prices over
 * 24 h, oldest first, or null) }], at most 5 - the Tile coins. An older server leaves it out; quote() then falls back to holdings.
 */
final class Snapshot {

    static final class Coin {
        final String coin;
        final double pct;     // NaN when unknown
        final double price;   // movers: last price; holdings: value in USD

        Coin(String coin, double pct, double price) {
            this.coin = coin;
            this.pct = pct;
            this.price = price;
        }
    }

    Double total;
    Double pnlUsd;
    Double pnlPct;
    boolean partial;
    long updatedMs;   // the server's updated_ts, in ms (0 = unknown)
    int unread;
    final List<Coin> movers = new ArrayList<>();
    final List<Coin> holdings = new ArrayList<>();   // coin, pct (24 h, NaN when null), price = value in USD
    double[] spark;          // the 6 h line, oldest first; null = no series
    Double sparkChgUsd;
    Double sparkChgPct;
    long sparkFrom;          // the series' first and last time, as the server sent them
    long sparkTo;
    final List<Quote> quotes = new ArrayList<>();   // coins[]
    String asked = "";       // the ?coins= this answer was fetched with ("" = none), so a changed Tile coin is fetched at once

    /** One coin for a Tile or the coin screen. NaN = unknown; spark null = no line. */
    static final class Quote {
        final String coin;
        double price = Double.NaN;
        double pct = Double.NaN;
        double held = Double.NaN;   // USD held
        double[] spark;

        Quote(String coin) {
            this.coin = coin;
        }
    }

    /** Parses the server's answer, keeping only the known fields. Throws on a body without a total. */
    static Snapshot parse(String body) throws Exception {
        JSONObject o = new JSONObject(body);
        Snapshot s = new Snapshot();
        s.total = num(o, "total_usd");
        if (s.total == null) throw new IllegalArgumentException("no total");
        s.pnlUsd = num(o, "pnl_day_usd");
        s.pnlPct = num(o, "pnl_day_pct");
        s.partial = o.optBoolean("partial", false);
        long ts = o.optLong("updated_ts", 0);
        s.updatedMs = ts > 0 && ts < 100000000000L ? ts * 1000 : ts;   // seconds or ms
        s.unread = Math.max(0, o.optInt("unread_pm_notes", 0));
        readCoins(o.optJSONArray("movers"), s.movers, "price", 3);
        readCoins(o.optJSONArray("holdings"), s.holdings, "usd", 50);
        readSpark(o.optJSONObject("spark"), s);
        readQuotes(o.optJSONArray("coins"), s);
        s.asked = o.optString("rx_asked", "");   // only in the saved copy
        return s;
    }

    private static void readCoins(JSONArray a, List<Coin> out, String valueField, int max) {
        if (a == null) return;
        for (int i = 0; i < a.length() && out.size() < max; i++) {
            JSONObject m = a.optJSONObject(i);
            if (m == null) continue;
            String coin = m.optString("coin", "");
            if (!coin.matches("[A-Za-z0-9]{1,15}")) continue;
            out.add(new Coin(coin.toUpperCase(), m.optDouble("pct", Double.NaN), m.optDouble(valueField, Double.NaN)));
        }
    }

    private static void readSpark(JSONObject sp, Snapshot s) {
        if (sp == null) return;
        double[] pts = series(sp.optJSONArray("points"));
        if (pts == null) return;
        s.spark = pts;
        s.sparkChgUsd = num(sp, "change_usd");
        s.sparkChgPct = num(sp, "change_pct");
        s.sparkFrom = sp.optLong("from_ts", 0);
        s.sparkTo = sp.optLong("to_ts", 0);
    }

    private static void readQuotes(JSONArray a, Snapshot s) {
        if (a == null) return;
        for (int i = 0; i < a.length() && s.quotes.size() < 5; i++) {
            JSONObject c = a.optJSONObject(i);
            if (c == null) continue;
            String coin = c.optString("coin", "");
            if (!coin.matches("[A-Za-z0-9]{1,15}")) continue;
            Quote q = new Quote(coin.toUpperCase());
            q.price = dbl(c, "price");
            q.pct = dbl(c, "pct_24h");
            q.held = dbl(c, "usd_held");
            q.spark = series(c.optJSONArray("spark"));
            s.quotes.add(q);
        }
    }

    /** At least 2 finite numbers (the newest 120 at most), or null: a broken series draws no line. */
    private static double[] series(JSONArray a) {
        if (a == null || a.length() < 2) return null;
        int n = Math.min(a.length(), 120);
        double[] pts = new double[n];
        for (int i = 0; i < n; i++) {
            double d = a.optDouble(a.length() - n + i, Double.NaN);
            if (Double.isNaN(d) || Double.isInfinite(d)) return null;
            pts[i] = d;
        }
        return pts;
    }

    private static double dbl(JSONObject o, String k) {
        Double d = num(o, k);
        return d == null ? Double.NaN : d;
    }

    /**
     * The coin's numbers: coins[] when the server sent it, else what holdings[] and movers[] know (no line then); null when
     * the coin is in none of them.
     */
    Quote quote(String coin) {
        for (Quote q : quotes) if (q.coin.equals(coin)) return q;
        Quote q = null;
        for (Coin h : holdings) {
            if (!h.coin.equals(coin)) continue;
            q = new Quote(coin);
            q.held = h.price;
            q.pct = h.pct;
        }
        for (Coin m : movers) {
            if (!m.coin.equals(coin)) continue;
            if (q == null) q = new Quote(coin);
            q.price = m.price;
            if (Double.isNaN(q.pct)) q.pct = m.pct;
        }
        return q;
    }

    private static Double num(JSONObject o, String k) {
        if (!o.has(k) || o.isNull(k)) return null;
        double d = o.optDouble(k, Double.NaN);
        return Double.isNaN(d) || Double.isInfinite(d) ? null : d;
    }

    String toJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("total_usd", total);
            if (pnlUsd != null) o.put("pnl_day_usd", pnlUsd);
            if (pnlPct != null) o.put("pnl_day_pct", pnlPct);
            o.put("partial", partial);
            o.put("updated_ts", updatedMs);
            o.put("unread_pm_notes", unread);
            o.put("movers", coins(movers, "price"));
            o.put("holdings", coins(holdings, "usd"));
            if (spark != null) {
                JSONArray pts = new JSONArray();
                for (double d : spark) pts.put(d);
                JSONObject sp = new JSONObject().put("range", "6h").put("points", pts).put("from_ts", sparkFrom).put("to_ts", sparkTo);
                if (sparkChgUsd != null) sp.put("change_usd", sparkChgUsd);
                if (sparkChgPct != null) sp.put("change_pct", sparkChgPct);
                o.put("spark", sp);
            }
            if (!quotes.isEmpty()) {
                JSONArray qs = new JSONArray();
                for (Quote q : quotes) {
                    JSONObject c = new JSONObject().put("coin", q.coin);
                    if (!Double.isNaN(q.price)) c.put("price", q.price);
                    if (!Double.isNaN(q.pct)) c.put("pct_24h", q.pct);
                    if (!Double.isNaN(q.held)) c.put("usd_held", q.held);
                    if (q.spark != null) {
                        JSONArray pts = new JSONArray();
                        for (double d : q.spark) pts.put(d);
                        c.put("spark", pts);
                    }
                    qs.put(c);
                }
                o.put("coins", qs);
            }
            o.put("rx_asked", asked);
            return o.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static JSONArray coins(List<Coin> list, String valueField) throws Exception {
        JSONArray a = new JSONArray();
        for (Coin c : list) {
            JSONObject m = new JSONObject().put("coin", c.coin);
            if (!Double.isNaN(c.pct)) m.put("pct", c.pct);
            if (!Double.isNaN(c.price)) m.put(valueField, c.price);
            a.put(m);
        }
        return a;
    }

    /** The saved snapshot, or null. */
    static Snapshot fromJson(String json) {
        if (json == null) return null;
        try {
            return parse(json);
        } catch (Exception e) {
            return null;
        }
    }
}
