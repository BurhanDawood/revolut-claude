# tools/: offline data and replays

Cloud sessions cannot reach the production MySQL, so replays and backtests used to run only on the live server. The
**Export prices** workflow (`.github/workflows/export-prices.yml`, daily at 04:17 UTC) copies the PRICE history into the orphan
branch **`data-prices`** (one commit, rewritten each run; market prices only, no holdings, balances, orders or trades):

| File on `data-prices` | What |
|---|---|
| `data/prices/hourly.ndjson.gz` | `price_intraday_hourly` (~1 year): `{"s":"WIF-USD","t":1727222400,"o":..,"h":..,"l":..,"c":..,"n":12}`, t = hour start, unix s UTC |
| `data/prices/daily.ndjson.gz` | `price_daily_ohlc` (2.5+ years): `{"s":"BTC-USD","d":"2026-09-25","o":..,"h":..,"l":..,"c":..,"src":"venue"}`, d = London date |
| `data/prices/MANIFEST.json` | per table: rows, symbols, first/last time, sha256; plus server_sha, export time, workflow run id |

## Run the spike replay offline (three commands)

```sh
# 1. fetch the data into a worktree next to the repo (../data-prices); nothing is added to your branch
git fetch origin data-prices && git worktree add --detach ../data-prices origin/data-prices

# 2. run the LIVE #B23 spike replay (spikeReplay from server.js) on it; the summary prints, --json gives the full object
node tools/replay/spike-replay.mjs --json > /tmp/spike-replay.json

# 3. read the output
node -e "const o=require('/tmp/spike-replay.json'); console.log(o.coins, o.hours, o.naive_triggers, o.a1_triggers, o.outcomes)"
```

Refresh later with `git -C ../data-prices fetch origin data-prices && git -C ../data-prices checkout --detach FETCH_HEAD`.
Other data locations: `--dir <path to data/prices>` or `PRICES_DIR=...`. `--cfg '{"trail_pct":20}'` replays with a spike_exit override.
The loader checks each file's sha256 against MANIFEST.json and refuses a mismatch.

## Add another replay (same pattern)

1. **Extract by name, never by line number:** `extractFunction(readServer(), 'fooReplay')` / `extractConst(...)` from `tests/lib.mjs`,
   for the replay function and everything it calls. Run them in `strictSandbox` so a helper you did not provide is a
   ReferenceError that names it, instead of a silent fallback.
2. **Stub the db:** answer exactly the SELECTs the function sends (match the normalised SQL text) from `loadPrices()`
   (`tools/data/load.mjs`: per-symbol arrays, oldest first), return defaults for its config reads, swallow writes, and
   **reject and record any other query** (check the record after the run: the live code often `.catch`es its own errors).
   `tools/replay/spike-replay.mjs` (`makeStubDb`, `runSpikeReplay`) is the template.
3. **Test parity** in `tests/tools/`: on a small synthetic dataset, the driver's output must equal what the extracted pure
   function gives when called directly. Never re-implement the logic; if it cannot run offline without changing server.js,
   write that up in `tests/FINDINGS.md` instead.

## Files

| File | What |
|---|---|
| `tools/data/validate.mjs` | page validator, whole-table order check, shrink guard, MANIFEST builder; the CLI the workflow runs |
| `tools/data/load.mjs` | reads `data/prices/*.ndjson.gz` into per-symbol arrays after the sha256 check |
| `tools/replay/spike-replay.mjs` | offline driver for the live `spikeReplay` (stub db, no-op `specNote`) |
