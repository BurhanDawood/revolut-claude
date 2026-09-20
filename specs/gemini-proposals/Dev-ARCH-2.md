# Dev-ARCH-2

TARGET_FILE: ARCHITECTURE.md
BASE_SHA: ecdb0450f3acdaf8c160828b38d57661b2550e7c8e4b718ab80e67faccf1aa21
BASE_COMMIT: fd57fef87501b0ca4a903ebbd186476943931870
DRAFTED: 2026-09-20T21:55:09.164Z
BLOCKS: 5

---
### Problem, Changes & Rationale

**1. Header Refresh:**
- Updated top staleness markers (`<!-- last-updated: 2026-09-20 -->` and `**Last updated:** 2026-09-20.`) to reflect the September 2026 documentation refresh.
- Prepend the current period's ticket milestones (#327, #326, #319, #316, #315, #314, #312) to the parenthetical summary list in reverse chronological order while preserving all existing entries.

**2. Database Connection Handling (#327):**
- Updated §1 (Stack) and §4 (Key Design Decisions) to reflect the shift from a single `mysql.createConnection` instance to `mysql.createPool` with `connectionLimit: 10`, `waitForConnections: true`, `enableKeepAlive: true`, and `keepAliveInitialDelay: 10000`.
- Documented the operational cause: on 19 Sept 2026, a dropped single MySQL connection caused all DB-dependent tasks (price capture, order polling, portfolio checks, shadow evaluation, baselines) to fail continuously for >2 hours while Express remained healthy, preventing automatic platform restarts. Recorded that a dedicated DB health check endpoint with alerting remains outstanding.

**3. Buyback Floor Anchoring & Pause Behavior (#314):**
- Updated §3 (#130 Trough-rebuy tracker) to record that the buyback floor is now anchored to `sale_price` of the cycle, falling back to `entry_floor` only when `sale_price` is null (eliminating false floor breaches caused by stale cost basis).
- Documented that floor breaches now pause the tracker and emit an hourly rate-limited Telegram alert instead of invoking `clearTroughTracker` (which previously destroyed active cycles). Recorded that `buyback_floor_pct` is now configurable via `set_pump_armed_rule` and noted the deliberate safety principle: the floor guard was not loosened because deep drops may indicate delistings or exploits, leaving judgement with Bryan.

**4. Backtest Data Sources (#319):**
- Updated §3 (#312 Strategy engine and backtest harness) to record that `source=hourly` queries `price_intraday_hourly` using `open_px`, `high_px`, `low_px`, and `close_px`. Noted that the previous query referenced non-existent columns (`open_price` etc.), causing every hourly backtest to fail and silently confining backtests to the ~30-day intraday window.

**5. Known Live/Backtest Divergence (#309):**
- Documented in §3 (#312 Strategy engine and backtest harness) that the live execution path re-anchors trailing stops on floor-blocked sales and maintains armed state (#309), whereas the backtest evaluator (`shadowEvalTier`) consumes tiers on `below_entry_floor`. Noted that backtests currently understate performance for floor-limited positions until aligned.

---

### Notes & Verification
- **Anchors Used:** 
  1. Header comment & metadata block (Lines 1–6).
  2. §1 System Overview Stack list.
  3. §4 Key Design Decisions (MySQL entry).
  4. §3 Subsystem Map (#130 Trough-rebuy tracker entry).
  5. §3 Subsystem Map (#312 Strategy engine and backtest harness entry).
- **Database Connection Finding:** `ARCHITECTURE.md` previously only listed `- **Database:** MySQL on Railway.` without specifying connection mechanism details. I updated §1 Stack with the exact pool parameters and added a dedicated design decision entry in §4 recording the operational lesson and missing health-check alert.
- **Verification against `server.js`:**
  - Verified `mysql.createPool` options (`connectionLimit: 10`, `waitForConnections: true`, `enableKeepAlive: true`, `keepAliveInitialDelay: 10000`).
  - Verified `source=hourly` column names in `runLadderBacktest` (`open_px`, `high_px`, `low_px`, `close_px`).
  - Verified `armReboundTracker` / `updateTroughTracker` anchoring logic (`salePrice` fallback to `entryFloor`) and rate-limited floor breach alert behavior.
  - Verified #309 re-anchoring logic inside `handleTrailingStopAlert` vs `shadowEvalTier`.
- **What was NOT checked:** Did not run a live execution or backtest sweep against live Railway DB. All verifications were done against static code in `server.js` and `ARCHITECTURE.md`.
- **Blast Radius:** Documentation file (`ARCHITECTURE.md`) only. No executable code or live trading paths modified.

---

<<<<<<< SEARCH
<!-- last-updated: 2026-08-01 -->
# ARCHITECTURE.md — Revolut X AI Portfolio Manager

> **Purpose of this document.** This is the single durable reference for how the system is built, how data flows through it, what each subsystem does, and *why* the major design decisions were made. It exists because the build history was previously fragmented across 100+ dev_log tickets, git commits, Claude's cross-session memory, and conversation logs — making "how does X work / why is it this way" a reconstruction job. Maintain this file: when a major subsystem ships or a load-bearing decision changes, update the relevant section. The live ticket board remains the `dev_log` (see §7); this document is the map, not the changelog.
>
> **Owner:** Bryan. **Last updated:** 2026-08-01. (#259 read-only backtest surface -- `get_price_series`, `get_abnormal_events`, `volatility_baseline`, `price_intraday_hourly` rollup; #261 Parts B+C `dev_recommendations` + friction aggregator; #279 `retrace_pct`/`bounce_pct` setters; #281 config merge-not-replace; #282 step 2 tier config schema + cumulative-cap validator; #278 `reset_cycle`. Earlier 2026-07-22: #262 cross-asset synthesis + conviction + thesis-nudge layer -- `get_asset_synthesis`, `asset_thesis`/`log_thesis` bear-case gate, nudge detector + passive Telegram push deliberately enabled 2026-07-19; #261 Part A Dev health snapshot `dev_health`; earlier 2026-07-01: #61 source-feeds subsystem -- YouTube/RSS content intelligence, `manage_sources` MCP tool; hardening chain #177/#180 coin_tags, #181 get_items binding, #184 YouTube transcript, #182/#183 pending-status, #185 tool retrieval; #47 B2b partial-fill pipeline; earlier 2026-06-25: #32 DND mode; #155/#156 Away Mode rung lifecycle; #150/#157 alert reminder fix; #149 batch alert reply; #159/#160 DND trough-rebuy + payment mask; #158 trade-detect prominence; #153 DND master check; #148 batch alert resolution; #161 Away Mode dust-guard exemption; #147 Away Mode cooldown notify; earlier 2026-06-23: #50C correlation guard; #144 per-rung sell_pct; #145 away_buy_usd + set_away_sell; #146 payment partial-offset; #53 concentration; #54 emotion x outcome; #51 pre-trade checklist.)
=======
<!-- last-updated: 2026-09-20 -->
# ARCHITECTURE.md — Revolut X AI Portfolio Manager

> **Purpose of this document.** This is the single durable reference for how the system is built, how data flows through it, what each subsystem does, and *why* the major design decisions were made. It exists because the build history was previously fragmented across 100+ dev_log tickets, git commits, Claude's cross-session memory, and conversation logs — making "how does X work / why is it this way" a reconstruction job. Maintain this file: when a major subsystem ships or a load-bearing decision changes, update the relevant section. The live ticket board remains the `dev_log` (see §7); this document is the map, not the changelog.
>
> **Owner:** Bryan. **Last updated:** 2026-09-20. (#327 connection pool; #326 Build 1 authoritative order reads; #319 hourly backtest source fix; #316 two-way Telegram; #315 re-arming ladder (backtest only); #314 buyback floor anchor and pause-not-clear; #312 strategy engine and backtest harness; #259 read-only backtest surface -- `get_price_series`, `get_abnormal_events`, `volatility_baseline`, `price_intraday_hourly` rollup; #261 Parts B+C `dev_recommendations` + friction aggregator; #279 `retrace_pct`/`bounce_pct` setters; #281 config merge-not-replace; #282 step 2 tier config schema + cumulative-cap validator; #278 `reset_cycle`. Earlier 2026-07-22: #262 cross-asset synthesis + conviction + thesis-nudge layer -- `get_asset_synthesis`, `asset_thesis`/`log_thesis` bear-case gate, nudge detector + passive Telegram push deliberately enabled 2026-07-19; #261 Part A Dev health snapshot `dev_health`; earlier 2026-07-01: #61 source-feeds subsystem -- YouTube/RSS content intelligence, `manage_sources` MCP tool; hardening chain #177/#180 coin_tags, #181 get_items binding, #184 YouTube transcript, #182/#183 pending-status, #185 tool retrieval; #47 B2b partial-fill pipeline; earlier 2026-06-25: #32 DND mode; #155/#156 Away Mode rung lifecycle; #150/#157 alert reminder fix; #149 batch alert reply; #159/#160 DND trough-rebuy + payment mask; #158 trade-detect prominence; #153 DND master check; #148 batch alert resolution; #161 Away Mode dust-guard exemption; #147 Away Mode cooldown notify; earlier 2026-06-23: #50C correlation guard; #144 per-rung sell_pct; #145 away_buy_usd + set_away_sell; #146 payment partial-offset; #53 concentration; #54 emotion x outcome; #51 pre-trade checklist.)
>>>>>>> REPLACE

<<<<<<< SEARCH
**Stack**
- **Runtime:** Node.js (v22) / Express, single `server.js` (~15,200 lines).
- **Database:** MySQL on Railway.
- **Hosting:** Railway (service `revolut-claude-production.up.railway.app`), 1 replica, US-West, deploys from GitHub on push.
=======
**Stack**
- **Runtime:** Node.js (v22) / Express, single `server.js` (~15,200 lines).
- **Database:** MySQL on Railway (`mysql.createPool` with `connectionLimit: 10`, `waitForConnections: true`, `enableKeepAlive: true`, `keepAliveInitialDelay: 10000`).
- **Hosting:** Railway (service `revolut-claude-production.up.railway.app`), 1 replica, US-West, deploys from GitHub on push.
>>>>>>> REPLACE

<<<<<<< SEARCH
- **#130 — Trough-rebuy tracker.** After pump-loop auto-sell, `armReboundTracker` stores sale price and ringfenced `sale_proceeds_usd` in `pump_armed_rules`. Fast-scan Part C tracks retrace, ratchets trough lower. On bounce above `entry_floor*(1-buyback_floor_pct/100)`: crash-safe-clear-first buy and `rearmPumpLoopAfterBuyback`. Below floor: Telegram alert and clear, Bryan decides manually.
=======
- **#130 — Trough-rebuy tracker (#314 updated).** After pump-loop auto-sell, `armReboundTracker` stores sale price and ringfenced `sale_proceeds_usd` in `pump_armed_rules`. Fast-scan Part C tracks retrace, ratchets trough lower. On bounce, the buyback floor is anchored to the cycle's SALE PRICE (`sale_price*(1-buyback_floor_pct/100)`), falling back to `entry_floor` only if `sale_price` is null (previously anchored to `entry_floor`, which refused rebuys >5% below an entry price that could be months stale). On a floor breach, the tracker is PAUSED and an hourly rate-limited Telegram alert sent, rather than calling `clearTroughTracker` (which destroyed the cycle). `buyback_floor_pct` is settable via `set_pump_armed_rule`. Design principle: the floor guard itself was NOT loosened because a deep drop may signal a delisting or exploit rather than a retrace (judgement remains Bryan's) — the fix pauses and asks instead of silently discarding.
>>>>>>> REPLACE

<<<<<<< SEARCH
- **#312 — Strategy engine and backtest harness.** `runLadderBacktest` and the `run_backtest` MCP tool replay the exact same evaluator used by the live shadow engine (`shadowEvalTier`) over historical price bars and score the results against buy-and-hold benchmarks via `btComputeMetrics`. The engine operates strictly read-only: it places no venue orders and mutates no live state. It supports two storage backends: 2-minute `price_intraday` captures (high fidelity for fine trigger detection, pruned at 30 days) and the `price_intraday_hourly` OHLC rollup (retained indefinitely to eliminate the 30-day backtest window ceiling). The subsystem also establishes a formal strategy catalogue in MySQL (`strategy_scenarios` and `strategy_tools` tables, seeded via `seedStrategyCatalogue` and managed via `manage_trading action='upsert_catalogue'`) mapping market regimes to mechanism applicability.
=======
- **#312 — Strategy engine and backtest harness.** `runLadderBacktest` and the `run_backtest` MCP tool replay the exact same evaluator used by the live shadow engine (`shadowEvalTier`) over historical price bars and score the results against buy-and-hold benchmarks via `btComputeMetrics`. The engine operates strictly read-only: it places no venue orders and mutates no live state. It supports two storage backends: 2-minute `price_intraday` captures (high fidelity for fine trigger detection, pruned at 30 days) and the `price_intraday_hourly` OHLC rollup (retained indefinitely to eliminate the 30-day backtest window ceiling). **Data source fix (#319):** `source=hourly` queries `price_intraday_hourly` using columns `open_px`, `high_px`, `low_px`, and `close_px` (previously queried `open_price` etc., which do not exist, causing every hourly backtest to fail and silently confining analysis to the ~4-week intraday window). **Known live/backtest divergence (#309):** the LIVE path re-anchors the trailing stop on a floor-blocked sale and keeps the rule armed, whereas the BACKTEST evaluator consumes the tier on `below_entry_floor`; as a result, backtests currently understate performance for floor-limited positions until aligned. The subsystem also establishes a formal strategy catalogue in MySQL (`strategy_scenarios` and `strategy_tools` tables, seeded via `seedStrategyCatalogue` and managed via `manage_trading action='upsert_catalogue'`) mapping market regimes to mechanism applicability.
>>>>>>> REPLACE

<<<<<<< SEARCH
- **MySQL on Railway, single `server.js`.** One deploy target, one process, one DB; simple to reason about and cheap to run for a single user. Not split into services because the operational surface (one owner, one portfolio) doesn't justify the complexity.
=======
- **MySQL on Railway, single `server.js`.** One deploy target, one process, one DB; simple to reason about and cheap to run for a single user. Not split into services because the operational surface (one owner, one portfolio) doesn't justify the complexity.
- **Connection pool over single connection (#327).** Switched from a single `mysql.createConnection` to `mysql.createPool` (`connectionLimit: 10`, `waitForConnections: true`, `enableKeepAlive: true`, `keepAliveInitialDelay: 10000`). Operational lesson: a single `mysql.createConnection` has no automatic reconnect, so when the Railway MySQL connection dropped on 19 Sept 2026, every DB-dependent subsystem (price capture, order polling, portfolio checks, shadow evaluation, baselines) failed continuously for >2 hours while Express stayed up and reported the deployment healthy, preventing platform restart. Note: an explicit DB health check endpoint with alerting remains outstanding.
>>>>>>> REPLACE

---
## DEPLOYER DATA

Verify each anchor is unique before approving.

### Block 1 of 5

SEARCH_BASE64:
```text
PCEtLSBsYXN0LXVwZGF0ZWQ6IDIwMjYtMDgtMDEgLS0+CiMgQVJDSElURUNUVVJFLm1kIOKAlCBSZXZvbHV0IFggQUkgUG9ydGZvbGlvIE1hbmFnZXIKCj4gKipQdXJwb3NlIG9mIHRoaXMgZG9jdW1lbnQuKiogVGhpcyBpcyB0aGUgc2luZ2xlIGR1cmFibGUgcmVmZXJlbmNlIGZvciBob3cgdGhlIHN5c3RlbSBpcyBidWlsdCwgaG93IGRhdGEgZmxvd3MgdGhyb3VnaCBpdCwgd2hhdCBlYWNoIHN1YnN5c3RlbSBkb2VzLCBhbmQgKndoeSogdGhlIG1ham9yIGRlc2lnbiBkZWNpc2lvbnMgd2VyZSBtYWRlLiBJdCBleGlzdHMgYmVjYXVzZSB0aGUgYnVpbGQgaGlzdG9yeSB3YXMgcHJldmlvdXNseSBmcmFnbWVudGVkIGFjcm9zcyAxMDArIGRldl9sb2cgdGlja2V0cywgZ2l0IGNvbW1pdHMsIENsYXVkZSdzIGNyb3NzLXNlc3Npb24gbWVtb3J5LCBhbmQgY29udmVyc2F0aW9uIGxvZ3Mg4oCUIG1ha2luZyAiaG93IGRvZXMgWCB3b3JrIC8gd2h5IGlzIGl0IHRoaXMgd2F5IiBhIHJlY29uc3RydWN0aW9uIGpvYi4gTWFpbnRhaW4gdGhpcyBmaWxlOiB3aGVuIGEgbWFqb3Igc3Vic3lzdGVtIHNoaXBzIG9yIGEgbG9hZC1iZWFyaW5nIGRlY2lzaW9uIGNoYW5nZXMsIHVwZGF0ZSB0aGUgcmVsZXZhbnQgc2VjdGlvbi4gVGhlIGxpdmUgdGlja2V0IGJvYXJkIHJlbWFpbnMgdGhlIGBkZXZfbG9nYCAoc2VlIMKnNyk7IHRoaXMgZG9jdW1lbnQgaXMgdGhlIG1hcCwgbm90IHRoZSBjaGFuZ2Vsb2cuCj4KPiAqKk93bmVyOioqIEJyeWFuLiAqKkxhc3QgdXBkYXRlZDoqKiAyMDI2LTA4LTAxLiAoIzI1OSByZWFkLW9ubHkgYmFja3Rlc3Qgc3VyZmFjZSAtLSBgZ2V0X3ByaWNlX3Nlcmllc2AsIGBnZXRfYWJub3JtYWxfZXZlbnRzYCwgYHZvbGF0aWxpdHlfYmFzZWxpbmVgLCBgcHJpY2VfaW50cmFkYXlfaG91cmx5YCByb2xsdXA7ICMyNjEgUGFydHMgQitDIGBkZXZfcmVjb21tZW5kYXRpb25zYCArIGZyaWN0aW9uIGFnZ3JlZ2F0b3I7ICMyNzkgYHJldHJhY2VfcGN0YC9gYm91bmNlX3BjdGAgc2V0dGVyczsgIzI4MSBjb25maWcgbWVyZ2Utbm90LXJlcGxhY2U7ICMyODIgc3RlcCAyIHRpZXIgY29uZmlnIHNjaGVtYSArIGN1bXVsYXRpdmUtY2FwIHZhbGlkYXRvcjsgIzI3OCBgcmVzZXRfY3ljbGVgLiBFYXJsaWVyIDIwMjYtMDctMjI6ICMyNjIgY3Jvc3MtYXNzZXQgc3ludGhlc2lzICsgY29udmljdGlvbiArIHRoZXNpcy1udWRnZSBsYXllciAtLSBgZ2V0X2Fzc2V0X3N5bnRoZXNpc2AsIGBhc3NldF90aGVzaXNgL2Bsb2dfdGhlc2lzYCBiZWFyLWNhc2UgZ2F0ZSwgbnVkZ2UgZGV0ZWN0b3IgKyBwYXNzaXZlIFRlbGVncmFtIHB1c2ggZGVsaWJlcmF0ZWx5IGVuYWJsZWQgMjAyNi0wNy0xOTsgIzI2MSBQYXJ0IEEgRGV2IGhlYWx0aCBzbmFwc2hvdCBgZGV2X2hlYWx0aGA7IGVhcmxpZXIgMjAyNi0wNy0wMTogIzYxIHNvdXJjZS1mZWVkcyBzdWJzeXN0ZW0gLS0gWW91VHViZS9SU1MgY29udGVudCBpbnRlbGxpZ2VuY2UsIGBtYW5hZ2Vfc291cmNlc2AgTUNQIHRvb2w7IGhhcmRlbmluZyBjaGFpbiAjMTc3LyMxODAgY29pbl90YWdzLCAjMTgxIGdldF9pdGVtcyBiaW5kaW5nLCAjMTg0IFlvdVR1YmUgdHJhbnNjcmlwdCwgIzE4Mi8jMTgzIHBlbmRpbmctc3RhdHVzLCAjMTg1IHRvb2wgcmV0cmlldmFsOyAjNDcgQjJiIHBhcnRpYWwtZmlsbCBwaXBlbGluZTsgZWFybGllciAyMDI2LTA2LTI1OiAjMzIgRE5EIG1vZGU7ICMxNTUvIzE1NiBBd2F5IE1vZGUgcnVuZyBsaWZlY3ljbGU7ICMxNTAvIzE1NyBhbGVydCByZW1pbmRlciBmaXg7ICMxNDkgYmF0Y2ggYWxlcnQgcmVwbHk7ICMxNTkvIzE2MCBETkQgdHJvdWdoLXJlYnV5ICsgcGF5bWVudCBtYXNrOyAjMTU4IHRyYWRlLWRldGVjdCBwcm9taW5lbmNlOyAjMTUzIERORCBtYXN0ZXIgY2hlY2s7ICMxNDggYmF0Y2ggYWxlcnQgcmVzb2x1dGlvbjsgIzE2MSBBd2F5IE1vZGUgZHVzdC1ndWFyZCBleGVtcHRpb247ICMxNDcgQXdheSBNb2RlIGNvb2xkb3duIG5vdGlmeTsgZWFybGllciAyMDI2LTA2LTIzOiAjNTBDIGNvcnJlbGF0aW9uIGd1YXJkOyAjMTQ0IHBlci1ydW5nIHNlbGxfcGN0OyAjMTQ1IGF3YXlfYnV5X3VzZCArIHNldF9hd2F5X3NlbGw7ICMxNDYgcGF5bWVudCBwYXJ0aWFsLW9mZnNldDsgIzUzIGNvbmNlbnRyYXRpb247ICM1NCBlbW90aW9uIHggb3V0Y29tZTsgIzUxIHByZS10cmFkZSBjaGVja2xpc3QuKQ==
```

REPLACE_BASE64:
```text
PCEtLSBsYXN0LXVwZGF0ZWQ6IDIwMjYtMDktMjAgLS0+CiMgQVJDSElURUNUVVJFLm1kIOKAlCBSZXZvbHV0IFggQUkgUG9ydGZvbGlvIE1hbmFnZXIKCj4gKipQdXJwb3NlIG9mIHRoaXMgZG9jdW1lbnQuKiogVGhpcyBpcyB0aGUgc2luZ2xlIGR1cmFibGUgcmVmZXJlbmNlIGZvciBob3cgdGhlIHN5c3RlbSBpcyBidWlsdCwgaG93IGRhdGEgZmxvd3MgdGhyb3VnaCBpdCwgd2hhdCBlYWNoIHN1YnN5c3RlbSBkb2VzLCBhbmQgKndoeSogdGhlIG1ham9yIGRlc2lnbiBkZWNpc2lvbnMgd2VyZSBtYWRlLiBJdCBleGlzdHMgYmVjYXVzZSB0aGUgYnVpbGQgaGlzdG9yeSB3YXMgcHJldmlvdXNseSBmcmFnbWVudGVkIGFjcm9zcyAxMDArIGRldl9sb2cgdGlja2V0cywgZ2l0IGNvbW1pdHMsIENsYXVkZSdzIGNyb3NzLXNlc3Npb24gbWVtb3J5LCBhbmQgY29udmVyc2F0aW9uIGxvZ3Mg4oCUIG1ha2luZyAiaG93IGRvZXMgWCB3b3JrIC8gd2h5IGlzIGl0IHRoaXMgd2F5IiBhIHJlY29uc3RydWN0aW9uIGpvYi4gTWFpbnRhaW4gdGhpcyBmaWxlOiB3aGVuIGEgbWFqb3Igc3Vic3lzdGVtIHNoaXBzIG9yIGEgbG9hZC1iZWFyaW5nIGRlY2lzaW9uIGNoYW5nZXMsIHVwZGF0ZSB0aGUgcmVsZXZhbnQgc2VjdGlvbi4gVGhlIGxpdmUgdGlja2V0IGJvYXJkIHJlbWFpbnMgdGhlIGBkZXZfbG9nYCAoc2VlIMKnNyk7IHRoaXMgZG9jdW1lbnQgaXMgdGhlIG1hcCwgbm90IHRoZSBjaGFuZ2Vsb2cuCj4KPiAqKk93bmVyOioqIEJyeWFuLiAqKkxhc3QgdXBkYXRlZDoqKiAyMDI2LTA5LTIwLiAoIzMyNyBjb25uZWN0aW9uIHBvb2w7ICMzMjYgQnVpbGQgMSBhdXRob3JpdGF0aXZlIG9yZGVyIHJlYWRzOyAjMzE5IGhvdXJseSBiYWNrdGVzdCBzb3VyY2UgZml4OyAjMzE2IHR3by13YXkgVGVsZWdyYW07ICMzMTUgcmUtYXJtaW5nIGxhZGRlciAoYmFja3Rlc3Qgb25seSk7ICMzMTQgYnV5YmFjayBmbG9vciBhbmNob3IgYW5kIHBhdXNlLW5vdC1jbGVhcjsgIzMxMiBzdHJhdGVneSBlbmdpbmUgYW5kIGJhY2t0ZXN0IGhhcm5lc3M7ICMyNTkgcmVhZC1vbmx5IGJhY2t0ZXN0IHN1cmZhY2UgLS0gYGdldF9wcmljZV9zZXJpZXNgLCBgZ2V0X2Fibm9ybWFsX2V2ZW50c2AsIGB2b2xhdGlsaXR5X2Jhc2VsaW5lYCwgYHByaWNlX2ludHJhZGF5X2hvdXJseWAgcm9sbHVwOyAjMjYxIFBhcnRzIEIrQyBgZGV2X3JlY29tbWVuZGF0aW9uc2AgKyBmcmljdGlvbiBhZ2dyZWdhdG9yOyAjMjc5IGByZXRyYWNlX3BjdGAvYGJvdW5jZV9wY3RgIHNldHRlcnM7ICMyODEgY29uZmlnIG1lcmdlLW5vdC1yZXBsYWNlOyAjMjgyIHN0ZXAgMiB0aWVyIGNvbmZpZyBzY2hlbWEgKyBjdW11bGF0aXZlLWNhcCB2YWxpZGF0b3I7ICMyNzggYHJlc2V0X2N5Y2xlYC4gRWFybGllciAyMDI2LTA3LTIyOiAjMjYyIGNyb3NzLWFzc2V0IHN5bnRoZXNpcyArIGNvbnZpY3Rpb24gKyB0aGVzaXMtbnVkZ2UgbGF5ZXIgLS0gYGdldF9hc3NldF9zeW50aGVzaXNgLCBgYXNzZXRfdGhlc2lzYC9gbG9nX3RoZXNpc2AgYmVhci1jYXNlIGdhdGUsIG51ZGdlIGRldGVjdG9yICsgcGFzc2l2ZSBUZWxlZ3JhbSBwdXNoIGRlbGliZXJhdGVseSBlbmFibGVkIDIwMjYtMDctMTk7ICMyNjEgUGFydCBBIERldiBoZWFsdGggc25hcHNob3QgYGRldl9oZWFsdGhgOyBlYXJsaWVyIDIwMjYtMDctMDE6ICM2MSBzb3VyY2UtZmVlZHMgc3Vic3lzdGVtIC0tIFlvdVR1YmUvUlNTIGNvbnRlbnQgaW50ZWxsaWdlbmNlLCBgbWFuYWdlX3NvdXJjZXNgIE1DUCB0b29sOyBoYXJkZW5pbmcgY2hhaW4gIzE3Ny8jMTgwIGNvaW5fdGFncywgIzE4MSBnZXRfaXRlbXMgYmluZGluZywgIzE4NCBZb3VUdWJlIHRyYW5zY3JpcHQsICMxODIvIzE4MyBwZW5kaW5nLXN0YXR1cywgIzE4NSB0b29sIHJldHJpZXZhbDsgIzQ3IEIyYiBwYXJ0aWFsLWZpbGwgcGlwZWxpbmU7IGVhcmxpZXIgMjAyNi0wNi0yNTogIzMyIERORCBtb2RlOyAjMTU1LyMxNTYgQXdheSBNb2RlIHJ1bmcgbGlmZWN5Y2xlOyAjMTUwLyMxNTcgYWxlcnQgcmVtaW5kZXIgZml4OyAjMTQ5IGJhdGNoIGFsZXJ0IHJlcGx5OyAjMTU5LyMxNjAgRE5EIHRyb3VnaC1yZWJ1eSArIHBheW1lbnQgbWFzazsgIzE1OCB0cmFkZS1kZXRlY3QgcHJvbWluZW5jZTsgIzE1MyBETkQgbWFzdGVyIGNoZWNrOyAjMTQ4IGJhdGNoIGFsZXJ0IHJlc29sdXRpb247ICMxNjEgQXdheSBNb2RlIGR1c3QtZ3VhcmQgZXhlbXB0aW9uOyAjMTQ3IEF3YXkgTW9kZSBjb29sZG93biBub3RpZnk7IGVhcmxpZXIgMjAyNi0wNi0yMzogIzUwQyBjb3JyZWxhdGlvbiBndWFyZDsgIzE0NCBwZXItcnVuZyBzZWxsX3BjdDsgIzE0NSBhd2F5X2J1eV91c2QgKyBzZXRfYXdheV9zZWxsOyAjMTQ2IHBheW1lbnQgcGFydGlhbC1vZmZzZXQ7ICM1MyBjb25jZW50cmF0aW9uOyAjNTQgZW1vdGlvbiB4IG91dGNvbWU7ICM1MSBwcmUtdHJhZGUgY2hlY2tsaXN0Lik=
```

### Block 2 of 5

SEARCH_BASE64:
```text
KipTdGFjayoqCi0gKipSdW50aW1lOioqIE5vZGUuanMgKHYyMikgLyBFeHByZXNzLCBzaW5nbGUgYHNlcnZlci5qc2AgKH4xNSwyMDAgbGluZXMpLgotICoqRGF0YWJhc2U6KiogTXlTUUwgb24gUmFpbHdheS4KLSAqKkhvc3Rpbmc6KiogUmFpbHdheSAoc2VydmljZSBgcmV2b2x1dC1jbGF1ZGUtcHJvZHVjdGlvbi51cC5yYWlsd2F5LmFwcGApLCAxIHJlcGxpY2EsIFVTLVdlc3QsIGRlcGxveXMgZnJvbSBHaXRIdWIgb24gcHVzaC4=
```

REPLACE_BASE64:
```text
KipTdGFjayoqCi0gKipSdW50aW1lOioqIE5vZGUuanMgKHYyMikgLyBFeHByZXNzLCBzaW5nbGUgYHNlcnZlci5qc2AgKH4xNSwyMDAgbGluZXMpLgotICoqRGF0YWJhc2U6KiogTXlTUUwgb24gUmFpbHdheSAoYG15c3FsLmNyZWF0ZVBvb2xgIHdpdGggYGNvbm5lY3Rpb25MaW1pdDogMTBgLCBgd2FpdEZvckNvbm5lY3Rpb25zOiB0cnVlYCwgYGVuYWJsZUtlZXBBbGl2ZTogdHJ1ZWAsIGBrZWVwQWxpdmVJbml0aWFsRGVsYXk6IDEwMDAwYCkuCi0gKipIb3N0aW5nOioqIFJhaWx3YXkgKHNlcnZpY2UgYHJldm9sdXQtY2xhdWRlLXByb2R1Y3Rpb24udXAucmFpbHdheS5hcHBgKSwgMSByZXBsaWNhLCBVUy1XZXN0LCBkZXBsb3lzIGZyb20gR2l0SHViIG9uIHB1c2gu
```

### Block 3 of 5

SEARCH_BASE64:
```text
LSAqKiMxMzAg4oCUIFRyb3VnaC1yZWJ1eSB0cmFja2VyLioqIEFmdGVyIHB1bXAtbG9vcCBhdXRvLXNlbGwsIGBhcm1SZWJvdW5kVHJhY2tlcmAgc3RvcmVzIHNhbGUgcHJpY2UgYW5kIHJpbmdmZW5jZWQgYHNhbGVfcHJvY2VlZHNfdXNkYCBpbiBgcHVtcF9hcm1lZF9ydWxlc2AuIEZhc3Qtc2NhbiBQYXJ0IEMgdHJhY2tzIHJldHJhY2UsIHJhdGNoZXRzIHRyb3VnaCBsb3dlci4gT24gYm91bmNlIGFib3ZlIGBlbnRyeV9mbG9vciooMS1idXliYWNrX2Zsb29yX3BjdC8xMDApYDogY3Jhc2gtc2FmZS1jbGVhci1maXJzdCBidXkgYW5kIGByZWFybVB1bXBMb29wQWZ0ZXJCdXliYWNrYC4gQmVsb3cgZmxvb3I6IFRlbGVncmFtIGFsZXJ0IGFuZCBjbGVhciwgQnJ5YW4gZGVjaWRlcyBtYW51YWxseS4=
```

REPLACE_BASE64:
```text
LSAqKiMxMzAg4oCUIFRyb3VnaC1yZWJ1eSB0cmFja2VyICgjMzE0IHVwZGF0ZWQpLioqIEFmdGVyIHB1bXAtbG9vcCBhdXRvLXNlbGwsIGBhcm1SZWJvdW5kVHJhY2tlcmAgc3RvcmVzIHNhbGUgcHJpY2UgYW5kIHJpbmdmZW5jZWQgYHNhbGVfcHJvY2VlZHNfdXNkYCBpbiBgcHVtcF9hcm1lZF9ydWxlc2AuIEZhc3Qtc2NhbiBQYXJ0IEMgdHJhY2tzIHJldHJhY2UsIHJhdGNoZXRzIHRyb3VnaCBsb3dlci4gT24gYm91bmNlLCB0aGUgYnV5YmFjayBmbG9vciBpcyBhbmNob3JlZCB0byB0aGUgY3ljbGUncyBTQUxFIFBSSUNFIChgc2FsZV9wcmljZSooMS1idXliYWNrX2Zsb29yX3BjdC8xMDApYCksIGZhbGxpbmcgYmFjayB0byBgZW50cnlfZmxvb3JgIG9ubHkgaWYgYHNhbGVfcHJpY2VgIGlzIG51bGwgKHByZXZpb3VzbHkgYW5jaG9yZWQgdG8gYGVudHJ5X2Zsb29yYCwgd2hpY2ggcmVmdXNlZCByZWJ1eXMgPjUlIGJlbG93IGFuIGVudHJ5IHByaWNlIHRoYXQgY291bGQgYmUgbW9udGhzIHN0YWxlKS4gT24gYSBmbG9vciBicmVhY2gsIHRoZSB0cmFja2VyIGlzIFBBVVNFRCBhbmQgYW4gaG91cmx5IHJhdGUtbGltaXRlZCBUZWxlZ3JhbSBhbGVydCBzZW50LCByYXRoZXIgdGhhbiBjYWxsaW5nIGBjbGVhclRyb3VnaFRyYWNrZXJgICh3aGljaCBkZXN0cm95ZWQgdGhlIGN5Y2xlKS4gYGJ1eWJhY2tfZmxvb3JfcGN0YCBpcyBzZXR0YWJsZSB2aWEgYHNldF9wdW1wX2FybWVkX3J1bGVgLiBEZXNpZ24gcHJpbmNpcGxlOiB0aGUgZmxvb3IgZ3VhcmQgaXRzZWxmIHdhcyBOT1QgbG9vc2VuZWQgYmVjYXVzZSBhIGRlZXAgZHJvcCBtYXkgc2lnbmFsIGEgZGVsaXN0aW5nIG9yIGV4cGxvaXQgcmF0aGVyIHRoYW4gYSByZXRyYWNlIChqdWRnZW1lbnQgcmVtYWlucyBCcnlhbidzKSDigJQgdGhlIGZpeCBwYXVzZXMgYW5kIGFza3MgaW5zdGVhZCBvZiBzaWxlbnRseSBkaXNjYXJkaW5nLg==
```

### Block 4 of 5

SEARCH_BASE64:
```text
LSAqKiMzMTIg4oCUIFN0cmF0ZWd5IGVuZ2luZSBhbmQgYmFja3Rlc3QgaGFybmVzcy4qKiBgcnVuTGFkZGVyQmFja3Rlc3RgIGFuZCB0aGUgYHJ1bl9iYWNrdGVzdGAgTUNQIHRvb2wgcmVwbGF5IHRoZSBleGFjdCBzYW1lIGV2YWx1YXRvciB1c2VkIGJ5IHRoZSBsaXZlIHNoYWRvdyBlbmdpbmUgKGBzaGFkb3dFdmFsVGllcmApIG92ZXIgaGlzdG9yaWNhbCBwcmljZSBiYXJzIGFuZCBzY29yZSB0aGUgcmVzdWx0cyBhZ2FpbnN0IGJ1eS1hbmQtaG9sZCBiZW5jaG1hcmtzIHZpYSBgYnRDb21wdXRlTWV0cmljc2AuIFRoZSBlbmdpbmUgb3BlcmF0ZXMgc3RyaWN0bHkgcmVhZC1vbmx5OiBpdCBwbGFjZXMgbm8gdmVudWUgb3JkZXJzIGFuZCBtdXRhdGVzIG5vIGxpdmUgc3RhdGUuIEl0IHN1cHBvcnRzIHR3byBzdG9yYWdlIGJhY2tlbmRzOiAyLW1pbnV0ZSBgcHJpY2VfaW50cmFkYXlgIGNhcHR1cmVzIChoaWdoIGZpZGVsaXR5IGZvciBmaW5lIHRyaWdnZXIgZGV0ZWN0aW9uLCBwcnVuZWQgYXQgMzAgZGF5cykgYW5kIHRoZSBgcHJpY2VfaW50cmFkYXlfaG91cmx5YCBPSExDIHJvbGx1cCAocmV0YWluZWQgaW5kZWZpbml0ZWx5IHRvIGVsaW1pbmF0ZSB0aGUgMzAtZGF5IGJhY2t0ZXN0IHdpbmRvdyBjZWlsaW5nKS4gVGhlIHN1YnN5c3RlbSBhbHNvIGVzdGFibGlzaGVzIGEgZm9ybWFsIHN0cmF0ZWd5IGNhdGFsb2d1ZSBpbiBNeVNRTCAoYHN0cmF0ZWd5X3NjZW5hcmlvc2AgYW5kIGBzdHJhdGVneV90b29sc2AgdGFibGVzLCBzZWVkZWQgdmlhIGBzZWVkU3RyYXRlZ3lDYXRhbG9ndWVgIGFuZCBtYW5hZ2VkIHZpYSBgbWFuYWdlX3RyYWRpbmcgYWN0aW9uPSd1cHNlcnRfY2F0YWxvZ3VlJ2ApIG1hcHBpbmcgbWFya2V0IHJlZ2ltZXMgdG8gbWVjaGFuaXNtIGFwcGxpY2FiaWxpdHku
```

REPLACE_BASE64:
```text
LSAqKiMzMTIg4oCUIFN0cmF0ZWd5IGVuZ2luZSBhbmQgYmFja3Rlc3QgaGFybmVzcy4qKiBgcnVuTGFkZGVyQmFja3Rlc3RgIGFuZCB0aGUgYHJ1bl9iYWNrdGVzdGAgTUNQIHRvb2wgcmVwbGF5IHRoZSBleGFjdCBzYW1lIGV2YWx1YXRvciB1c2VkIGJ5IHRoZSBsaXZlIHNoYWRvdyBlbmdpbmUgKGBzaGFkb3dFdmFsVGllcmApIG92ZXIgaGlzdG9yaWNhbCBwcmljZSBiYXJzIGFuZCBzY29yZSB0aGUgcmVzdWx0cyBhZ2FpbnN0IGJ1eS1hbmQtaG9sZCBiZW5jaG1hcmtzIHZpYSBgYnRDb21wdXRlTWV0cmljc2AuIFRoZSBlbmdpbmUgb3BlcmF0ZXMgc3RyaWN0bHkgcmVhZC1vbmx5OiBpdCBwbGFjZXMgbm8gdmVudWUgb3JkZXJzIGFuZCBtdXRhdGVzIG5vIGxpdmUgc3RhdGUuIEl0IHN1cHBvcnRzIHR3byBzdG9yYWdlIGJhY2tlbmRzOiAyLW1pbnV0ZSBgcHJpY2VfaW50cmFkYXlgIGNhcHR1cmVzIChoaWdoIGZpZGVsaXR5IGZvciBmaW5lIHRyaWdnZXIgZGV0ZWN0aW9uLCBwcnVuZWQgYXQgMzAgZGF5cykgYW5kIHRoZSBgcHJpY2VfaW50cmFkYXlfaG91cmx5YCBPSExDIHJvbGx1cCAocmV0YWluZWQgaW5kZWZpbml0ZWx5IHRvIGVsaW1pbmF0ZSB0aGUgMzAtZGF5IGJhY2t0ZXN0IHdpbmRvdyBjZWlsaW5nKS4gKipEYXRhIHNvdXJjZSBmaXggKCMzMTkpOioqIGBzb3VyY2U9aG91cmx5YCBxdWVyaWVzIGBwcmljZV9pbnRyYWRheV9ob3VybHlgIHVzaW5nIGNvbHVtbnMgYG9wZW5fcHhgLCBgaGlnaF9weGAsIGBsb3dfcHhgLCBhbmQgYGNsb3NlX3B4YCAocHJldmlvdXNseSBxdWVyaWVkIGBvcGVuX3ByaWNlYCBldGMuLCB3aGljaCBkbyBub3QgZXhpc3QsIGNhdXNpbmcgZXZlcnkgaG91cmx5IGJhY2t0ZXN0IHRvIGZhaWwgYW5kIHNpbGVudGx5IGNvbmZpbmluZyBhbmFseXNpcyB0byB0aGUgfjQtd2VlayBpbnRyYWRheSB3aW5kb3cpLiAqKktub3duIGxpdmUvYmFja3Rlc3QgZGl2ZXJnZW5jZSAoIzMwOSk6KiogdGhlIExJVkUgcGF0aCByZS1hbmNob3JzIHRoZSB0cmFpbGluZyBzdG9wIG9uIGEgZmxvb3ItYmxvY2tlZCBzYWxlIGFuZCBrZWVwcyB0aGUgcnVsZSBhcm1lZCwgd2hlcmVhcyB0aGUgQkFDS1RFU1QgZXZhbHVhdG9yIGNvbnN1bWVzIHRoZSB0aWVyIG9uIGBiZWxvd19lbnRyeV9mbG9vcmA7IGFzIGEgcmVzdWx0LCBiYWNrdGVzdHMgY3VycmVudGx5IHVuZGVyc3RhdGUgcGVyZm9ybWFuY2UgZm9yIGZsb29yLWxpbWl0ZWQgcG9zaXRpb25zIHVudGlsIGFsaWduZWQuIFRoZSBzdWJzeXN0ZW0gYWxzbyBlc3RhYmxpc2hlcyBhIGZvcm1hbCBzdHJhdGVneSBjYXRhbG9ndWUgaW4gTXlTUUwgKGBzdHJhdGVneV9zY2VuYXJpb3NgIGFuZCBgc3RyYXRlZ3lfdG9vbHNgIHRhYmxlcywgc2VlZGVkIHZpYSBgc2VlZFN0cmF0ZWd5Q2F0YWxvZ3VlYCBhbmQgbWFuYWdlZCB2aWEgYG1hbmFnZV90cmFkaW5nIGFjdGlvbj0ndXBzZXJ0X2NhdGFsb2d1ZSdgKSBtYXBwaW5nIG1hcmtldCByZWdpbWVzIHRvIG1lY2hhbmlzbSBhcHBsaWNhYmlsaXR5Lg==
```

### Block 5 of 5

SEARCH_BASE64:
```text
LSAqKk15U1FMIG9uIFJhaWx3YXksIHNpbmdsZSBgc2VydmVyLmpzYC4qKiBPbmUgZGVwbG95IHRhcmdldCwgb25lIHByb2Nlc3MsIG9uZSBEQjsgc2ltcGxlIHRvIHJlYXNvbiBhYm91dCBhbmQgY2hlYXAgdG8gcnVuIGZvciBhIHNpbmdsZSB1c2VyLiBOb3Qgc3BsaXQgaW50byBzZXJ2aWNlcyBiZWNhdXNlIHRoZSBvcGVyYXRpb25hbCBzdXJmYWNlIChvbmUgb3duZXIsIG9uZSBwb3J0Zm9saW8pIGRvZXNuJ3QganVzdGlmeSB0aGUgY29tcGxleGl0eS4=
```

REPLACE_BASE64:
```text
LSAqKk15U1FMIG9uIFJhaWx3YXksIHNpbmdsZSBgc2VydmVyLmpzYC4qKiBPbmUgZGVwbG95IHRhcmdldCwgb25lIHByb2Nlc3MsIG9uZSBEQjsgc2ltcGxlIHRvIHJlYXNvbiBhYm91dCBhbmQgY2hlYXAgdG8gcnVuIGZvciBhIHNpbmdsZSB1c2VyLiBOb3Qgc3BsaXQgaW50byBzZXJ2aWNlcyBiZWNhdXNlIHRoZSBvcGVyYXRpb25hbCBzdXJmYWNlIChvbmUgb3duZXIsIG9uZSBwb3J0Zm9saW8pIGRvZXNuJ3QganVzdGlmeSB0aGUgY29tcGxleGl0eS4KLSAqKkNvbm5lY3Rpb24gcG9vbCBvdmVyIHNpbmdsZSBjb25uZWN0aW9uICgjMzI3KS4qKiBTd2l0Y2hlZCBmcm9tIGEgc2luZ2xlIGBteXNxbC5jcmVhdGVDb25uZWN0aW9uYCB0byBgbXlzcWwuY3JlYXRlUG9vbGAgKGBjb25uZWN0aW9uTGltaXQ6IDEwYCwgYHdhaXRGb3JDb25uZWN0aW9uczogdHJ1ZWAsIGBlbmFibGVLZWVwQWxpdmU6IHRydWVgLCBga2VlcEFsaXZlSW5pdGlhbERlbGF5OiAxMDAwMGApLiBPcGVyYXRpb25hbCBsZXNzb246IGEgc2luZ2xlIGBteXNxbC5jcmVhdGVDb25uZWN0aW9uYCBoYXMgbm8gYXV0b21hdGljIHJlY29ubmVjdCwgc28gd2hlbiB0aGUgUmFpbHdheSBNeVNRTCBjb25uZWN0aW9uIGRyb3BwZWQgb24gMTkgU2VwdCAyMDI2LCBldmVyeSBEQi1kZXBlbmRlbnQgc3Vic3lzdGVtIChwcmljZSBjYXB0dXJlLCBvcmRlciBwb2xsaW5nLCBwb3J0Zm9saW8gY2hlY2tzLCBzaGFkb3cgZXZhbHVhdGlvbiwgYmFzZWxpbmVzKSBmYWlsZWQgY29udGludW91c2x5IGZvciA+MiBob3VycyB3aGlsZSBFeHByZXNzIHN0YXllZCB1cCBhbmQgcmVwb3J0ZWQgdGhlIGRlcGxveW1lbnQgaGVhbHRoeSwgcHJldmVudGluZyBwbGF0Zm9ybSByZXN0YXJ0LiBOb3RlOiBhbiBleHBsaWNpdCBEQiBoZWFsdGggY2hlY2sgZW5kcG9pbnQgd2l0aCBhbGVydGluZyByZW1haW5zIG91dHN0YW5kaW5nLg==
```

