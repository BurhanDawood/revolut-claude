# ARCHITECTURE.md — Revolut X AI Portfolio Manager

> **Purpose of this document.** This is the single durable reference for how the system is built, how data flows through it, what each subsystem does, and *why* the major design decisions were made. It exists because the build history was previously fragmented across 100+ dev_log tickets, git commits, Claude's cross-session memory, and conversation logs — making "how does X work / why is it this way" a reconstruction job. Maintain this file: when a major subsystem ships or a load-bearing decision changes, update the relevant section. The live ticket board remains the `dev_log` (see §7); this document is the map, not the changelog.
>
> **Owner:** Bryan. **Last updated:** 2026-06-18. (#91 rolling 24h baseline; #71 holdings undercount fully resolved; #111/#112/#113 alert quality cluster; #114/#115/#116 Telegram/logging fixes.)

---

## 1. System Overview

A personal, single-user automated crypto portfolio manager. It monitors holdings across Revolut X and Kraken, tracks tax lots, fires price/structure/macro alerts to Telegram, executes trades through a Telegram-gated approval flow, and surfaces AI analysis and live web research. The owner is the sole decision-maker; the system is an assistant and a safety net, not an autonomous trader.

**Stack**
- **Runtime:** Node.js (v22) / Express, single `server.js` (~13,460 lines).
- **Database:** MySQL on Railway.
- **Hosting:** Railway (service `revolut-claude-production.up.railway.app`), 1 replica, US-West, deploys from GitHub on push.
- **Interfaces:** Telegram bot (alerts + trade approval), a web dashboard (`public/dashboard.js`), and an MCP server (`/mcp`) exposing tools to Claude.
- **External APIs:** Revolut X (primary exchange), Kraken (secondary), Tangem (XRP cold-storage balance), Anthropic (AI analysis + web research), Telegram Bot API, Google Drive (backups + code/read-back sync).
- **Repo:** `github.com/BurhanDawood/revolut-claude` (public). **Local:** `C:\Users\owner\revolut-claude\server.js`.

**Secrets (Railway env vars):** `REVOLUTX_API_KEY` / `REVOLUTX_PRIVATE_KEY`, `KRAKEN_API_KEY` / `KRAKEN_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, Telegram bot token, `API_TOKEN` (dashboard/API auth), `BRIDGE_TOKEN`, and the Google OAuth set for backups (`GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` + `GDRIVE_BACKUP_FOLDER_ID`). Secrets are never pasted into chat or Cowork prompts — credential bugs are diagnosed via length/char-code checks, never by echoing values.

### 1.1 The three working threads

Development and operation are split across three Claude contexts, by design:

- **PM thread** — portfolio manager. Handles analysis, alerts, trade logging, strategy reviews, morning briefings. Reads/writes the database via MCP tools. Never edits code.
- **Dev thread** — lead developer / diagnostician. Diagnoses read-only against the live code (pulled from GitHub raw / Drive sync), writes Cowork prompts, verifies read-backs, manages the `dev_log`. Never edits live code directly.
- **Cowork** — a separate PC agent that performs the actual file edits and runs `PUSH_NOW.bat` to commit/deploy. Receives single-box prompts from the Dev thread, writes its read-back to a Google Drive folder the Dev thread reads directly.

This separation is deliberate: the Dev thread reasons and verifies but cannot push; Cowork executes but does not design. Every change passes through a written prompt + a verified read-back before deploy. The same `cross_thread` principles (auto-exec-off, never-sell-below-entry, etc.) are surfaced in both PM and Dev session briefings (see §3, decision-memory layer).

---

## 2. Data-Flow Map

### 2.1 The main monitoring loop
`checkPortfolio()` runs every 5 minutes. It pulls live tickers from Revolut X (one `/tickers` call → a price map of ~788 entries), pre-loads Kraken-only coins (GHIBLI, XPL, TAO) via Kraken, loads 24h baseline prices from `price_history`, then iterates every held/watched coin: computes % move vs 24h, skips dust (<$1 position value), and evaluates alert conditions (fixed targets, daily-move thresholds, trailing stops, auto-rules). The same loop hosts the card-payment auto-log detector (§2.7).

### 2.2 Intraday capture (#50 Build 1)
`captureIntradayPrices()` runs every 2 minutes (decoupled from the 5-min loop). Captures all non-meta `coin_strategy` coins (held + watch) into `price_intraday`. This is the data clock for the future ATR/abnormal-move detector (#50 Build 2) — baseline needs ~2–4 weeks of accrual to be meaningful.

### 2.3 Fast-cadence scan (#94 / #95 Stage 1)
`runFastScan()` runs on a tight cadence (30–60s) over a small set of flagged symbols. It checks pump-arm rules first (`checkPumpArm` — dormant detectors that arm a trailing stop on a qualifying pump, see §3 pump-loop) and then services any armed trailing stops. Decoupled from the 5-min loop so fast meme/volatile moves aren't missed between cycles. (#99 is the queued upgrade: make the fast-scan set dynamic — every armed trailing stop — once `getCurrentPrice` rate-limits are diagnosed.)

### 2.4 Cron schedule (Europe/London)
- `0 0 * * *` — `recordDailyPrices` (writes daily close to `price_history`; resets daily alert tracking).
- `0 2 * * *` — prune (intraday housekeeping).
- `15 2 * * *` — prune `price_intraday` rows >30 days.
- `0 3 * * *` — `backupServerJsToDrive` (#102: nightly dated server.js snapshot → Google Drive `revolut-claude-backups`, 14-folder retention).
- `0 3 * * *` — `runReconciliation` (#55: system positions vs exchange balances vs tranche sums; flags drift).
- `30 3 * * *` — `backupDatabaseToDrive` (#12: nightly DB dump → Google Drive).
- `*/5 * * * *` — `checkMacroNews` (RSS macro/news scan).
- `5 9 * * 1` — Monday rebalancing check.
- `10 9 * * 1` — Monday weekly snapshot.
- `15 9 * * 1` — `weeklyResearchSweep()` cron, Mondays 9:15 AM, researches 11 held/watch coins (CC, ENA, NEAR, JTO, TON, AERO, LINK, XLM, XRP, HYPE, RSC), diffs each, sends one Telegram drift summary. Cost ~$0.22/API call → weekly sweep ~$10/mo; in-chat is free. Daily full-book deliberately not built (~$130/mo). HARD RULE: recommend-only, proposes `coin_strategy` changes, never auto-applies — Bryan approves in PM. (Known open: the weekly sweep's `extractDriftVerdict()` parser returns "unknown" — #90, queued.)
- `0 10 * * *` — `checkIntentionOutcomes`.
- `5 10 * * *` — `checkRebalancingOutcomes`.
- `10 10 * * *` — `gradeTradeOutcomes` (#48: forward +7d/+30d grading).
- Morning briefing (`5 9 * * *`) is currently **disabled** (commented), kept for manual use.

### 2.5 Alert pipeline
Conditions evaluated in the 5-min loop → if fired and not in cooldown / not acknowledged → Telegram notify. Acknowledged-alert state persists to `macro_alerts_sent` (so redeploys don't re-fire — #70). Fixed-target cooldowns are 24h. Alerts are **notify-only** for held positions; nothing auto-executes while auto-exec is disabled (current default).

### 2.6 Trade execution + approval path
A trade (from MCP `execute_kraken_trade` or the Revolut path) creates a *pending* trade → Telegram "approval needed" → owner replies 👍 / approve → execution → journal write + tranche update. **All `/api/*` write routes require `x-api-token`** (#43, fail-closed); the critical trade endpoints reject unauthenticated calls with 401 before reaching the handler. Known limitation: the approval handler tracks only the most-recent pending trade, so laddered multi-rung approvals clobber each other (#44, open).

**Auto-exec path (the #95 pump-loop — built, gated OFF).** A separate autonomous path exists but is doubly inert by default (see §3 pump-loop and §4). When (and only when) the global `ai_auto_execute` master is enabled AND a per-coin flag is set, an armed trailing-stop breach can route to `autoExecuteSell` / `autoExecuteKrakenSell`. Both carry a hard entry-floor guard (never auto-sell below the configured floor; fail-safe blocks the sell if the floor can't be read) and feed the cascade buyback engine. The master switch has been **OFF since 2026-06-09** and enabling it is always a separate, deliberate decision — never bundled with a code change.

### 2.7 Card-payment auto-log (#107)
Inside the 5-min balance loop, when USDT decreases with no offsetting balance increase (not a USD conversion, not a crypto buy, not recent trade-funding), the decrease is treated as a card payment: auto-logged to `trading_journal` (`source='revolut_card'`), invested capital decremented, and a one-way Telegram notice sent. A 15-minute dupe-guard prevents double-logging. Reversible anytime via `skip payment [amount]` (re-credits capital + deletes the row). This satisfies the #82 rule — capital is never *silently* mutated: every auto-log notifies and is reversible. Proven live 2026-06-17 (a real card payment auto-logged outside a redeploy window).

### 2.8 Reconciliation (#55)
Nightly at 3 AM: compares Revolut `/balances` (available) + Kraken balances against non-legacy tranche sums per `symbol,exchange`. Tolerance 0.5%; skips untracked/dust; tags `system > available` as possible open-order (a resting limit reserves coin). Telegram only on *new* drift. This institutionalised the manual ground-truth check that originally caught the #47 phantom-tranche bug.

---

## 3. Subsystem Map

- **MCP tools (15 active):** `get_portfolio_summary`, `get_portfolio_data`, `get_trading_data`, `get_context`, `manage_alerts`, `manage_trading`, `set_entry_price`, `execute_kraken_trade`, `set_auto_trade_rule`, `get_auto_rules`, `manage_auto_rules`, `get_prices`, `get_tranches`, `research_asset`, `set_pump_armed_rule`. The tool list/count is seeded into `system_capabilities` config at boot. (Note: `project_description` config still reads "11 tools" — a cosmetic staleness, not a functional one.)
- **Auto-rules engine:** per-coin rules (moon-bag 25% sells at a $999 sentinel, buy-dip, etc.). 21 clean moon-bag rules currently armed. Master `ai_auto_execute` config is **disabled**; even when enabled it is railed (caps, floors, manual-only symbols) and is the rare exception, not the norm.
- **#95 pump-loop (built end-to-end, OFF by default).** A four-stage autonomous swing loop for designated coins (e.g. GHIBLI), each stage guarded:
  - **Stage 1 — pump-arm detector** (`checkPumpArm`, `pump_armed_rules` table, `set_pump_armed_rule` tool). A dormant rule arms a trailing stop when the coin pumps `arm_pump_pct` within `arm_window_min`. Arm-only; no sell.
  - **Stage 2 — entry-floor guard.** When an armed trail breaches and routes to `autoExecuteSell`/`autoExecuteKrakenSell`, a hard guard reads `entry_floor` fresh from `pump_armed_rules` and blocks the sell if `currentPrice <= floor`. Fails safe (blocks) if the lookup errors. Implements *never-sell-below-entry*.
  - **Stage 3 — single buyback rung.** After a pump-armed sell, a synthetic rule (`max_cascades:0`) feeds `cascadeRulesAfterTrade`, which creates exactly ONE buy-retrace rung (no averaging-down). The cascade engine's own guard also refuses to buy back below 95% of entry.
  - **Rinse-Repeat — continuous re-arm.** `rearmPumpLoopAfterBuyback` fires after a cascade buy fills: if enabled, it re-arms the pump rule (`armed=0`, baseline cleared) so the next qualifying pump repeats the cycle. Four guards on `pump_armed_rules`: `loop_enabled` (per-coin, default 0), the global master, a loss circuit-breaker (`loop_realized_pnl < 0` → halt), and a max-cycles cap (`cycle_count >= max_cycles`, default 10 → pause-and-ask). `loop_realized_pnl` is an approximate proxy for the circuit-breaker, not tax-grade accounting.
  - **Double-gated safety:** nothing in this loop fires unless BOTH the global `ai_auto_execute` master is ON *and* the per-coin `loop_enabled` is 1. Both default off, so the whole subsystem ships inert. As of this writing the single cycle has never run live, and there is no MCP setter for `loop_enabled`/`max_cycles` yet (toggle via SQL or a future small tool).
- **Cascade buyback engine (`cascadeRulesAfterTrade`).** After a sell, ringfences proceeds and creates a buy-retrace rule (8% retrace); after a buy, can cascade deeper — bounded by `max_cascades` and an entry-price guard (won't buy below 95% of entry). Wired into both the auto-rule executor and (via the synthetic rule) the pump-loop sell path.
- **Tranche / tax-lot tracking:** per-lot accounting supporting **US HIFO** and **UK S104**. Tranches decrement on sells; the known open work is the limit-order lifecycle + orphaned-tranche disposal (#47 Part 2).
- **Intention system:** `log_intention` records an intended trade *before* execution; outcomes are graded later (#48). Intentions match to auto-detected fills.
- **`coin_strategy` registry:** one row per coin (`status, role, theme, strategy_md, updated_at, updated_by`) — the persisted per-coin plan (thesis, alert rungs, role). Read before analysing any coin; updated in the same breath as changing an alert. Surfaced on dashboard cards.
- **Decision-memory layer (#105 — reasoning layer, both threads).** Two sibling tables capturing the *why* behind choices, distinct from the event logs (`dev_log` / `trading_journal`):
  - **`pm_decisions`** — portfolio principles (e.g. trim-into-strength, the GHIBLI pump-loop exception to don't-round-trip-memes). Surfaced in the PM `get_context` briefing with a since-last-seen digest.
  - **`dev_decisions`** — architectural principles (auto-exec-off, phased-builds, never-sell-below-entry, live-DB-is-truth, etc.), with `cross_thread`, `alternatives_rejected`, `related_dev_log`, and a `revisited` status. Surfaced in the Dev `get_trading_data include=['dev_log']` briefing with a digest. `cross_thread=1` principles also surface in the PM briefing (`crossThreadPrinciples`) so shared constraints appear in both.
  - **Recommendation engine (`pmRecommendations`)** — reasons over positions + research + principles to surface trim/rotate candidates at PM session start.
  - Logged via `log_pm_decision` / `log_dev_decision` actions on `manage_trading`. `supersedes_id` makes principle evolution traceable rather than silently overwritten.
- **USDT sweep:** optional auto-conversion of trade proceeds (currently disabled).
- **Dashboard (`public/dashboard.js`):** read views + a few control POSTs (pause/resume/sweep config). Tappable asset cards (#57). Surgical edits allowed (#66) with a `.bak` backup; `node --check` always before push.
- **Backups (3 layers):** (1) **#12** nightly DB dump → gzip → Google Drive via OAuth-delegated upload (uploads as the owner's Drive — service accounts have no Drive quota), 14-file retention, Telegram confirmation; (2) **Drive desktop sync** auto-syncs the working tree to Drive after every Cowork save; (3) **#102** nightly dated server.js snapshot → `revolut-claude-backups`, 14-folder retention.
- **Research layer (#72 — Build 1 + Build 2 shipped):** `researchAsset(symbol, triggeredBy)` + `research_asset` MCP tool — plan-aware deep web research (Anthropic web-search), evaluated against the saved `coin_strategy` plan, recommend-only. **Build 2 adds persistence + diff:** every pass is stored to the `research_history` table (thesis_status, drift_verdict, live_price, report); each new pass diffs against the prior snapshot (thesis change, new drift, >10% price move). Three entry points share one timeline: (1) **in-chat** — Claude researches with its own web_search (free, no API cost) and writes the snapshot via the `log_research` action on `manage_trading`; (2) **on-demand API** — `research_asset` tool; (3) **automated** — `weeklyResearchSweep()` cron, Mondays 9:15 AM, researches 11 held/watch coins (CC, ENA, NEAR, JTO, TON, AERO, LINK, XLM, XRP, HYPE, RSC), diffs each, sends one Telegram drift summary. Cost ~$0.22/API call → weekly sweep ~$10/mo; in-chat is free. Daily full-book deliberately not built (~$130/mo). HARD RULE: recommend-only, proposes `coin_strategy` changes, never auto-applies — Bryan approves in PM. (Known open: the weekly sweep's `extractDriftVerdict()` parser returns "unknown" — #90, queued.)

---

## 4. Key Design Decisions (and why)

- **MySQL on Railway, single `server.js`.** One deploy target, one process, one DB; simple to reason about and cheap to run for a single user. Not split into services because the operational surface (one owner, one portfolio) doesn't justify the complexity.
- **Auto-exec stays OFF by default.** The owner's edge is discretion; the documented weakness is rushed/FOMO decisions. The system defaults to *analyse-then-notify*, never *act*. Auto-exec, wherever enabled, is railed (caps, floors, manual-only symbols) and is the rare exception, not the norm. Enabling it is always a separate, deliberate decision in a fresh session — never bundled with the code change that built the path. The #95 pump-loop is the worked example: all four stages were built and deployed with the master OFF, so the irreversible action (the flip) stays decoupled from the build.
- **Double-gated autonomy.** Any autonomous loop requires two independent switches both ON (the global `ai_auto_execute` master AND a per-coin flag), so a single misconfiguration can't arm it. The pump-loop's `loop_enabled` is the per-coin gate.
- **Never sell below entry.** Every auto-sell path carries a hard entry-floor guard before it can fire; it fails safe (blocks) on uncertainty. A per-coin sell-floor (#45) remains the prerequisite before re-enabling any below-entry-capable trigger generally.
- **No leverage, no stop-losses.** The owner trades spot only and uses trailing stops to protect gains, never stop-losses. Generic "tighten your stops / leverage" boilerplate is wrong for this profile and must be stripped from any alert (#76).
- **Telegram-gated execution.** Every manual trade requires explicit approval. The MCP trade tool cannot fire autonomously; the API trade routes are token-protected and fail-closed.
- **Phased builds (Path C).** Large features ship as Build 1 (foundation/data clock) then Build 2+ (the intelligence on top), proving each layer live before extending. Examples: #50 (intraday capture → ATR detector), #72 (research primitive → persistence/diff), #95 (pump-arm → floor guard → rebuy → re-arm loop), #105 (decision tables → recommendation engine). Keeps each deploy small and verifiable and surfaces real cost/quality data before committing to the expensive half.
- **Decision-memory over re-derivation.** Standing principles are stored (`pm_decisions` / `dev_decisions`) and surfaced at session start so contradictions are caught *before* a build or a trade, rather than re-reasoned each session. Principle changes are superseded (traceable), never silently overwritten. The GHIBLI pump-loop exception to don't-round-trip-memes is the worked example — logged as a deliberate, bounded supersede.
- **`COIN-USD` dash format** for order symbols (Revolut convention); the price map stores both `COIN/USD` and `COIN-USD` keys.
- **Single-write tranche discipline.** Tranche side-effects should happen once, at confirmed fill — not at order placement. Double-writes at placement+fill are the root of the #47 phantom/duplicate class.
- **Live DB is the source of truth.** Narrative — memory, checkpoints, prior summaries — is always to be *verified* against live data, never trusted over it. When they conflict, live wins and the correction is stated explicitly. Re-pull live state immediately before any capital/state-mutating write (a stale read once caused a double-decrement).

---

## 5. Conventions (development workflow)

- **Canonical build loop (`build_workflow_canonical`).** The standing 11-step process: startup ritual → state model → pull live code (GitHub raw = code-truth) → diagnose read-only → one single-box Cowork prompt → Cowork executes + writes read-back to Drive → Claude verifies the read-back against actual file content → Bryan pushes (`PUSH_NOW.bat`) → Claude verifies boot via Railway MCP → live functional test → log + checkpoint.
- **Read-back-to-Drive workflow.** Cowork writes its read-back to a text file in the `revolut-claude-readbacks` Drive folder; the Dev thread reads it directly (no copy-paste). Bryan only says "done". Read-backs are verified against actual file content — narrative claims ("all edits landed") are never trusted.
- **Single-box Cowork prompts (#64).** Every Cowork prompt is one fenced code block (no nested fences) for one-tap copy. Edits use **search strings, not line numbers** (lines shift every push): find exact block → replace exact block. The prompt's closing checklist enumerates exactly what the read-back must contain (each edit site, `node --check` result, any greps).
- **Boot-verify via Railway MCP.** After every push: `list-deployments` → confirm new commit SUCCESS → `get-logs` types=['deploy'] → confirm Starting Container + Server running + Cron scheduled + auto-exec DISABLED + no errors + any feature-specific log line. No screenshots needed. IDs live in the `railway_ids` preference.
- **Connector-refresh rule.** A new MCP *tool*, or new *typed params* on an existing tool (e.g. a boolean/number), require Settings → Connectors → Revolut X → 'Refresh tool list' before Claude can call the new surface — deploying + clean boot is not enough (the connector caches the schema). A new *action* reusing existing params needs no refresh. (`dev_tools_protocol_addendum`.)
- **Surgical-edit policy (#66).** Targeted edits to `dashboard.js` are acceptable and often preferred over whole-file retransmission; `.bak` backup first; `node --check public/dashboard.js` must pass before every push. Dev decides atomic-vs-surgical per situation.
- **Strategy reconciliation before activation.** Before activating any new rule/strategy on a coin, reconcile against everything already in place for that coin and remove conflicts; state before→after. (A new pump-armed trailing stop once coexisted with a stale manual trailing stop and fired noise alerts — caught by chance.)
- **`node --check` before every push.** Non-negotiable. No deploy without a clean syntax check in the read-back.
- **One change at a time; never bundle across a trade-execution boundary.** Trade-path and capital-sensitive changes ship alone and are verified read-back line by line.
- **Model-usage policy (#67).** Sonnet for light work (reads, verification, small prompts, log writes); Opus for heavy work (feature design, multi-file reasoning, root-cause diagnosis); Fable reserved for the rare heaviest cases. Claude states the recommended model at session start and flags switches; the owner toggles (Claude cannot switch its own model).
- **Session continuity.** Both PM and Dev projects carry custom instructions enforcing a startup ritual (`get_context` → `get_auto_rules` → `get_trading_data include=['dev_log']`) and read a session checkpoint preference (`session_checkpoint_dev` / `_pm`) as "where we left off" — verified against live data. A checkpoint is written at session close. Build specs can be designed in one session (stored as a preference) and executed cleanly in another.
- **Credential-bug diagnostics.** For auth failures, log only value *lengths* and last-character codes — never the secret. Mobile paste commonly introduces leading/trailing whitespace (root cause of the #12 OAuth `invalid_client` saga: a leading space on the client ID).

---

## 6. Build Timeline (selected milestones)

Reconstructed from git history and the dev_log. Not exhaustive — the `dev_log` is the full record.

- **Foundations:** Kraken monitoring + execution; Tangem XRP balance integration; trade intention system; MCP tool consolidation; Revolut X execution; tax-lot tracking (US HIFO + UK S104).
- **#43** — API auth middleware on all `/api/*` write routes (fail-closed, token-gated). *Resolved.*
- **#55** — nightly ground-truth reconciliation (positions vs exchange vs tranches). *Deployed.*
- **#48** — forward outcome grader (+7d/+30d) + journal outcome columns. *v1 shipped.*
- **#57** — coin-strategy registry + tranche GET endpoints + tappable dashboard asset cards. *Shipped.*
- **#50 Build 1** — intraday price capture (2-min cadence, 30-day prune). *Deployed/verified.*
- **#70 / #60 / #65** — alert re-fire-after-redeploy fix; baseline24h window fix; journal symbol-format fix. *Resolved.*
- **#12** — nightly DB backup to Google Drive (OAuth-delegated, gzip, 14-file retention). *Deployed/verified.*
- **#72 Build 1 + 2** — `researchAsset()` primitive + `research_asset` tool; then research persistence (`research_history`, snapshot+diff, `log_research`, `weeklyResearchSweep()`). *Deployed.*
- **#78 / #79** — front-door `README.md`; `export_dev_log` action + dated CHANGELOG snapshots. *Shipped.*
- **#82** — capital-mutation fix (USDT→USD conversions no longer corrupt invested capital). *Resolved.*
- **#71** — portfolio holdings undercount fully resolved (2026-06-18). Revolut X API returns `available` balance only; resting-limit coins were excluded. Fixed across 7 contexts (`available + reserved` = total holdings). CC gap +3,000 coins / +$467 portfolio value now correctly counted. *Resolved 2026-06-18.*
- **#91** — rolling 24h baseline fix (2026-06-18). The midnight baseline snapshot absorbed pumps already in progress (NEAR +21.67% showed as -2% to system). INNER JOIN self-join now finds `price_history` row closest to exactly 24h ago (±2h window). Continuation pumps correctly measured. *Resolved 2026-06-18.*
- **#111** — coin_strategy table ↔ preference bidirectional auto-sync (2026-06-18). Alert AI-analysis reads the `coin_strategy` TABLE; PM updates the `coin_strategy_XXX` PREFERENCE — two stores that silently drifted. Fix: `save_preference(coin_strategy_XXX)` now also upserts table `strategy_md`; `upsert_coin_strategy` mirrors back to preference. Closes the stale-plan-contradiction class. *Resolved 2026-06-18.*
- **#112** — alert direction verification (2026-06-18). Ships A+B: `fixed_price_targets` now flatMaps per-rung detail (direction/anchor/target/description); `set_target` surfaces direction auto-correction warnings. Fix #4: stale trim Telegram flag after auto-sell. Fix #3 (dashboard ▲/▼) queued. *Partially resolved 2026-06-18.*
- **#113/#114/#115/#116** — Telegram/alert quality cluster (2026-06-17–18). #113: Hold reply no longer calls `acknowledgeAlert`; ⚠️ warning labels on all mute-triggering menu options. #114: trailing stop alerts now show 4-option numbered menu (auto-ack removed). #115: `log_journal` guard — missing `trade_action` returns clear error instead of crashing. #116: stale reminder interval self-heal guard — removed rungs no longer fire zombie reminders. *All resolved.*
- **#102** — nightly dated server.js snapshot to Drive (3rd backup layer). *Shipped 2026-06-16.*
- **#107** — card-payment auto-log (USDT outflow → journal + capital decrement + reversible `skip payment`). *Shipped + proven live 2026-06-17.*
- **#105** — decision-memory layer: PM Build 1 (`pm_decisions` + `log_pm_decision` + briefing digest), PM Build 2 (`pmRecommendations` engine), Dev-side (`dev_decisions` + `log_dev_decision`), cross-thread surfacing in both briefings. *Shipped 2026-06-16.*
- **#95 — pump-loop (all four stages, OFF by default).** Stage 1 pump-arm detector → Stage 2 entry-floor guard → Stage 3 single buyback rung (`max_cascades:0`) → Rinse-Repeat continuous re-arm with 4 guards (loop_enabled, master, loss circuit-breaker, max-cycles cap). *Shipped 2026-06-16 → 2026-06-17.*
- **#109** — `.gitignore` scratch-file guards (`*.bak`, `readback-*.txt`, `.tmp.driveupload/`, `html-ids.txt`). *Shipped.*

---

## 7. Open-Issues Index

The **`dev_log`** (queried via `get_trading_data include=['dev_log']`) is the live ticket board and the authoritative source for open work. High-level priority tiers (see the `dev_priority_queue` preference for the maintained ordering):

- **Tier 1 — resilience/safety:** #43 done, #12 done, #55 done (monitoring), #71 done, #102 done.
- **Tier 1.5 — data cleanup:** #47 Part 2 (limit-order lifecycle + orphaned-tranche disposal); #8 cross-cycle P&L for cycle_count>0 coins (tax-relevant); AVAX tax-lot reconstruction.
- **Tier 2 — core quality / intelligence layer:** #72 Researcher done (keystone) → #36 plan-aware alerts → #50 Build 2 ATR detector → #49 MSS tracker → #40 catalyst calendar. Umbrella framing in #68; sources #61 (YouTube), #69 (social). #90 weekly-sweep `extractDriftVerdict()` parser fix.
- **Tier 2.5 — learning loop:** #48 outcome loop → #52 shadow tracker → #54 emotion×outcome → #51 checklist gate → #53 concentration dashboard.
- **Auto-exec / pump-loop:** #95 built end-to-end (OFF). Follow-ups: an MCP setter for `loop_enabled`/`max_cycles` (currently SQL-only); exact loop P&L accounting vs the approximate proxy; #45 per-coin sell-floor generalisation; #24/#46/#33/#34 per-coin config, availability-gating, modes. Enabling remains a separate cold decision; single cycle never run live.
- **Known bugs to watch:** #76 (macro alert not price-aware), #74 (context-blind ladder rec), #44 (multi-trade approval clobber), #75 (dashboard render verification), #99 (fast-scan dynamic upgrade). (#88, #91, #116 resolved 2026-06-18.)
- **Cosmetic:** `project_description` config still says "11 tools" (real count 15); cron log line omits the server-backup entry.
- **Documentation:** #73 (this file). The `dev_log` export to a dated CHANGELOG (#79) guards against detail-replacement on ticket updates.

---

*This document is maintained by hand. It is a map and a rationale, not a substitute for the `dev_log` (live tickets) or git history (exact diffs). When a major subsystem ships or a load-bearing decision changes, update the affected section and the "Last updated" date.*
