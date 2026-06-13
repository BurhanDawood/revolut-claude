# ARCHITECTURE.md — Revolut X AI Portfolio Manager

> **Purpose of this document.** This is the single durable reference for how the system is built, how data flows through it, what each subsystem does, and *why* the major design decisions were made. It exists because the build history was previously fragmented across 70+ dev_log tickets, git commits, Claude's cross-session memory, and conversation logs — making "how does X work / why is it this way" a reconstruction job. Maintain this file: when a major subsystem ships or a load-bearing decision changes, update the relevant section. The live ticket board remains the `dev_log` (see §7); this document is the map, not the changelog.
>
> **Owner:** Bryan. **Last updated:** 2026-06-13.

---

## 1. System Overview

A personal, single-user automated crypto portfolio manager. It monitors holdings across Revolut X and Kraken, tracks tax lots, fires price/structure/macro alerts to Telegram, executes trades through a Telegram-gated approval flow, and surfaces AI analysis and (newly) live web research. The owner is the sole decision-maker; the system is an assistant and a safety net, not an autonomous trader.

**Stack**
- **Runtime:** Node.js (v22) / Express, single `server.js` (~12,500 lines).
- **Database:** MySQL on Railway.
- **Hosting:** Railway (service `revolut-claude-production.up.railway.app`), 1 replica, US-West, deploys from GitHub on push.
- **Interfaces:** Telegram bot (alerts + trade approval), a web dashboard (`public/dashboard.js`), and an MCP server (`/mcp`) exposing tools to Claude.
- **External APIs:** Revolut X (primary exchange), Kraken (secondary), Tangem (XRP cold-storage balance), Anthropic (AI analysis + web research), Telegram Bot API, Google Drive (backups).
- **Repo:** `github.com/BurhanDawood/revolut-claude` (public). **Local:** `C:\Users\owner\revolut-claude\server.js`.

**Secrets (Railway env vars):** `REVOLUTX_API_KEY` / `REVOLUTX_PRIVATE_KEY`, `KRAKEN_API_KEY` / `KRAKEN_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, Telegram bot token, `API_TOKEN` (dashboard/API auth), `BRIDGE_TOKEN`, and the Google OAuth set for backups (`GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` + `GDRIVE_BACKUP_FOLDER_ID`). Secrets are never pasted into chat or Cowork prompts — credential bugs are diagnosed via length/char-code checks, never by echoing values.

### 1.1 The three working threads

Development and operation are split across three Claude contexts, by design:

- **PM thread** — portfolio manager. Handles analysis, alerts, trade logging, strategy reviews, morning briefings. Reads/writes the database via MCP tools. Never edits code.
- **Dev thread** — lead developer / diagnostician. Diagnoses read-only against a cloned repo, writes Cowork prompts, verifies read-backs, manages the `dev_log`. Never edits live code directly.
- **Cowork** — a separate PC agent that performs the actual file edits and runs `PUSH_NOW.bat` to commit/deploy. Receives single-box prompts from the Dev thread, returns read-backs.

This separation is deliberate: the Dev thread reasons and verifies but cannot push; Cowork executes but does not design. Every change passes through a written prompt + a verified read-back before deploy.

---

## 2. Data-Flow Map

### 2.1 The main monitoring loop
`checkPortfolio()` runs every 5 minutes. It pulls live tickers from Revolut X (one `/tickers` call → a price map of ~788 entries), pre-loads Kraken-only coins (GHIBLI, XPL, TAO) via Kraken, loads 24h baseline prices from `price_history`, then iterates every held/watched coin: computes % move vs 24h, skips dust (<$1 position value), and evaluates alert conditions (fixed targets, daily-move thresholds, trailing stops, auto-rules).

### 2.2 Intraday capture (#50 Build 1)
`captureIntradayPrices()` runs every 2 minutes (decoupled from the 5-min loop). Captures all non-meta `coin_strategy` coins (held + watch) into `price_intraday`. This is the data clock for the future ATR/abnormal-move detector (#50 Build 2) — baseline needs ~2–4 weeks of accrual to be meaningful.

### 2.3 Cron schedule (Europe/London)
- `0 0 * * *` — `recordDailyPrices` (writes daily close to `price_history`; resets daily alert tracking).
- `0 2 * * *` — prune (intraday housekeeping).
- `15 2 * * *` — prune `price_intraday` rows >30 days.
- `0 3 * * *` — `runReconciliation` (#55: system positions vs exchange balances vs tranche sums; flags drift).
- `30 3 * * *` — `backupDatabaseToDrive` (#12: nightly DB dump → Google Drive).
- `*/5 * * * *` — `checkMacroNews` (RSS macro/news scan).
- `5 9 * * 1` — Monday rebalancing check.
- `10 9 * * 1` — Monday weekly snapshot.
- `0 10 * * *` — `checkIntentionOutcomes`.
- `5 10 * * *` — `checkRebalancingOutcomes`.
- `10 10 * * *` — `gradeTradeOutcomes` (#48: forward +7d/+30d grading).
- Morning briefing (`5 9 * * *`) is currently **disabled** (commented), kept for manual use.

### 2.4 Alert pipeline
Conditions evaluated in the 5-min loop → if fired and not in cooldown / not acknowledged → Telegram notify. Acknowledged-alert state persists to `macro_alerts_sent` (so redeploys don't re-fire — #70). Fixed-target cooldowns are 24h. Alerts are **notify-only** for held positions; nothing auto-executes while auto-exec is disabled (current default).

### 2.5 Trade execution + approval path
A trade (from MCP `execute_kraken_trade` or the Revolut path) creates a *pending* trade → Telegram "approval needed" → owner replies 👍 / approve → execution → journal write + tranche update. **All `/api/*` write routes require `x-api-token`** (#43, fail-closed); the critical trade endpoints reject unauthenticated calls with 401 before reaching the handler. Known limitation: the approval handler tracks only the most-recent pending trade, so laddered multi-rung approvals clobber each other (#44, open).

### 2.6 Reconciliation (#55)
Nightly at 3 AM: compares Revolut `/balances` (available) + Kraken balances against non-legacy tranche sums per `symbol,exchange`. Tolerance 0.5%; skips untracked/dust; tags `system > available` as possible open-order (a resting limit reserves coin). Telegram only on *new* drift. This institutionalised the manual ground-truth check that originally caught the #47 phantom-tranche bug.

---

## 3. Subsystem Map

- **MCP tools (14 active):** `get_portfolio_summary`, `get_portfolio_data`, `get_trading_data`, `get_context`, `manage_alerts`, `manage_trading`, `set_entry_price`, `execute_kraken_trade`, `set_auto_trade_rule`, `get_auto_rules`, `manage_auto_rules`, `get_prices`, `get_tranches`, `research_asset`. The tool list/count is seeded into `system_capabilities` config at boot.
- **Auto-rules engine:** per-coin rules (moon-bag 25% sells at a $999 sentinel, buy-dip, etc.). 21 clean moon-bag rules currently armed. Master `ai_auto_execute` config is **disabled**; even when enabled it is railed (caps, floors, manual-only symbols) and is the rare exception, not the norm. A per-coin sell-floor (#45) is a prerequisite before re-enabling any below-entry-capable trigger.
- **Tranche / tax-lot tracking:** per-lot accounting supporting **US HIFO** and **UK S104**. Tranches decrement on sells; the known open work is the limit-order lifecycle + orphaned-tranche disposal (#47 Part 2).
- **Intention system:** `log_intention` records an intended trade *before* execution; outcomes are graded later (#48). Intentions match to auto-detected fills.
- **`coin_strategy` registry:** one row per coin (`status, role, theme, strategy_md, updated_at, updated_by`) — the persisted per-coin plan (thesis, alert rungs, role). Read before analysing any coin; updated in the same breath as changing an alert. Surfaced on dashboard cards.
- **USDT sweep:** optional auto-conversion of trade proceeds (currently disabled).
- **Dashboard (`public/dashboard.js`):** read views + a few control POSTs (pause/resume/sweep config). Tappable asset cards (#57). Surgical edits allowed (#66) with a `.bak` backup; `node --check` always before push.
- **Backups (#12):** nightly pure-JS DB dump → gzip → Google Drive via OAuth-delegated upload (uploads as the owner's Drive — service accounts have no Drive quota). 14-file retention, Telegram confirmation.
- **Research layer (#72, #68 umbrella):** `researchAsset()` + `research_asset` MCP tool — on-demand, plan-aware deep web research using the Anthropic web-search tool, evaluated against the saved `coin_strategy` plan, recommend-only. Build 1 proven; persistence/diff/strategy-link is Build 2 (event-driven, not daily — cost ~$0.22/call makes a daily full-book sweep uneconomic). This is one engine with pluggable sources (catalyst #40, YouTube #61, social #69) under the #68 intelligence-layer framing.

---

## 4. Key Design Decisions (and why)

- **MySQL on Railway, single `server.js`.** One deploy target, one process, one DB; simple to reason about and cheap to run for a single user. Not split into services because the operational surface (one owner, one portfolio) doesn't justify the complexity.
- **Auto-exec stays OFF by default.** The owner's edge is discretion; the documented weakness is rushed/FOMO decisions. The system defaults to *analyse-then-notify*, never *act*. Auto-exec, wherever enabled, is railed (caps, floors, manual-only symbols) and is the rare exception, not the norm. A per-coin sell-floor (#45) is a prerequisite before re-enabling any below-entry-capable trigger.
- **No leverage, no stop-losses.** The owner trades spot only and uses trailing stops to protect gains, never stop-losses. Generic "tighten your stops / leverage" boilerplate is wrong for this profile and must be stripped from any alert (#76).
- **Telegram-gated execution.** Every trade requires explicit approval. The MCP trade tool cannot fire autonomously; the API trade routes are token-protected and fail-closed.
- **Phased builds (Path C).** Large features ship as Build 1 (foundation/data clock) then Build 2+ (the intelligence on top), proving each layer live before extending. Examples: #50 (intraday capture → ATR detector), #72 (research primitive → persistence/diff). This keeps each deploy small and verifiable and surfaces real cost/quality data before committing to the expensive half.
- **`COIN-USD` dash format** for order symbols (Revolut convention); the price map stores both `COIN/USD` and `COIN-USD` keys.
- **Single-write tranche discipline.** Tranche side-effects should happen once, at confirmed fill — not at order placement. Double-writes at placement+fill are the root of the #47 phantom/duplicate class.
- **Live DB is the source of truth.** Narrative — memory, checkpoints, prior summaries — is always to be *verified* against live data, never trusted over it. When they conflict, live wins and the correction is stated explicitly.

---

## 5. Conventions (development workflow)

- **Single-box Cowork prompts (#64).** Every Cowork prompt is one fenced code block (no nested fences) for one-tap copy, and instructs Cowork to return its read-back in the same single-box format. The read-back must contain everything needed to verify without a follow-up: full read-back of each edit site, `node --check` result, and any other requested checks (grep, line numbers, boot lines). The prompt's closing checklist enumerates exactly what the box must contain.
- **Surgical-edit policy (#66).** Targeted edits to `dashboard.js` are acceptable and often preferred over whole-file retransmission; `.bak` backup first; `node --check public/dashboard.js` must pass before every push. Dev decides atomic-vs-surgical per situation.
- **Diagnose read-only before editing.** The Dev thread clones the repo and inspects; it never edits live code. It writes the change as a prompt for Cowork.
- **`node --check` before every push.** Non-negotiable. No deploy without a clean syntax check in the read-back.
- **One change at a time; never bundle across a trade-execution boundary.** Trade-path changes ship alone.
- **Model-usage policy (#67).** Sonnet for light work (reads, verification, small prompts, log writes); Opus for heavy work (feature design, multi-file reasoning, root-cause diagnosis). Claude states the recommended model at session start and flags switches; the owner toggles (Claude cannot switch its own model).
- **Session continuity.** Both PM and Dev projects carry custom instructions enforcing a startup ritual (`get_context` → `get_auto_rules` → `get_trading_data include=['dev_log']`) and read a session checkpoint preference (`session_checkpoint_dev` / `_pm`) as "where we left off" — verified against live data. A checkpoint is written at session close.
- **Credential-bug diagnostics.** For auth failures, log only value *lengths* and last-character codes — never the secret. Mobile paste commonly introduces leading/trailing whitespace (this was the root cause of the #12 OAuth `invalid_client` saga: a leading space on the client ID).

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
- **#12** — nightly DB backup to Google Drive (OAuth-delegated, gzip, 14-file retention). *Deployed/verified — last Tier-1 safety item.*
- **#72 Build 1** — `researchAsset()` primitive + `research_asset` MCP tool (plan-aware web research). *Deployed/proven.*

---

## 7. Open-Issues Index

The **`dev_log`** (queried via `get_trading_data include=['dev_log']`) is the live ticket board and the authoritative source for open work. High-level priority tiers (see the `dev_priority_queue` preference for the maintained ordering):

- **Tier 1 — resilience/safety:** #43 ✅, #12 ✅, #55 (deployed, monitoring).
- **Tier 1.5 — data cleanup:** #47 Part 2 (limit-order lifecycle + orphaned-tranche disposal).
- **Tier 2 — core quality / intelligence layer:** #72 Researcher (keystone) → #36 plan-aware alerts → #50 Build 2 ATR detector → #49 MSS tracker → #40 catalyst calendar. Umbrella framing in #68; sources #61 (YouTube), #69 (social).
- **Tier 2.5 — learning loop:** #48 outcome loop → #52 shadow tracker → #54 emotion×outcome → #51 checklist gate → #53 concentration dashboard.
- **Known bugs to watch:** #71 (portfolio undercount — feed reads available not total), #76 (macro alert not price-aware), #74 (context-blind ladder rec), #44 (multi-trade approval clobber), #75 (dashboard render verification).
- **Auto-exec safety (each its own session):** #45 sell-floor → #24 per-coin config → #46 availability-gated → #33/#34 modes.
- **Documentation:** #73 (this file). Consider periodic export of the `dev_log` to a dated markdown changelog to guard against detail-replacement on ticket updates.

---

*This document is maintained by hand. It is a map and a rationale, not a substitute for the `dev_log` (live tickets) or git history (exact diffs). When a major subsystem ships or a load-bearing decision changes, update the affected section and the "Last updated" date.*
