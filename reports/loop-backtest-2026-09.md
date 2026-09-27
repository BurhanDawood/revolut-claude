# T3: pump-loop settings backtest on a year of real prices (Sep 2025 to Sep 2026)

Read-only research. Nothing in server.js, the config or the live loops was changed; this is evidence for the PM chat, not a recommendation.

## For Bryan, in plain words

1. We replayed a year of hourly prices through the bot's own test engine to see how your nine pump loops would have done with other settings.
2. It was a steep falling year: from September to May the typical coin lost about two thirds of its price. In a year like that, whatever sells soonest looks best. That says more about the market than about the setting.
3. With today's settings, every loop that sold ended ahead of simply holding. The one exception was DASH from June to September: it sold, DASH kept rising, and it ended 11% behind.
4. We picked settings on September to May, then tested them on June to September. They beat today's settings in 11 of 18 checks and lost in 5. But each check rests on one or two sales, so this is weak evidence.
5. Across 60 coins, the setting that looked best on September to May did the worst from June to September: the typical coin ended 16.5% behind holding. A setting that looks best on the past can easily fail next.
6. HIGH's 9% stop was not too tight. On the 26 Sep jump it sold at about $0.0412. Every wider stop would have sold lower, and the price was $0.0357 by 23:00 UTC.
7. Automatic buy-backs have never happened live. In the test they mostly made results worse, and helped only in a few summer cases (HONEY, and IDEX at a tighter setting).
8. No one setting suits most coins. Settings chosen coin by coin did somewhat better, but from June to September neither choice beat just holding for the typical coin.
9. Caution: hourly prices cannot see a dip that happens inside the hour, and about a third of the test's sales depend on which came first inside an hour, the high or the low.

## What was run

- **Engine:** the live `runLadderBacktest` (with `shadowEvalLadder`, `shadowEvalTier`, `shadowNewState`, `btComputeMetrics`), extracted from
  server.js by name and run offline by `tools/backtest/loop-grid.mjs` on the exported hourly candles (`data-prices`, exported
  2026-09-26 23:45 UTC, server d73fb595). No new simulator; `tests/tools/loop-grid.test.mjs` proves the offline run equals the extracted engine.
- **Every run:** `rule_mode 'ladder'`, window 1440 min, one sale per arm (`max_legs 1`, as live), no retention floor (`retention_floor_pct 0`;
  the engine's ladder default of 50 would have trimmed every 100% sale), fee 0.09% per fill, slippage 0.5%, a fresh $1000 of the coin at
  the window's first hourly close. Held coins use the live floor, max(cost x 1.005, stored floor), for the whole year (FINDINGS T3-6).
- **Buy-back modes, never blended:**
  - **A, sell only** (what live has actually done: 8 loop sales, 0 automatic buy-backs). Expressed by configuration only: `abandon_hours 0`,
    so the engine gives up the buy-back on the first bar after a sale. The driver checks every mode-A run for zero buy-backs.
  - **B, engine buy-back**, with retrace 50% and bounce 8% (the live tracker's defaults) and the engine's own defaults for the rest (70% of
    the proceeds on the first bounce, the rest after a further 10% drop, never above the average sale price, given up after 48 h or 15%
    above the sale). **This assumes a buy-back that live has never made**, and it is the engine's buy-back, not live's (FINDINGS T3-5).
  - **C, cost-anchored** (the batch-463 rule: buy back only if the trough stays at or above cost x 0.95): **not expressible without a
    server.js change.** The engine has no absolute buy-back line; the smallest change is in FINDINGS T3-1. Instead of a C result, each coin
    shows a diagnostic from mode B's own fills: how many B buy-backs had a trough at or above cost x 0.95.
- **Grid:** arm {15, 20, 25, 30, 40, 50, 65}% x trail {5, 6, 8, 9, 10, 12, 15, 20, 25}% x sell {50, 100}%, plus each coin's current
  setting where it is off the grid (AST arm 45). Nothing was cut: the held-coin grid took 108 s, the 65-coin grid 694 s, the report runs 6 s.
- **Walk-forward:** settings are picked on **in-sample (IS) 11 Sep 2025 to 31 May 2026** and scored on **out-of-sample (OOS) 1 Jun to 26 Sep
  2026**. The pick is **robust**: for each sell %, every arm x trail cell is scored by the median of its 3x3 neighbourhood (clipped at the
  grid edge); ties go to the cell's own value, then to the setting nearest the current one. The best single cell is shown for contrast.
- **Ranking measure:** IS vs hold. Within one coin and one window, vs hold and vs half-cash rank the settings identically (both are the
  end value divided by a number that does not depend on the setting), so the choice does not change any pick; both are shown.

## How to read the tables

- **vs hold:** the end value against simply keeping the $1000 of coin. **vs half-cash:** against selling half on day one and keeping the
  rest, the engine's fair benchmark in a trending year (#380). Both are the engine's own `vs_hold_pct` / `vs_half_cash_pct`.
- **Cycles RT / CH / CP / IN:** the engine's per-cycle classes: round trip (bought back and kept at least 75% of the coins), churned
  (bought back, then sold down again), cash-parked (sold, never bought back), inert (armed, never sold). In mode A every selling cycle is
  cash-parked by construction.
- **Floor blocks:** stop breaches the floor refused (the trail then re-anchors, as live does). **Median sale vs arm:** sale price against
  the price at arm; positive when the floor held the sale back until the price was far higher.
- **Same-bar sales / Rebound arms:** hourly-bar diagnostics, FINDINGS T3-3 and T3-2. Treat a result that rests on them with extra care.
- **The market decides most of these numbers.** Median price change of the 60 coins with data in both windows: **-67.7% IS**
  (7 of 60 rose) and **+4.5% OOS** (37 of 65 rose). Held coins IS: AST -83%, CC +4% (data only from 23 Apr), COTI -76%, DASH +62%,
  HFT -88%, HIGH -77%, HONEY -88%, IDEX -94%, JTO -73%. OOS: AST 0%, CC -13%, COTI +21%, DASH +74%, HFT -47%, HIGH -73%, HONEY -28%,
  IDEX -42%, JTO +13%. With sell 100% and no buy-back, a window holds at most one real sale, so each held-coin cell is **one sale**.

## Limitations (plain)

- **Hourly candles cannot see a dip inside the hour** (HIGH on 26 Sep fell about 10% in 4 minutes and bounced). The engine tests each
  bar's low, so it is roughly right on whether a stop was breached, but not on the price or the order of moves inside the hour.
- **32% of the simulated sales (4,729 of 14,894 in the held grid) happened in the bar that also set the peak**; the engine assumes the high
  came first and may fill at the bar's open (FINDINGS T3-3). **16% of arms were rebounds after a fall** that live's arm rule would likely
  not have taken (FINDINGS T3-2). HIGH's in-sample sale on 11 Oct 2025 is one of these: +25% off the 10 Oct crash wick.
- Small samples: one sale per window per setting for most held coins. The monthly restarts below add 13 fresh starts per coin but still
  sell at most once a month each.
- CC has hourly data only from 23 Apr 2026 (5 weeks in-sample). FIS, HOPR, RSC, TURBO and XPL lack data in one of the windows and are
  left out of the cross-coin medians.

## Verdicts (out-of-sample, robust pick vs current)

| Coin | Mode | Current | Robust pick (IS) | OOS current vs hold | OOS robust vs hold | Better OOS? |
|---|---|---|---|---|---|---|
| AST | A | 45 / 10 / 100 | 15 / 5 / 100 | +66.3% | +72.8% | yes (+6.5% pts) |
| AST | B | 45 / 10 / 100 | 15 / 9 / 100 | +61.1% | +62.9% | yes (+1.8% pts) |
| CC | A | 65 / 6 / 50 | 20 / 6 / 100 | 0.0% | +13.0% | yes (+13.0% pts) |
| CC | B | 65 / 6 / 50 | 20 / 5 / 100 | 0.0% | +13.0% | yes (+13.0% pts) |
| COTI | A | 40 / 10 / 100 | 15 / 5 / 100 | +16.3% | +18.5% | yes (+2.2% pts) |
| COTI | B | 40 / 10 / 100 | 15 / 9 / 100 | +16.3% | +13.6% | no (-2.8% pts) |
| DASH | A | 25 / 8 / 100 | 25 / 25 / 100 | -11.0% | 0.0% | yes (+11.0% pts) |
| DASH | B | 25 / 8 / 100 | 25 / 25 / 100 | -11.0% | 0.0% | yes (+11.0% pts) |
| HFT | A | 20 / 9 / 100 | 40 / 9 / 100 | +88.1% | +54.1% | no (-34.0% pts) |
| HFT | B | 20 / 9 / 100 | 30 / 8 / 100 | +48.0% | +47.5% | no (-0.5% pts) |
| HIGH | A | 25 / 9 / 100 | 15 / 5 / 100 | +131.7% | +244.5% | yes (+112.8% pts) |
| HIGH | B | 25 / 9 / 100 | 15 / 10 / 100 | +131.7% | +131.6% | same |
| HONEY | A | 40 / 12 / 100 | 30 / 5 / 100 | +4.9% | +28.6% | yes (+23.6% pts) |
| HONEY | B | 40 / 12 / 100 | 15 / 5 / 100 | +17.0% | +26.9% | yes (+9.9% pts) |
| IDEX | A | 25 / 9 / 100 | 30 / 6 / 100 | +84.6% | +84.6% | same |
| IDEX | B | 25 / 9 / 100 | 30 / 6 / 100 | +67.1% | +147.4% | yes (+80.3% pts) |
| JTO | A | 40 / 25 / 50 | 15 / 5 / 100 | +4.9% | -5.8% | no (-10.7% pts) |
| JTO | B | 40 / 25 / 50 | 15 / 5 / 100 | +4.9% | -5.8% | no (-10.7% pts) |

## Per held coin

#### AST  (live: arm 45%, trail 10%, sell 100%; floor 0.00644681)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 45 / 10 / 100 | IS | +263.8% | +4.4% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -16.3% | 0 | 0 |
| A | current 45 / 10 / 100 | OOS | +66.3% | +66.7% | 1 | 0 | 0 / 0 / 1 / 1 | 78 | +30.2% | 0 | 0 |
| A | robust pick 15 / 5 / 100 | IS | +560.6% | +89.5% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.0% | 0 | 0 |
| A | robust pick 15 / 5 / 100 | OOS | +72.8% | +73.2% | 1 | 0 | 0 / 0 / 1 / 1 | 363 | +72.9% | 0 | 1 |
| B | current 45 / 10 / 100 | IS | +135.0% | -32.6% | 4 | 5 | 2 / 1 / 1 / 1 | 0 | -17.6% | 0 | 0 |
| B | current 45 / 10 / 100 | OOS | +61.1% | +61.5% | 2 | 2 | 1 / 0 / 1 / 1 | 78 | +7.5% | 0 | 0 |
| B | robust pick 15 / 9 / 100 | IS | +532.8% | +81.5% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -9.0% | 0 | 0 |
| B | robust pick 15 / 9 / 100 | OOS | +62.9% | +63.2% | 2 | 2 | 1 / 0 / 1 / 1 | 148 | +26.5% | 0 | 0 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 5 of 5 (IS) and 1 of 2 (OOS) had a trough at or above cost x 0.95 = 0.00609400, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 15 / 5 / 100 IS +560.6%, OOS +72.8%; B: best single cell 15 / 8 / 100 IS +539.7%, OOS +64.7%.

#### CC  (live: arm 65%, trail 6%, sell 50%; floor 0.134678)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 65 / 6 / 50 | IS | 0.0% | +2.3% | 0 | 0 | 0 / 0 / 0 / 0 | 0 | n/a | 0 | 0 |
| A | current 65 / 6 / 50 | OOS | 0.0% | -6.6% | 0 | 0 | 0 / 0 / 0 / 0 | 0 | n/a | 0 | 0 |
| A | robust pick 20 / 6 / 100 | IS | +8.3% | +10.8% | 1 | 0 | 0 / 0 / 1 / 0 | 0 | +1.0% | 1 | 0 |
| A | robust pick 20 / 6 / 100 | OOS | +13.0% | +5.6% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -9.4% | 0 | 0 |
| B | current 65 / 6 / 50 | IS | 0.0% | +2.3% | 0 | 0 | 0 / 0 / 0 / 0 | 0 | n/a | 0 | 0 |
| B | current 65 / 6 / 50 | OOS | 0.0% | -6.6% | 0 | 0 | 0 / 0 / 0 / 0 | 0 | n/a | 0 | 0 |
| B | robust pick 20 / 5 / 100 | IS | +5.1% | +7.5% | 1 | 1 | 0 / 1 / 0 / 0 | 0 | -3.1% | 1 | 0 |
| B | robust pick 20 / 5 / 100 | OOS | +13.0% | +5.6% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -9.4% | 0 | 0 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 0 of 0 (IS) and 0 of 0 (OOS) had a trough at or above cost x 0.95 = 0.126771, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 20 / 6 / 100 IS +8.3%, OOS +13.0%; B: best single cell 30 / 12 / 100 IS +6.1%, OOS +14.9%.

#### COTI  (live: arm 40%, trail 10%, sell 100%; floor 0.0171806)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 40 / 10 / 100 | IS | +199.3% | +16.6% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -3.1% | 1 | 0 |
| A | current 40 / 10 / 100 | OOS | +16.3% | +28.0% | 1 | 0 | 0 / 0 / 1 / 1 | 38 | +27.9% | 1 | 0 |
| A | robust pick 15 / 5 / 100 | IS | +351.9% | +76.1% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.0% | 0 | 0 |
| A | robust pick 15 / 5 / 100 | OOS | +18.5% | +30.4% | 1 | 0 | 0 / 0 / 1 / 1 | 429 | +33.8% | 1 | 1 |
| B | current 40 / 10 / 100 | IS | +60.6% | -37.4% | 1 | 1 | 0 / 1 / 0 / 0 | 0 | -3.1% | 1 | 0 |
| B | current 40 / 10 / 100 | OOS | +16.3% | +28.0% | 1 | 0 | 0 / 0 / 1 / 1 | 38 | +27.9% | 1 | 0 |
| B | robust pick 15 / 9 / 100 | IS | +332.9% | +68.7% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -9.0% | 0 | 0 |
| B | robust pick 15 / 9 / 100 | OOS | +13.6% | +24.9% | 1 | 0 | 0 / 0 / 1 / 1 | 171 | +28.2% | 1 | 0 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 1 of 1 (IS) and 0 of 0 (OOS) had a trough at or above cost x 0.95 = 0.0162403, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 15 / 5 / 100 IS +351.9%, OOS +18.5%; B: best single cell 15 / 8 / 100 IS +337.6%, OOS +14.8%.

#### DASH  (live: arm 25%, trail 8%, sell 100%; floor 63.3466)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 25 / 8 / 100 | IS | +75.2% | +117.3% | 1 | 0 | 0 / 0 / 1 / 1 | 229 | +156.3% | 1 | 0 |
| A | current 25 / 8 / 100 | OOS | -11.0% | +13.3% | 1 | 0 | 0 / 0 / 1 / 0 | 189 | +73.9% | 1 | 0 |
| A | robust pick 25 / 25 / 100 | IS | +177.8% | +244.6% | 1 | 0 | 0 / 0 / 1 / 1 | 6 | +306.5% | 0 | 0 |
| A | robust pick 25 / 25 / 100 | OOS | 0.0% | +27.3% | 0 | 0 | 0 / 0 / 0 / 1 | 3 | n/a | 0 | 0 |
| B | current 25 / 8 / 100 | IS | +75.2% | +117.3% | 1 | 0 | 0 / 0 / 1 / 1 | 229 | +156.3% | 1 | 0 |
| B | current 25 / 8 / 100 | OOS | -11.0% | +13.3% | 1 | 0 | 0 / 0 / 1 / 0 | 189 | +73.9% | 1 | 0 |
| B | robust pick 25 / 25 / 100 | IS | +177.8% | +244.6% | 1 | 0 | 0 / 0 / 1 / 1 | 6 | +306.5% | 0 | 0 |
| B | robust pick 25 / 25 / 100 | OOS | 0.0% | +27.3% | 0 | 0 | 0 / 0 / 0 / 1 | 3 | n/a | 0 | 0 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 0 of 0 (IS) and 0 of 0 (OOS) had a trough at or above cost x 0.95 = 59.8798, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 25 / 20 / 100 IS +196.3%, OOS -11.5%; B: best single cell 25 / 20 / 100 IS +196.3%, OOS -11.5%.

#### HFT  (live: arm 20%, trail 9%, sell 100%; floor 0.00634918)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 20 / 9 / 100 | IS | +319.1% | -7.8% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -8.3% | 1 | 2 |
| A | current 20 / 9 / 100 | OOS | +88.1% | +30.6% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -9.0% | 0 | 0 |
| A | robust pick 40 / 9 / 100 | IS | +393.3% | +8.5% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -10.0% | 0 | 0 |
| A | robust pick 40 / 9 / 100 | OOS | +54.1% | +7.0% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -10.0% | 0 | 0 |
| B | current 20 / 9 / 100 | IS | +319.1% | -7.8% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -8.3% | 1 | 1 |
| B | current 20 / 9 / 100 | OOS | +48.0% | +2.7% | 4 | 6 | 3 / 0 / 1 / 1 | 0 | -6.5% | 2 | 0 |
| B | robust pick 30 / 8 / 100 | IS | +345.8% | -1.9% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -8.0% | 0 | 1 |
| B | robust pick 30 / 8 / 100 | OOS | +47.5% | +2.3% | 2 | 2 | 1 / 0 / 1 / 1 | 0 | -8.0% | 1 | 0 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 0 of 0 (IS) and 6 of 6 (OOS) had a trough at or above cost x 0.95 = 0.00600171, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 40 / 9 / 100 IS +393.3%, OOS +54.1%; B: best single cell 25 / 15 / 100 IS +376.4%, OOS +34.9%.

#### HIGH  (live: arm 25%, trail 9%, sell 100%; floor 0.0338106)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 25 / 9 / 100 | IS | +148.8% | -4.9% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -16.4% | 0 | 1 |
| A | current 25 / 9 / 100 | OOS | +131.7% | -0.0% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -15.4% | 0 | 0 |
| A | robust pick 15 / 5 / 100 | IS | +322.8% | +61.6% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -8.0% | 0 | 0 |
| A | robust pick 15 / 5 / 100 | OOS | +244.5% | +48.7% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -9.7% | 0 | 1 |
| B | current 25 / 9 / 100 | IS | +143.3% | -7.0% | 3 | 2 | 0 / 2 / 1 / 1 | 0 | -9.0% | 1 | 1 |
| B | current 25 / 9 / 100 | OOS | +131.7% | -0.0% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -15.4% | 0 | 1 |
| B | robust pick 15 / 10 / 100 | IS | +313.4% | +58.0% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -10.0% | 0 | 0 |
| B | robust pick 15 / 10 / 100 | OOS | +131.6% | -0.1% | 3 | 3 | 1 / 1 / 1 / 1 | 0 | -10.0% | 1 | 2 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 2 of 2 (IS) and 0 of 0 (OOS) had a trough at or above cost x 0.95 = 0.0319603, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 15 / 6 / 100 IS +322.8%, OOS +244.5%; B: best single cell 15 / 6 / 100 IS +322.8%, OOS +102.8%.

#### HONEY  (live: arm 40%, trail 12%, sell 100%; floor 0.00136348)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 40 / 12 / 100 | IS | +721.7% | +77.5% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -12.0% | 0 | 0 |
| A | current 40 / 12 / 100 | OOS | +4.9% | -11.7% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -1.8% | 1 | 0 |
| A | robust pick 30 / 5 / 100 | IS | +906.6% | +117.4% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.6% | 0 | 0 |
| A | robust pick 30 / 5 / 100 | OOS | +28.6% | +8.3% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.0% | 1 | 0 |
| B | current 40 / 12 / 100 | IS | +510.9% | +31.9% | 4 | 6 | 3 / 0 / 1 / 1 | 0 | -12.0% | 0 | 0 |
| B | current 40 / 12 / 100 | OOS | +17.0% | -1.5% | 2 | 2 | 1 / 0 / 1 / 1 | 37 | +28.2% | 2 | 1 |
| B | robust pick 15 / 5 / 100 | IS | +764.5% | +86.7% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.1% | 1 | 0 |
| B | robust pick 15 / 5 / 100 | OOS | +26.9% | +6.9% | 5 | 7 | 3 / 1 / 1 / 1 | 0 | -5.9% | 4 | 1 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 6 of 6 (IS) and 0 of 2 (OOS) had a trough at or above cost x 0.95 = 0.00128886, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 30 / 5 / 100 IS +906.6%, OOS +28.6%; B: best single cell 15 / 5 / 100 IS +764.5%, OOS +26.9%.

#### IDEX  (live: arm 25%, trail 9%, sell 100%; floor 0.000955741)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 25 / 9 / 100 | IS | +1466.7% | +74.4% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -10.1% | 1 | 0 |
| A | current 25 / 9 / 100 | OOS | +84.6% | +35.5% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -24.5% | 0 | 0 |
| A | robust pick 30 / 6 / 100 | IS | +1692.5% | +99.5% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -8.3% | 0 | 0 |
| A | robust pick 30 / 6 / 100 | OOS | +84.6% | +35.5% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -24.5% | 0 | 0 |
| B | current 25 / 9 / 100 | IS | +1466.7% | +74.4% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -10.1% | 1 | 0 |
| B | current 25 / 9 / 100 | OOS | +67.1% | +22.6% | 3 | 4 | 2 / 0 / 1 / 1 | 0 | -7.9% | 1 | 1 |
| B | robust pick 30 / 6 / 100 | IS | +1692.5% | +99.5% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -8.3% | 0 | 0 |
| B | robust pick 30 / 6 / 100 | OOS | +147.4% | +81.6% | 10 | 14 | 7 / 2 / 1 / 0 | 73 | -6.0% | 6 | 0 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 0 of 0 (IS) and 4 of 4 (OOS) had a trough at or above cost x 0.95 = 0.000903437, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 30 / 8 / 100 IS +1692.5%, OOS +84.6%; B: best single cell 30 / 8 / 100 IS +1692.5%, OOS +128.5%.

#### JTO  (live: arm 40%, trail 25%, sell 50%; floor 0.495762)

| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | current 40 / 25 / 50 | IS | +0.2% | -56.7% | 1 | 0 | 0 / 0 / 1 / 0 | 6 | +3.8% | 0 | 0 |
| A | current 40 / 25 / 50 | OOS | +4.9% | +11.4% | 1 | 0 | 0 / 0 / 1 / 0 | 0 | -12.5% | 0 | 0 |
| A | robust pick 15 / 5 / 100 | IS | +289.6% | +68.6% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.0% | 0 | 1 |
| A | robust pick 15 / 5 / 100 | OOS | -5.8% | +0.0% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.0% | 0 | 0 |
| B | current 40 / 25 / 50 | IS | +0.2% | -56.7% | 1 | 0 | 0 / 0 / 1 / 0 | 6 | +3.8% | 0 | 0 |
| B | current 40 / 25 / 50 | OOS | +4.9% | +11.4% | 1 | 0 | 0 / 0 / 1 / 0 | 0 | -12.5% | 0 | 0 |
| B | robust pick 15 / 5 / 100 | IS | +289.6% | +68.6% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.0% | 0 | 1 |
| B | robust pick 15 / 5 / 100 | OOS | -5.8% | +0.0% | 1 | 0 | 0 / 0 / 1 / 1 | 0 | -5.0% | 0 | 0 |
| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |

Mode-C diagnostic (not a result): of mode B's buy-backs at the current setting, 0 of 0 (IS) and 0 of 0 (OOS) had a trough at or above cost x 0.95 = 0.468631, the line batch 463 ships; the rest would have been blocked.
For contrast (overfitting check): A: best single cell 20 / 5 / 100 IS +289.6%, OOS +5.3%; B: best single cell 20 / 5 / 100 IS +289.6%, OOS +1.6%.

## Monthly restarts (fresh $1000 each month; robust pick vs current, vs hold)

| Coin | Mode | IS months: robust better / worse / same | OOS months: robust better / worse / same | OOS months where current sold | OOS months where robust sold |
|---|---|---|---|---|---|
| AST | A | 6 / 2 / 1 | 0 / 0 / 4 | 2 / 4 | 2 / 4 |
| AST | B | 8 / 1 / 0 | 0 / 1 / 3 | 2 / 4 | 2 / 4 |
| CC | A | 1 / 0 / 1 | 1 / 0 / 3 | 0 / 4 | 1 / 4 |
| CC | B | 1 / 0 / 1 | 1 / 0 / 3 | 0 / 4 | 1 / 4 |
| COTI | A | 4 / 1 / 4 | 1 / 1 / 2 | 2 / 4 | 2 / 4 |
| COTI | B | 4 / 1 / 4 | 0 / 2 / 2 | 2 / 4 | 2 / 4 |
| DASH | A | 2 / 0 / 7 | 1 / 0 / 3 | 1 / 4 | 0 / 4 |
| DASH | B | 2 / 0 / 7 | 1 / 0 / 3 | 1 / 4 | 0 / 4 |
| HFT | A | 3 / 5 / 1 | 2 / 1 / 1 | 3 / 4 | 2 / 4 |
| HFT | B | 4 / 4 / 1 | 2 / 1 / 1 | 3 / 4 | 3 / 4 |
| HIGH | A | 4 / 5 / 0 | 3 / 0 / 1 | 4 / 4 | 4 / 4 |
| HIGH | B | 5 / 3 / 1 | 3 / 0 / 1 | 4 / 4 | 4 / 4 |
| HONEY | A | 5 / 2 / 2 | 3 / 0 / 1 | 3 / 4 | 4 / 4 |
| HONEY | B | 6 / 3 / 0 | 3 / 0 / 1 | 3 / 4 | 4 / 4 |
| IDEX | A | 3 / 3 / 3 | 3 / 0 / 1 | 4 / 4 | 4 / 4 |
| IDEX | B | 4 / 3 / 2 | 4 / 0 / 0 | 4 / 4 | 4 / 4 |
| JTO | A | 3 / 1 / 5 | 2 / 2 / 0 | 1 / 4 | 4 / 4 |
| JTO | B | 3 / 1 / 5 | 2 / 2 / 0 | 1 / 4 | 4 / 4 |

## Slippage 1.0% (current and robust picks)

| Coin | Mode | Setting | Window | vs hold @0.5% | vs hold @1.0% | Sales @1.0% | Buy-backs @1.0% |
|---|---|---|---|---|---|---|---|
| AST | A | current 45 / 10 / 100 | IS | +263.8% | +262.0% | 1 | 0 |
| AST | A | current 45 / 10 / 100 | OOS | +66.3% | +65.5% | 1 | 0 |
| AST | A | robust 15 / 5 / 100 | IS | +560.6% | +557.3% | 1 | 0 |
| AST | A | robust 15 / 5 / 100 | OOS | +72.8% | +71.9% | 1 | 0 |
| AST | B | current 45 / 10 / 100 | IS | +135.0% | +130.2% | 4 | 5 |
| AST | B | current 45 / 10 / 100 | OOS | +61.1% | +58.8% | 2 | 2 |
| AST | B | robust 15 / 9 / 100 | IS | +532.8% | +529.6% | 1 | 0 |
| AST | B | robust 15 / 9 / 100 | OOS | +62.9% | +60.5% | 2 | 2 |
| CC | A | current 65 / 6 / 50 | IS | 0.0% | 0.0% | 0 | 0 |
| CC | A | current 65 / 6 / 50 | OOS | 0.0% | 0.0% | 0 | 0 |
| CC | A | robust 20 / 6 / 100 | IS | +8.3% | +7.8% | 1 | 0 |
| CC | A | robust 20 / 6 / 100 | OOS | +13.0% | +12.5% | 1 | 0 |
| CC | B | current 65 / 6 / 50 | IS | 0.0% | 0.0% | 0 | 0 |
| CC | B | current 65 / 6 / 50 | OOS | 0.0% | 0.0% | 0 | 0 |
| CC | B | robust 20 / 5 / 100 | IS | +5.1% | +4.2% | 1 | 1 |
| CC | B | robust 20 / 5 / 100 | OOS | +13.0% | +12.5% | 1 | 0 |
| COTI | A | current 40 / 10 / 100 | IS | +199.3% | +197.8% | 1 | 0 |
| COTI | A | current 40 / 10 / 100 | OOS | +16.3% | +15.8% | 1 | 0 |
| COTI | A | robust 15 / 5 / 100 | IS | +351.9% | +349.6% | 1 | 0 |
| COTI | A | robust 15 / 5 / 100 | OOS | +18.5% | +17.9% | 1 | 0 |
| COTI | B | current 40 / 10 / 100 | IS | +60.6% | +58.7% | 1 | 1 |
| COTI | B | current 40 / 10 / 100 | OOS | +16.3% | +15.8% | 1 | 0 |
| COTI | B | robust 15 / 9 / 100 | IS | +332.9% | +330.7% | 1 | 0 |
| COTI | B | robust 15 / 9 / 100 | OOS | +13.6% | +13.0% | 1 | 0 |
| DASH | A | current 25 / 8 / 100 | IS | +75.2% | +74.3% | 1 | 0 |
| DASH | A | current 25 / 8 / 100 | OOS | -11.0% | -11.4% | 1 | 0 |
| DASH | A | robust 25 / 25 / 100 | IS | +177.8% | +176.4% | 1 | 0 |
| DASH | A | robust 25 / 25 / 100 | OOS | 0.0% | 0.0% | 0 | 0 |
| DASH | B | current 25 / 8 / 100 | IS | +75.2% | +74.3% | 1 | 0 |
| DASH | B | current 25 / 8 / 100 | OOS | -11.0% | -11.4% | 1 | 0 |
| DASH | B | robust 25 / 25 / 100 | IS | +177.8% | +176.4% | 1 | 0 |
| DASH | B | robust 25 / 25 / 100 | OOS | 0.0% | 0.0% | 0 | 0 |
| HFT | A | current 20 / 9 / 100 | IS | +319.1% | +317.0% | 1 | 0 |
| HFT | A | current 20 / 9 / 100 | OOS | +88.1% | +87.2% | 1 | 0 |
| HFT | A | robust 40 / 9 / 100 | IS | +393.3% | +390.8% | 1 | 0 |
| HFT | A | robust 40 / 9 / 100 | OOS | +54.1% | +53.3% | 1 | 0 |
| HFT | B | current 20 / 9 / 100 | IS | +319.1% | +317.0% | 1 | 0 |
| HFT | B | current 20 / 9 / 100 | OOS | +48.0% | +43.4% | 4 | 6 |
| HFT | B | robust 30 / 8 / 100 | IS | +345.8% | +343.6% | 1 | 0 |
| HFT | B | robust 30 / 8 / 100 | OOS | +47.5% | +45.5% | 2 | 2 |
| HIGH | A | current 25 / 9 / 100 | IS | +148.8% | +147.5% | 1 | 0 |
| HIGH | A | current 25 / 9 / 100 | OOS | +131.7% | +130.5% | 1 | 0 |
| HIGH | A | robust 15 / 5 / 100 | IS | +322.8% | +320.7% | 1 | 0 |
| HIGH | A | robust 15 / 5 / 100 | OOS | +244.5% | +242.7% | 1 | 0 |
| HIGH | B | current 25 / 9 / 100 | IS | +143.3% | +139.9% | 3 | 2 |
| HIGH | B | current 25 / 9 / 100 | OOS | +131.7% | +130.5% | 1 | 0 |
| HIGH | B | robust 15 / 10 / 100 | IS | +313.4% | +311.4% | 1 | 0 |
| HIGH | B | robust 15 / 10 / 100 | OOS | +131.6% | +127.4% | 3 | 3 |
| HONEY | A | current 40 / 12 / 100 | IS | +721.7% | +717.5% | 1 | 0 |
| HONEY | A | current 40 / 12 / 100 | OOS | +4.9% | +4.4% | 1 | 0 |
| HONEY | A | robust 30 / 5 / 100 | IS | +906.6% | +901.5% | 1 | 0 |
| HONEY | A | robust 30 / 5 / 100 | OOS | +28.6% | +27.9% | 1 | 0 |
| HONEY | B | current 40 / 12 / 100 | IS | +510.9% | +497.0% | 4 | 6 |
| HONEY | B | current 40 / 12 / 100 | OOS | +17.0% | +15.2% | 2 | 2 |
| HONEY | B | robust 15 / 5 / 100 | IS | +764.5% | +760.2% | 1 | 0 |
| HONEY | B | robust 15 / 5 / 100 | OOS | +26.9% | +23.0% | 5 | 7 |
| IDEX | A | current 25 / 9 / 100 | IS | +1466.7% | +1458.8% | 1 | 0 |
| IDEX | A | current 25 / 9 / 100 | OOS | +84.6% | +83.7% | 1 | 0 |
| IDEX | A | robust 30 / 6 / 100 | IS | +1692.5% | +1683.5% | 1 | 0 |
| IDEX | A | robust 30 / 6 / 100 | OOS | +84.6% | +83.7% | 1 | 0 |
| IDEX | B | current 25 / 9 / 100 | IS | +1466.7% | +1458.8% | 1 | 0 |
| IDEX | B | current 25 / 9 / 100 | OOS | +67.1% | +63.3% | 3 | 4 |
| IDEX | B | robust 30 / 6 / 100 | IS | +1692.5% | +1683.5% | 1 | 0 |
| IDEX | B | robust 30 / 6 / 100 | OOS | +147.4% | +135.1% | 10 | 14 |
| JTO | A | current 40 / 25 / 50 | IS | +0.2% | -0.1% | 1 | 0 |
| JTO | A | current 40 / 25 / 50 | OOS | +4.9% | +4.7% | 1 | 0 |
| JTO | A | robust 15 / 5 / 100 | IS | +289.6% | +287.7% | 1 | 0 |
| JTO | A | robust 15 / 5 / 100 | OOS | -5.8% | -6.3% | 1 | 0 |
| JTO | B | current 40 / 25 / 50 | IS | +0.2% | -0.1% | 1 | 0 |
| JTO | B | current 40 / 25 / 50 | OOS | +4.9% | +4.7% | 1 | 0 |
| JTO | B | robust 15 / 5 / 100 | IS | +289.6% | +287.7% | 1 | 0 |
| JTO | B | robust 15 / 5 / 100 | OOS | -5.8% | -6.3% | 1 | 0 |

## Is HIGH's 9% trail too tight, and what would have worked better?

**No, not on this evidence.** On the 26 Sep pump (spike to $0.0456 in the 17:00 UTC hour), the engine's 9% trail sold at $0.0412:
the 18:00 bar opened below the $0.0415 stop. Every wider trail would have sold lower: 10% at $0.0410, 12% at $0.0401, 15% at $0.0388,
20% at $0.0365 and 25% at $0.0342. The price was $0.0357 at 23:00, so by that evening only the 25% trail was behind holding. The 4-minute,
10% dip and bounce is inside one hourly candle, so this test cannot say whether live sold at the bottom of that dip. But the bounce did
not last: every hourly close from 19:00 on was below $0.0385. Over the year, at arm 25%, trails from 5% to 15% gave the same result in both windows,
because the one sale was decided by a gap at an hour's open, not by the trail width. Trails of 20% and 25% did worse: in mode A, IS
+138%/+123% against +149% at 9%, and OOS +119%/+115% against +132%. **What would have worked better was a lower arm, not a wider trail.**
Arm 15% (trail 5-10%) was the robust pick: +245% OOS against +132% in mode A (vs half-cash +49% against 0%). It won because HIGH fell 73%
from June to September and arm 15% sold at the first pump, three months earlier. That is the market direction, one sale, not trail skill.
In mode B, arm 15% / trail 10% scored the same as today OOS (+131.6%). HIGH's in-sample sale on 11 Oct 2025 was a rebound arm after the
crash (FINDINGS T3-2), so the in-sample figures for HIGH are weaker still.

### HIGH: the 26 Sep pump, arm 25, sell 100, each trail (fresh $1000 from 25 Sep 12:00 UTC)

| Trail | Sold at (UTC, hour bar) | Price | vs hold at 26 Sep 23:00 |
|---|---|---|---|
| 5% | 2026-09-26 18:00 | 0.0412 | +14.7% |
| 6% | 2026-09-26 18:00 | 0.0412 | +14.7% |
| 8% | 2026-09-26 18:00 | 0.0412 | +14.7% |
| 9% | 2026-09-26 18:00 | 0.0412 | +14.7% |
| 10% | 2026-09-26 18:00 | 0.04104 | +14.3% |
| 12% | 2026-09-26 18:00 | 0.04013 | +11.7% |
| 15% | 2026-09-26 18:00 | 0.03876 | +7.9% |
| 20% | 2026-09-26 20:00 | 0.03648 | +1.6% |
| 25% | 2026-09-26 20:00 | 0.0342 | -4.8% |

### HIGH: arm 25, sell 100, each trail

| Window | Mode | Trail | vs hold | vs half-cash | Sales | Buy-backs | First sale | Median sale vs arm | Median cycle vs hold (14 d) |
|---|---|---|---|---|---|---|---|---|---|
| IS | A | 5% | +148.8% | -4.9% | 1 | 0 | 2025-10-11 12:00 @ 0.3241 | -16.4% | -5.8% |
| IS | A | 6% | +148.8% | -4.9% | 1 | 0 | 2025-10-11 12:00 @ 0.3241 | -16.4% | -5.8% |
| IS | A | 8% | +148.8% | -4.9% | 1 | 0 | 2025-10-11 12:00 @ 0.3241 | -16.4% | -5.8% |
| IS | A | 9% | +148.8% | -4.9% | 1 | 0 | 2025-10-11 12:00 @ 0.3241 | -16.4% | -5.8% |
| IS | A | 10% | +148.8% | -4.9% | 1 | 0 | 2025-10-11 12:00 @ 0.3241 | -16.4% | -5.8% |
| IS | A | 12% | +148.8% | -4.9% | 1 | 0 | 2025-10-11 12:00 @ 0.3241 | -16.4% | -5.8% |
| IS | A | 15% | +148.8% | -4.9% | 1 | 0 | 2025-10-11 12:00 @ 0.3241 | -16.4% | -5.8% |
| IS | A | 20% | +138.2% | -9.0% | 1 | 0 | 2025-10-11 12:00 @ 0.3103 | -20.0% | -9.3% |
| IS | A | 25% | +123.3% | -14.7% | 1 | 0 | 2025-10-11 20:00 @ 0.2909 | -25.0% | -14.3% |
| IS | B | 5% | +148.3% | -5.1% | 3 | 2 | 2025-10-11 12:00 @ 0.3241 | -9.0% | +1.2% |
| IS | B | 6% | +147.1% | -5.6% | 3 | 2 | 2025-10-11 12:00 @ 0.3241 | -9.0% | +1.2% |
| IS | B | 8% | +144.6% | -6.5% | 3 | 2 | 2025-10-11 12:00 @ 0.3241 | -9.0% | +1.2% |
| IS | B | 9% | +143.3% | -7.0% | 3 | 2 | 2025-10-11 12:00 @ 0.3241 | -9.0% | +1.2% |
| IS | B | 10% | +140.2% | -8.2% | 3 | 2 | 2025-10-11 12:00 @ 0.3241 | -10.0% | +1.2% |
| IS | B | 12% | +139.3% | -8.6% | 3 | 2 | 2025-10-11 12:00 @ 0.3241 | -12.0% | +1.2% |
| IS | B | 15% | +151.3% | -4.0% | 2 | 1 | 2025-10-11 12:00 @ 0.3241 | -15.7% | +8.4% |
| IS | B | 20% | +138.2% | -9.0% | 1 | 0 | 2025-10-11 12:00 @ 0.3103 | -20.0% | -9.3% |
| IS | B | 25% | +123.3% | -14.7% | 1 | 0 | 2025-10-11 20:00 @ 0.2909 | -25.0% | -16.1% |
| OOS | A | 5% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | -11.6% |
| OOS | A | 6% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | -11.6% |
| OOS | A | 8% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | -11.6% |
| OOS | A | 9% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | -11.6% |
| OOS | A | 10% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | -11.6% |
| OOS | A | 12% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | -11.6% |
| OOS | A | 15% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | -11.6% |
| OOS | A | 20% | +119.0% | -5.5% | 1 | 0 | 2026-06-06 11:00 @ 0.07864 | -20.0% | -16.2% |
| OOS | A | 25% | +115.3% | -7.1% | 1 | 0 | 2026-06-06 16:00 @ 0.07733 | -21.3% | +22.6% |
| OOS | B | 5% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | +28.5% |
| OOS | B | 6% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | +28.5% |
| OOS | B | 8% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | +28.5% |
| OOS | B | 9% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | +28.5% |
| OOS | B | 10% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | +28.5% |
| OOS | B | 12% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | +28.5% |
| OOS | B | 15% | +131.7% | -0.0% | 1 | 0 | 2026-06-06 11:00 @ 0.0832 | -15.4% | +28.5% |
| OOS | B | 20% | +119.0% | -5.5% | 1 | 0 | 2026-06-06 11:00 @ 0.07864 | -20.0% | -16.2% |
| OOS | B | 25% | +115.3% | -7.1% | 1 | 0 | 2026-06-06 16:00 @ 0.07733 | -21.3% | +22.6% |

## Does one profile fit most coins?

**No.** All 65 hourly coins were run through the full grid (no floor, because their cost is unknown; modes A and B), with the same
walk-forward. In-sample, the robust single profile across coins was the tightest one, arm 15 / trail 5 / sell 100: median +182% vs hold.
It won by selling at the first twitch in a year when 53 of 60 coins fell. **Out of sample it was the worst of the profiles shown:** median
-16.5% vs hold (-12.7% vs half-cash), and only 12 of 60 coins beat holding. The looser profiles (40/10/100, 50/20/50) scored about 0% OOS
because most coins never triggered them. Today's common live setting, 25/9/100, was in between (-5.1% OOS).
Choosing settings coin by coin (each coin's own robust in-sample pick) did better OOS than the one profile: median -6.7% against -16.5% in
mode A, better on 21 coins and worse on 11; in mode B, -11.2% against -21.2%, better on 38 and worse on 17. But it was still behind
holding for the typical coin, and those picks cluster on the same "sell early" corner (15/5/100 for 25 coins in mode A). So per-coin
settings fit the past better, but none of the choices reliably beat holding when the market turned. The 9 held coins behaved differently
from the 60 OOS because most of them kept falling (HIGH -73%, HFT -47%, IDEX -42%, HONEY -28%), and in a falling market selling is right.

### Cross-coin tables

**Mode A (sell only), 60 coins with data in both windows, no floor:**

| Profile (arm / trail / sell) | IS median vs hold | IS median vs half-cash | OOS median vs hold | OOS median vs half-cash | OOS coins that sold | OOS coins beating hold |
|---|---|---|---|---|---|---|
| best robust single profile: 15 / 5 / 100 | +182.0% | +23.1% | -16.5% | -12.7% | 58 / 60 | 12 / 60 |
| 25 / 9 / 100 | +102.1% | -1.3% | -5.1% | -5.2% | 46 / 60 | 12 / 60 |
| 40 / 10 / 100 | +33.6% | -1.9% | 0.0% | +2.0% | 21 / 60 | 10 / 60 |
| 20 / 6 / 50 | +119.4% | +2.2% | -8.2% | -7.7% | 54 / 60 | 12 / 60 |
| 50 / 20 / 50 | +12.5% | -25.3% | 0.0% | +4.0% | 19 / 60 | 7 / 60 |
| 15 / 5 / 100 | +182.0% | +23.1% | -16.5% | -12.7% | 58 / 60 | 12 / 60 |
| 30 / 15 / 100 | +84.7% | -0.4% | 0.0% | -1.4% | 36 / 60 | 11 / 60 |

Per-coin robust picks (chosen in-sample, scored out-of-sample): median OOS vs hold -6.7% (vs half-cash -8.0%) against -16.5% (-12.7%) for the single profile on the same coins. The per-coin pick did better OOS on 21 coins, worse on 11, the same on the rest. 25 different per-coin picks; the most common: 15 / 5 / 100 (25), 40 / 5 / 100 (4), 30 / 5 / 100 (3), 15 / 5 / 50 (2), 25 / 25 / 100 (2).

**Mode B (engine buy-back), 60 coins with data in both windows, no floor:**

| Profile (arm / trail / sell) | IS median vs hold | IS median vs half-cash | OOS median vs hold | OOS median vs half-cash | OOS coins that sold | OOS coins beating hold |
|---|---|---|---|---|---|---|
| best robust single profile: 15 / 10 / 100 | +162.5% | +15.8% | -21.2% | -19.4% | 58 / 60 | 12 / 60 |
| 25 / 9 / 100 | +96.4% | -2.3% | -3.8% | -2.0% | 46 / 60 | 14 / 60 |
| 40 / 10 / 100 | +21.4% | -13.4% | 0.0% | +3.8% | 21 / 60 | 12 / 60 |
| 20 / 6 / 50 | +99.3% | -3.6% | -8.1% | -6.9% | 54 / 60 | 10 / 60 |
| 50 / 20 / 50 | +4.3% | -31.2% | 0.0% | +3.3% | 19 / 60 | 9 / 60 |
| 15 / 5 / 100 | +150.0% | +22.5% | -18.8% | -18.4% | 58 / 60 | 10 / 60 |
| 30 / 15 / 100 | +71.8% | -2.1% | 0.0% | -1.6% | 36 / 60 | 9 / 60 |

Per-coin robust picks (chosen in-sample, scored out-of-sample): median OOS vs hold -11.2% (vs half-cash -11.4%) against -21.2% (-19.4%) for the single profile on the same coins. The per-coin pick did better OOS on 38 coins, worse on 17, the same on the rest. 28 different per-coin picks; the most common: 15 / 5 / 100 (17), 15 / 8 / 100 (5), 15 / 9 / 100 (4), 30 / 5 / 100 (4), 15 / 20 / 100 (3).

## Files

- `reports/loop-backtest-2026-09-results.json`: the picks (current, robust, best cell; IS and OOS; modes A and B), monthly restarts, the 1.0%
  slippage rerun, the HIGH study and the cross-coin summary.
- `reports/loop-backtest-2026-09-held.csv`: every held-coin grid run (9 coins x 127 settings x 2 windows x 2 modes).
- The 65-coin grid (32,764 runs, 4.6 MB CSV) is summarised above and not committed; regenerate it with the commands in `tools/README.md`.
- `tests/FINDINGS.md` T3-1 to T3-6: what the run showed about the engine.
