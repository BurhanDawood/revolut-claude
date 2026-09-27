# T1 test-suite findings

What writing the T1 suite (tests/money, tests/static) turned up against `main`. The rule for this suite: a test that shows a real bug is
**not** fixed in server.js here. It is written up below and skipped, with a pointer to this file.

## server.js bugs

**None found.** Every money-path guarantee in brief T1 (a–i) holds on main as written. Each test file was also checked by
mutation (the relevant line of a local copy of server.js was broken and the test had to go red), so a pass means something:

| Mutation (local only, never committed) | Caught by |
|---|---|
| autoExecuteSell floor guard `<=` → `<` | AE1 |
| floorCappedLimitSell rounds to the nearest step instead of up | FL1, FL2 |
| spikeLoopArmOver takes the new peak/stop without `Math.max` | SL1 |
| spikeChase ignores `remainder_resting` | SC4 |
| isVenueRefusal treats 5xx as a refusal | HT4, HT7 |
| `hs` removed from CB_TYPES | CB1 |
| setTrailingStop drops the kept `source` | TS5 |
| mayAutoTrade manual_only check removed | MA2 |

## Tests skipped

### F1: `tests/p0/callers.test.mjs` is stale on main (test problem, not a server.js bug)

- **What:** 8 of its 11 tests fail on current main (V33, V33k, V33x, V44, V35+, LA1, V34, V34b).
- **Why:** it was the one-off proof for the #P0 branch. It compares that branch's server.js with the main of that day ("behaviour
  unchanged from main", "mayAutoTrade is called from no order path", "only these functions changed vs main") and pins the exact
  SQL of that time. Main has moved on as intended: `mayAutoTrade` now has callers, `exec_decisions` gained a `path` column
  (`VALUES ('manual', ?, ?, ?, ...)` instead of `'manual'` inline), loop_audit prints "- no live cycle". Run on main, "this branch" and
  "main" are the same file, so the diff assertions cannot hold.
- **Reproduce:** `git fetch origin main && node tests/p0/callers.test.mjs` → `3/11 passed, 8 FAILED`.
- **Status:** skipped in `tests/run-all.mjs` (listed in `SKIPPED`). `tests/p0/predicate.test.mjs` (46 vectors) still runs and passes.
  The file is left as it is; rewriting it as a main-only test is a separate job.

## CI notes (not bugs; things the PR reviewer should know)

- **Railway waits for GitHub checks.** The production service has `checkSuites: true`: a red check on a main commit would **hold the
  deploy**. So on `push` and `workflow_run` the test step is `continue-on-error`: the job ends green, and a failure is shown as an
  error annotation plus a FAIL line in the run summary. On `pull_request` (which never deploys) a failure makes the check red.
  Railway still waits for the run to finish (about a minute).
- **Batch commits do not trigger `push` workflows.** The Apply Batch Patch workflows push with `GITHUB_TOKEN`, and GitHub does not
  start other workflows from such pushes. Since server.js changes only arrive that way, tests.yml also runs on `workflow_run`
  (after Apply Batch Patch / Apply Patch / Apply Approved Spec complete) against the new head of main.
- **package.json is not touched.** Railway's watch patterns include package.json, so editing it would redeploy. acorn is installed
  by CI into `$RUNNER_TEMP`, outside the repo, and passed in with `ACORN_PATH`.

## T2 (price export + offline spike replay)

**Nothing blocks running the live replay offline; server.js is unchanged.** `spikeReplay` and everything it calls (`spikeCfg`,
`spikeMedian`, `spikeReplayCoin`, `SPIKE_DEFAULTS`, `SPIKE_REPLAY_VERSION`; `spikeRef` is extracted too) run as extracted, in a
strict sandbox, with a stub db and a no-op `specNote`. Notes for whoever reads the results (not bugs):

- **T2-1 Timestamps must match `UNIX_TIMESTAMP(hour_bucket)`.** The live replay reads `t` through MySQL's `UNIX_TIMESTAMP` in the
  server's session time zone. The export's `t` must be produced the same way (or both must be UTC), or offline hours would be shifted
  against the live run. The spike rule only uses relative hours, so a constant shift changes nothing except the printed `at`; a DST
  mismatch would. Worth one check against a live `/spike` replay once the export is on.
- **T2-2 Symbol order.** The server's `ORDER BY symbol` uses the column collation (case-insensitive); the stub sorts upper-case first,
  which is the same for the uppercase `XXX-USD` symbols in use. It only affects the order of `per_coin` / `events` (both truncated to 60).
- **T2-3 The replay writes are swallowed.** Offline runs never store `system_config.spike_replay` and never post the spec note, by design.

## T3 (loop settings backtest, tools/backtest/loop-grid.mjs)

**Nothing blocks running the live engine offline; server.js is unchanged.** `runLadderBacktest` and what it calls
(`shadowNewState`, `shadowEvalTier`, `shadowEvalLadder`, `btComputeMetrics`) run as extracted, in a strict sandbox, with a stub db
that answers only the hourly SELECT. The driver adds one read-only tap on `shadowEvalTier` to copy out the fills (the function
returns metrics, not fills); `tests/tools/loop-grid.test.mjs` LG1 proves the tapped, stubbed run deep-equals an untapped run of the
extracted engine. What the run showed about the engine (not fixed here; for the PM):

- **T3-1 Mode C (buy-back safety line measured from cost) is not expressible through runLadderBacktest's options.** The engine has
  no absolute buy-back line at all: its buy-back starts at a retrace gate measured from the cycle's peak and base (`retrace_pct`),
  buys on a `bounce_pct` bounce off the trough, and is capped at the average sale price (`buyback_cap`). None of these can say
  "only if the trough stayed at or above cost x 0.95". Smallest change (two functions, both by name): in `shadowEvalLadder` read
  `buybackFloor: num(cfg.buyback_floor, null)` into `P`, and at the top of its `buy` helper
  `if (P.buybackFloor && state.trough < P.buybackFloor) { rec('buy', tier, trig, price, null, null, false, 'below_buyback_floor'); return 'wait'; }`
  (the trough only falls, so the cycle then waits for the abandon timer, as live's "alert only" does); in `runLadderBacktest` pass
  `buyback_floor: opts.buyback_floor != null ? Number(opts.buyback_floor) : null` into `cfg` (it copies options field by field).
  The report gives, instead of a mode-C result, a diagnostic from mode B's own fills: how many B buy-backs had a trough at or above
  cost x 0.95 (the trough is the fill's trigger / 1.08).
- **T3-2 The engine arms differently from live.** `shadowEvalLadder` (#375) measures the pump from the ROLLING low of the arm window;
  live `checkPumpArm` measures it from the price at the START of the window and resets that baseline when the window expires. So the
  engine arms on a rebound after a crash (HIGH 11 Oct 2025: +25% off the crash wick, still far below the day before) where live
  would not. The driver counts these as `rebound_arms` (arm price below the highest close of the previous 24 h): 5,613 of 35,396
  arms (16%) in the held-coin grid.
- **T3-3 Hourly bars: a sale in the bar that set the peak.** In the armed phase `shadowEvalLadder` raises the peak to the bar's high
  and then tests the bar's LOW against the new stop, i.e. it assumes the high came first. A bar whose range is wider than the trail
  therefore sells, and when its open is below the stop the fill is the open, a price from before the high. Example: HIGH 26 Sep
  17:00, open 0.0339, high 0.0456: every trail of 15% or more "sells" at 0.0339 in that bar, although live sold after the spike. The
  driver counts these as `same_bar_sales`: 4,729 of 14,894 sales (32%) in the held-coin grid. The direction of the error varies
  (pessimistic when the pump came first, as on 26 Sep; optimistic when the dip came first). Hourly candles also cannot see dips
  inside the hour at all (HIGH 26 Sep: -10% in about 4 minutes and back).
- **T3-4 Quantity after a buy-back can go slightly negative.** The ladder state books a buy-back at the fee-free quantity
  (`usd / price`), while `btComputeMetrics` books it net of fee and slippage. A later 100% sale then sells a little more than is held
  (HIGH mode B in-sample: end quantity -0.7% of the start). This is the engine's own documented caveat ("tier sizing uses fee-free
  qty"); it is small against the results but it is why a few `end_qty_pct` values are below zero.
- **T3-5 Mode B is the engine's buy-back, not live's.** Differences that matter: the engine buys 70% of the proceeds on the first
  bounce and the rest after a further 10% drop (live: all proceeds on the first bounce); the engine never buys above the average
  sale price (live: the safety line at sale x 0.95 blocks every buy-back whose trough is below it, which is why live never bought
  back); the engine's retrace gate is measured from the peak and the 24 h low (live: from the sale price and the cost/floor).
- **T3-6 The floor is today's.** Every held-coin run uses today's floor (max(cost x 1.005, stored floor)) for the whole year,
  including months before the coin was bought at that cost. Coins that traded far above today's cost earlier in the year (AST, COTI,
  HIGH, HONEY, IDEX, HFT) are unaffected by the floor then; the floor binds only near today's prices.
