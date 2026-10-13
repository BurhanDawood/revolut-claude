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
        JSONArray a = sp.optJSONArray("points");
        if (a == null || a.length() < 2) return;
        int n = Math.min(a.length(), 120);
        double[] pts = new double[n];
        for (int i = 0; i < n; i++) {
            double d = a.optDouble(a.length() - n + i, Double.NaN);   // the newest 120 at most
            if (Double.isNaN(d) || Double.isInfinite(d)) return;     // a broken series draws no line
            pts[i] = d;
        }
        s.spark = pts;
        s.sparkChgUsd = num(sp, "change_usd");
        s.sparkChgPct = num(sp, "change_pct");
        s.sparkFrom = sp.optLong("from_ts", 0);
        s.sparkTo = sp.optLong("to_ts", 0);
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
