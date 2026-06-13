# dev_log export — 2026-06-13

> Generated: 2026-06-13T23:56:00.354Z | Total tickets: 79

---

## #1 — created_at column missing — target acks restore + tranche seeding both fail on boot

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-04

RESOLVED 2026-06-09 ~23:xx. Fixed via Option B (use the column that already exists, NO schema change). Root cause (diagnosed by reading server.js directly from Drive backup — code-relay solved): macro_alerts_sent has column 'sent_at' NOT 'created_at'; balance_snapshots has 'recorded_at' NOT 'created_at'. Four queries wrongly referenced created_at. Fixed: L943 (target acks restore) created_at->sent_at; L6358 + L6473 (target cooldown UP+DOWN, identical) created_at->sent_at; L1431 (seedLegacyTranches snapshot order) created_at->recorded_at. All other ~56 created_at refs in file left untouched (they're on tables that genuinely have the column). node --check clean, read-back verified all 6 lines, deployed. CLEAN BOOT PROOF: both error lines GONE ('Could not restore target acks' + 'seedLegacyTranches failed' no longer appear). BONUS: seedLegacyTranches, which had NEVER successfully run (failed on the bad ORDER BY before it could seed), now ran to completion for the first time — seeded legacy tranches for ~30 coins from avg entry prices ('Legacy tranche seeding complete'). NOTE FOR TRANCHE-REVISIT: those seeded rows read a mid-state balance snapshot (e.g. CC seeded 16,895 during boot but live CC ~21,395 post-ladder-sells) — sanity-check seeded tranche quantities when tranche tracking is next worked on; not driving anything currently. \\n\\nDEPLOY NOTE / NEW WORKFLOW BUG: bundled + pushed together with #2. PUSH_NOW.bat has a HARDCODED stale commit message ('feat: dev_log #38 B3 — removeFixedTarget...') left over from a B3-prep session — so BOTH this commit (d3ff885) AND the prior (f9a9cc2) are mislabeled 'B3' in git history. B3 has NOT actually been built. The CODE in d3ff885 is the #1+#2 fix (diff 7 ins/6 del matches our 6 edits); only the message is wrong. WORKFLOW FIX NEEDED: PUSH_NOW.bat should take a per-commit message (or prompt), not a frozen string, else every push is mislabeled. Add to #37/workflow notes.

---

## #2 — Tool count surfacing as 13 not 11 (get_tranches + manage_auto_rules extra)

**Status:** 🔵 open | **Category:** note | **Source:** developer

**Created:** 2026-06-04

RESOLVED 2026-06-09 ~23:xx (bundled with #1). The stale system_capabilities blob (server.js ~L1251) updated total_mcp_tools 11->13 + added 'get_tranches' and 'manage_auto_rules' to the tools array. VERIFIED LIVE via get_context: system_capabilities now reads total_mcp_tools:13 with all 13 tools listed, last_updated 2026-06-09T22:54:20Z (rewritten this boot). NOTE: the SEPARATE 'project_description' config blob (also in systemConfig) still says '11 active' + 'consolidated to 11' in its text — that's a different, human-readable description blob, lower priority cosmetic, can update later if wanted. Core tool-count discrepancy resolved.

---

## #3 — AVAX tax lot 35 broken — mislinked to buy row, wrong qty, incomplete cost basis; needs reconstruction not backfill

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-04 | **Symbol:** AVAX

NEW SYMPTOM 2026-06-11: AVAX fixed-target alert (the $6.50 make-or-break fire) displayed 'Entry: $13.42 | P&L: -51.6%' — but Bryan holds ZERO AVAX (position fully exited June 4 @ $7.94 in the dump rotation; $13.42 is the old stub-era entry). Alert engine is pulling a stale entry price for an EXITED coin and presenting a phantom P&L. MISLEADING: makes a watchlist re-entry alert read like a live losing position. FIX: when computing alert Entry/P&L lines, check actual current balance/position status first — if position is zero/exited (coin_strategy status=watchlist/exited), suppress the Entry/P&L line entirely or show 'No position — watch alert'. Ties to the AVAX history-reconstruction work in this ticket.

---

## #4 — Exit reasoning preserved for 7 capital-protection sells (BTC $63K breakdown) before deleting duplicate narrative rows

**Status:** ✅ resolved | **Category:** note | **Source:** developer

**Created:** 2026-06-04

Preserving the exit reasoning before deleting the 7 duplicate narrative journal rows (the prose-only twins; canonical stubs with P&L + tax lots are kept). All 7 were CAPITAL-PROTECTION SELLS on 2026-06-04 ~01:19-01:20 UTC, triggered by BTC breaking down to ~$63K through $65K support; Bryan exited 100% of each to USDT to protect capital, intending to re-enter lower once BTC stabilises. Per-coin realised P&L (from canonical stub outcome_pnl) and notes: NEAR (stub 1763, narrative 1771) +$46.41 — only winner, sold $2.75 vs $2.474 entry, DTCC Stellar/NEAR catalyst intact. CC (stub 1764, narrative 1772) -$23.75 — entry $0.1556, will rebuy ahead of DTCC July catalyst. LINK (stub 1769, narrative 1773) -$382.99 — entry $10.18, DTCC Q4 catalyst intact, rebuy lower. XLM (stub 1765, narrative 1774) -$25.11 — entry $0.386, DTCC Stellar catalyst intact. ENA (stub 1767, narrative 1775) -$1,445.41 — largest loss, entry $0.3727, fee-switch catalyst still pending. RENDER (stub 1770, narrative 1777) -$168.02 — entry $3.291, AI narrative intact. JTO (stub 1766, narrative 1778) -$269.88 — entry $1.23, Jito governance catalyst intact. AVAX handled separately (see dev_log id 3 — broken tax lot). After this entry, narrative rows 1771,1772,1773,1774,1775,1777,1778 are safe to delete (verified: no tax_lots reference them).

---

## #5 — autoLogTrade CHECK 3 quantity-dedup failed to catch identical AVAX buy 77s apart — real bug, needs diagnosis not blind fix

**Status:** in_progress | **Category:** bug | **Source:** developer

**Created:** 2026-06-04 | **Symbol:** AVAX

DIAGNOSED (read-only) 2026-06-06 — root-cause narrowed to a fail-OPEN dedup; final confirmation needs a Railway log pull that may be out of retention. CODE FINDINGS (autoLogTrade ~lines 3439-3550): CHECK 3 (quantity dedup, lines 3501-3517) is the intended guard and its SQL is CORRECT for the AVAX case — qty diff 33.1907000-33.1906860 = 0.0000140 < 0.01 threshold, symbol formats consistent (coinBase 'AVAX' used in both the CHECK 3 params AND the INSERT, so NO format mismatch — rules out suspect (c)). CHECK 2 (lines 3479-3499) cannot catch this by design — its source filter is ('claude_mcp','auto_rule','ai_auto') and both AVAX rows are source=auto_detected. THE STRUCTURAL FLAW: every check's catch (e.g. line 3516) does only console.error() then FALLS THROUGH to the INSERT at line 3547 — i.e. the dedup FAILS OPEN. Any transient DB error (timeout/connection blip/deadlock) in CHECK 3 silently becomes a duplicate insert. TWO LIVE HYPOTHESES, both exploit the same fail-open weakness: (1) CHECK 3 query THREW and was swallowed -> fell through to INSERT (log signature: '[autoLog] Quantity dedup check error' in the 09:18-09:21 window 2026-06-03); (2) SERVER RESTART between 09:18:53 and 09:20:10 — the in-memory pendingTradeContext debounce (line 3455) is zeroed on restart AND row 1741 may not have been committed/visible to the new connection when CHECK 3 ran for 1742, so it matched nothing (log signature: a 'Server running on port 8080'/startup line in that window). LOG PULL REQUESTED for 2026-06-03 09:17:30-09:21:30 UTC to distinguish — but Railway retention may not reach 3 days back; if unavailable, proceed on the fail-open fix which covers BOTH hypotheses. PROPOSED FIX (NEXT SESSION, not today — live trade-logging code, needs its own careful run + Bryan decision on the tradeoff): make CHECK 3 fail SAFE rather than fall through on error — on a dedup-query exception, do NOT insert (or retry once on a committed read) since a missed auto-detect is manually recoverable whereas a silent duplicate corrupts capital/P&L (cf. #20). Also reduce reliance on the in-memory debounce as the only fast guard so a restart can't open the gate. TRADEOFF to weigh: fail-safe risks dropping a genuine trade on a DB error — Bryan to decide fail-safe vs retry-then-insert. RELATED: this is the same fail-open family as #20 Part B (intention/auto-detect double-log) — fix together.

---

## #6 — Third duplicate path: PM-thread log_journal after Telegram-enriched auto-detect; Fix #1 covers it only within 15-min window

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-04 | **Resolved:** 2026-06-04

RESOLVED — both parts live. PART B (DONE, no code): PM-thread system prompt updated to ALWAYS call get_trading_data include=['journal'] and check for an existing matching row BEFORE log_journal; confirm rather than re-log if found; ASK user 'same trade or new one?' if ambiguous (protects ladder trades the agent way). PART A (DONE, deployed+booted 2026-06-04 ~13:32): log_journal dedup guard widened to 6 HOUR window AND tightened — price +-1% OR branch removed entirely, quantity tolerance tightened to ABS(qty diff) < 0.0001 (was 0.01) so separate ladder sells of the same coin with different sizes do NOT collapse; only a re-log of the same fill matches. Enrich-via-COALESCE UPDATE, fail-open catch (falls through to INSERT on SELECT error — never loses a trade), and normal INSERT-when-no-match all unchanged. node --check passed, clean Railway boot confirmed. Combined effect: agent checks first (B), code backstops within 6h (A). Residual risk: two genuinely separate same-action trades of EXACTLY equal quantity within 6h still merge — rare, and Part B's ask-the-user catches it. Third duplicate path now CLOSED from both directions. (Original 3-path context above retained.)

---

## #7 — Journal-duplicate audit complete — 3 dupes deleted (LINK 65, NEAR 73, PEPE 77), PONKE kept (real double-buy), holdings repeats are a display issue not dupes

**Status:** ✅ resolved | **Category:** note | **Source:** developer

**Created:** 2026-06-04

Full journal-duplicate audit run 2026-06-04 via Query tab (self-join on symbol+action+qty<0.01+within 600s). Found only 5 candidate pairs total — duplication far less widespread than feared. Tax-lot safety check (SELECT tax_lots WHERE journal_id IN the 8 ids) returned ZERO — none referenced, safe to delete. RESOLUTION: deleted 3 confirmed same-source duplicate rows — LINK buy id 65 (kept 64), NEAR sell id 73 (kept 72), PEPE buy id 77 (kept 75). KEPT BOTH PONKE 154+157 (5s apart, sources differ auto_detected vs auto_rule) — Bryan confirmed from memory PONKE genuinely bought TWICE, so these are two real trades NOT a duplicate; deleting would undercount position. AVAX 1741/1742 left alone — part of AVAX reconstruction (dev_log 3). IMPORTANT FINDING: the POL/PYTH/MOG/HFT repeats seen in the dashboard HOLDINGS list are NOT journal duplicates (none appeared in this audit) — they are a separate dashboard holdings-render issue, lower priority, NOT a data-integrity problem. Journal-duplicate cleanup now COMPLETE except AVAX buys (handled in reconstruction).

---

## #8 — XLM cross-cycle P&L calculation incorrect

**Status:** 🔵 open | **Category:** bug | **Source:** Claude

**Created:** 2026-06-04 | **Symbol:** XLM

SHARPENED 2026-06-11 (Bryan wants a per-asset CROSS-CYCLE realized-P&L ledger — 'see how much I've earned on a particular asset across cycles'). This is the headline deliverable for #8. Two concrete findings from a journal audit today:

(A) NEW BUG — outcome_pnl is only populated on source=auto_detected sells; source=claude_mcp (Telegram-approved) sells have outcome_pnl=NULL. Confirmed: CC trims 1813/1834/1835/1836, JTO trim 1810, PYTH 1843 all NULL; while auto_detected sells (1763/1766/1767/1769/1770/1789/1790/1765/1764/1759/1754/1750/1748/1746) all have HIFO outcome_pnl + outcome_notes. IMPACT: any per-asset realized total built from outcome_pnl SILENTLY OMITS all manual/Telegram trades — i.e. most of Bryan's deliberate swing trims. FIX: compute realized P&L (HIFO US + S104 UK) for ALL sell sources at log/fill time, not just auto_detected.

(B) DELIVERABLE — a per-asset lifetime ledger view (dashboard card + MCP read): for each symbol, total_cash_in, total_cash_out, realized_pnl (cross-cycle = sum of all sells' proceeds minus matched cost basis, NOT current-cycle entry), unrealized_pnl (open qty × live price − open cost basis), and lifetime_total. Must net BUYS and SELLS across ALL cycles (#8 core), span all trade sources (per A), exclude payment/transfer types from P&L, ignore approval-time-but-unfilled rows (#47 — only count FILLED), and reconcile AVAX stub (#3). This is the 'how am I doing on each coin' view; pairs with #48 outcome loop (grades) and feeds the recovery card. PRIORITY: promote within Tier 4 — Bryan actively wants this now for mental reference.

---

## #9 — Need get_prices endpoint for any symbol regardless of holdings

**Status:** ✅ resolved | **Category:** feature | **Source:** Claude

**Created:** 2026-06-04 | **Resolved:** 2026-06-04

RESOLVED — deployed commit 4c961d8, verified live. ROOT CAUSE: get_prices was NOT missing (it existed + surfaced fine) — it called a dead endpoint GET /market/tickers which 404'd for every symbol, so the PM thread fell back to stale web-search prices (caused the $2.80-vs-actual-$2.38 NEAR error). The working price path elsewhere uses GET /tickers (no /market/ prefix); getCurrentPrice() (line 2240) already does Revolut /tickers first + Kraken fallback. FIX: rewrote get_prices handler (lines 7378-7385) to delegate to getCurrentPrice(sym) instead of calling the dead endpoint — gets the Kraken fallback for free, single canonical price path. Normalizes symbol to dash format, returns clean {symbol, price, source:'live'} or {symbol, error} if unavailable. node --check could not run (Cowork sandbox VM down) but change was 7 isolated lines in a read-only tool handler (contained blast radius); pushed and Railway booted clean. VERIFIED LIVE via MCP: NEAR-USD $2.2332, BTC-USD $63303.41, GHIBLI-USD $0.000319 (GHIBLI proves Kraken fallback works — Revolut doesn't list it). PM thread now has working live-price lookup for any coin held or not. Note for context: BTC still ~$63K at time of fix.

---

## #10 — USDT-USD sell executes as $0 volume

**Status:** ✅ resolved | **Category:** bug | **Source:** Claude

**Created:** 2026-06-04 | **Resolved:** 2026-06-04

FIX DEPLOYED (Option A — estimate from value_usd; Option B real-fill parsing remains the precision upgrade for later). 2026-06-04: Root cause confirmed — execute_kraken_trade stored baseSize/volume = (volume || 0), so value_usd-only trades stored 0; journal then wrote quantity=0 and value=price*0=0; the qty-0 row also DEFEATED dedup (proof: NEAR triple-row 1781/1782/1783, since cleaned). Neither placeRevolutOrder nor executeKrakenTrade extracts filled qty from the exchange response (that gap = Option B later). FIX (4 changes, node --check passed, redeployed): (1) pending trade objects use estBaseSize = volume || (value_usd && livePrice ? value_usd/livePrice : 0), plus a qtyEstimated:true flag. (2) Revolut journal write: qtyForJournal = parseFloat(baseSize) || (valueUsd && executedPrice ? valueUsd/executedPrice : 0); valueUSD = valueUsd ? parseFloat(valueUsd) : executedPrice*qtyForJournal; INSERT uses these; reasoning gets ' [qty estimated from value_usd]' appended when qtyEstimated. (3) Kraken path same pattern (kQtyForJournal/kValueUSD). (4) confirmation messages use qtyForJournal so they show real token amount + '(qty est)' when estimated. EFFECT: future value_usd trades store a real (estimated ~99% accurate) quantity, Telegram shows correct numbers, dedup can function. CAVEAT: quantity is an ESTIMATE (value_usd/price) not the exact exchange fill — off by spread/fees (~0.7% seen on NEAR $500 req vs $496.66 fill); flagged per-row by the marker; verify exact quantities from Revolut export at tax time. Existing rows NOT retroactively changed (journal already clean). VERIFY: confirm clean boot; true test is next value_usd trade showing real qty + '(qty est)' instead of 0.0000.

---

## #11 — Telegram replies need exact strings; 'rebalance' overloaded — trade-context tag misroutes to rebalancing analysis

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-04

Telegram trade-context and payment replies require EXACT command strings and fail/misroute on near-misses, causing confusion and unintended actions. Observed 2026-06-04 on the NEAR buyback: (1) 'Usdt skip payment' did not match the expected exact 'skip payment' for the USDT-decrease/card-payment prompt — extra prefix broke it. (2) 'Rebalance NEAR' and 'Rebalance' — intended as the trade-context reply 'rebalance [coin]' (bought with proceeds from selling [coin]) — were instead routed to the PORTFOLIO REBALANCING ANALYSIS feature ('Analysing your NEAR position', 'Running full portfolio rebalancing analysis 30-60s'). So the word 'rebalance' is overloaded: it means both a trade-context tag AND a command that triggers rebalancing analysis, and the parser can't tell which the user means. IMPACT: trade-context reply never registered (NEAR buy will fall back to 30-min auto-log without reason text); user accidentally triggered 2 rebalancing-analysis runs; payment prompt may still be pending. FIX IDEAS: (a) make reply matching tolerant — trim/lowercase, ignore extra words, fuzzy-match the intent; (b) disambiguate 'rebalance' — use a distinct keyword for the trade-context 'funded by selling X' tag (e.g. 'from [coin]' or 'proceeds [coin]') vs the analysis command; (c) when a trade-context prompt is pending, route replies to the context handler first before the analysis-command handler; (d) echo back what was understood and let user correct. Low data-risk (auto-log backstop catches the trade) but high friction and easy to mis-fire, especially when tired.

---

## #12 — FEATURE: daily automated backup to Google Drive (DB dump + encrypted env vars) for disaster recovery — scoped, deferred

**Status:** ✅ resolved | **Category:** feature | **Source:** developer

**Created:** 2026-06-04 | **Resolved:** 2026-06-13

✅ CLOSED + VERIFIED LIVE 2026-06-13. Nightly DB backup to Google Drive WORKING end-to-end — proven by manual test: '✅ DB backup complete — revolut-db-2026-06-13-1859.sql.gz (287.8 KB) → Google Drive'. Full pipeline confirmed: dumpDatabase (all tables, SQL INSERTs, escaped) → gzipSync (287.8 KB) → OAuth token refresh → Drive multipart upload (HTTP 200) → 14-file retention → Telegram confirm. Nightly cron '30 3 * * *' Europe/London is the live trigger. Temp test-trigger + diagnostic lines removed (commit 'chore: #12 remove temporary backup test trigger + diagnostic').

ARCHITECTURE (final): OAuth-delegated (uploads as Bryan's own Drive, not service account — service accounts have no storage quota, was the original 403). 3 Railway env vars: GOOGLE_OAUTH_CLIENT_ID/_SECRET/_REFRESH_TOKEN + GDRIVE_BACKUP_FOLDER_ID (1Ccc5z_eZwBeacYdJOpap3VcusVyxnCjN). Drive scope drive.file via OAuth client 'backup-oauth' in Google project mercurial-song-402622. No new npm deps (built-in crypto/zlib/fetch + @anthropic SDK already present; googleapis NOT used). bkBase64url() now dead code (harmless, left in).

DEBUG SAGA (lesson): two sequential auth failures, both credential-paste artifacts not code bugs. (1) Original service-account JWT → 403 storageQuotaExceeded (service accounts have no Drive quota) → switched to OAuth refresh-token delegation. (2) Then 401 invalid_client through MULTIPLE redeploys — root cause finally caught by a SAFE diagnostic (logged only env-var LENGTHS + last-char codes, never secret values): GOOGLE_OAUTH_CLIENT_ID had a LEADING SPACE from mobile paste (len=73 not 72, startsOK=false, endsOK=true). Removed space, re-pasted → worked first try. LESSON: for credential-paste bugs, the length/char-code diagnostic beats re-pasting blind; mobile paste commonly adds leading/trailing whitespace; trailing-newline-on-secret was the wrong suspect (secret was clean lastChar=66='B').

This was the LAST Tier-1 safety item. Off-platform automated nightly DB backup now live, free (Railway native backups were £20/mo Pro-only, declined). Future enhancement (low pri): if dump grows large, exclude conversation_history table; consider periodic dev_log export to Drive as durable changelog (ties to #73).

---

## #13 — Add manual_only_symbols to ai_auto_execute config

**Status:** ✅ resolved | **Category:** feature | **Source:** Claude

**Created:** 2026-06-04 | **Resolved:** 2026-06-06

RESOLVED 2026-06-06 (same work as #18 half 2). manual_only_symbols array added to ai_auto_execute config, default ['CC','XRP','NEAR'], with a parallel gate in autoExecuteSell after the hodl check that routes these coins to Telegram for manual decision and returns before shouldAutoExecute — never auto-executes regardless of confidence. VERIFIED via get_context: config contains manual_only_symbols:['CC','XRP','NEAR']. Distinct from hodl_symbols (which never sell at all); manual_only coins CAN be sold but only with Bryan's explicit approval after seeing analysis. Note: the trader_profile 'manual_decision_coins' preference still lists only CC, XRP (text pref, pre-dates this) — the live config gate now also includes NEAR. If you want the profile text to match, update manual_decision_coins to add NEAR; not functionally required since the config is the source of truth for the gate.

---

## #14 — XRP multi-location tracking — Tangem + Revolut X split view

**Status:** 🔵 open | **Category:** feature | **Source:** Claude

**Created:** 2026-06-04

XRP is held across two separate platforms and needs split tracking on the coin history card:

LOCATION 1 — Tangem Hardware Wallet:
- Qty: 1,000 XRP
- Avg entry: $2.65
- Value: ~$1,170 (at current $1.17)
- P&L: -55.8%

LOCATION 2 — Revolut X:
- Qty: 2,000 XRP
- Avg entry: $1.1736
- Value: ~$2,344
- P&L: -0.3%

COMBINED VIEW:
- Total qty: 3,000 XRP
- Combined avg entry: (1000 × $2.65 + 2000 × $1.1736) / 3000 = $1.6657
- Combined value: ~$3,514
- Combined P&L: -29.8%

Coin card requirements:
1. Show each location separately with its own entry price and P&L
2. Show combined total at bottom with blended average entry
3. Apply same multi-location logic to any other coin held across Revolut X + Kraken + Tangem
4. Location badges: 🔄 Revolut X | ⚡ Kraken | 🔒 Tangem

---

## #15 — Rotation / opportunity-cost tracker for capital salvaged from loss exits

**Status:** 🔵 open | **Category:** feature | **Source:** Claude

**Created:** 2026-06-05

Bryan wants to see, when he exits a red position and redeploys the salvaged cash into a DIFFERENT coin (rather than rebuying the original), how that rotation is performing — so the realized loss on coin A is visible alongside what the redeployed capital did in coin B.

BUILD THIS AS A NEUTRAL DECISION-EVALUATION TOOL, NOT A LOSS-RECOVERY DEBT TRACKER. Important design distinction agreed with Bryan:

DO build ("rotation / opportunity-cost"):
- Record the rotation event: sold coin A (date, price, realized P&L), salvaged $Y, deployed $Y into coin B (date, price).
- Track forward performance of B since deployment, AND benchmark it against the two real counterfactuals: (a) if he had instead held / rebought coin A, (b) if he had left the cash in USDT.
- Output framing: "Rotation A->B is +/- $Z vs holding A, +/- $W vs USDT." Scores decision quality only.

Do NOT build ("loss-recovery attribution"):
- Do NOT tag coin B as "assigned to recover coin A's $X loss" or show a running "amount still needed to recover the A loss." This creates a mental debt that incentivizes oversizing B and holding B too long to "get even" — the classic loss-chasing failure mode. Money is fungible once A is sold; the new position should be sized and judged on its own forward merits, not on the size of a past loss.

Data already available: journal has realized P&L per exit (outcome_pnl) and the rebalance/buy rows that received proceeds. Main new work: explicitly link an exit to the redeploy target, and compute the two counterfactual benchmarks using live prices. Not urgent; design-it-right item.

---

## #16 — Session-state memory layer for cross-chat working continuity

**Status:** ✅ resolved | **Category:** feature | **Source:** Claude

**Created:** 2026-06-05 | **Resolved:** 2026-06-05

BUILT AND VERIFIED 2026-06-05, commit 86c81a8. Two tables (session_state single-row + session_history append-only), new manage_trading action 'update_session_state' (merge-on-write, prepend+cap-5 for recent_decisions, snapshots to history every write), and get_context now returns the state under key 'working_notes_unverified' (deliberately named so readers treat it as narrative-to-verify, NOT truth). ACCEPTANCE TESTS — 6/7 PASS: T2 auto-load (key surfaces in get_context in a fresh chat) PASS; T3 LIVE-DB-WINS (the critical one) PASS — seeded a false 'ENA auto-rule #42 active' claim; fresh chat read it, called get_auto_rules live, found no #42, reported the live truth and flagged the claim as false (also caught the same phantom in learning_model cache); T4 size cap holds at 5, oldest evicted; T5 append-only history one snapshot per write, evicted decision recoverable; T6 action persists + updated_at advances; T7 no regression (all existing get_context keys intact). T1 (silent/event-driven, no per-message writes) is BEHAVIORAL not code — needs system-prompt instructions for WHEN to call update_session_state (event-driven: workstream change, decision, thread open/close/defer, 'continue later'); plus the OFFERED-CHECKPOINT valve from the spec. That prompt work is the remaining piece. Clean Railway boot confirmed, session_state/session_history migrations ran without error. Feature is safe to use.

---

## #17 — get_portfolio_data does not surface Revolut X USDT/cash balance

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-06 | **Symbol:** USDT

Bryan confirms ~$704 USDT available on Revolut X, but get_portfolio_data (accounts=revolut AND accounts=all) returns ONLY crypto positions — no USDT or fiat/cash line item. The revolut total_value_usd ($5,157) is fully accounted for by crypto positions alone, so the USDT is excluded from both the positions array and the account total. Impact: (1) available dry powder is invisible to Claude for trade sizing/allocation decisions; (2) portfolio snapshots and morning briefings understate true account value by the USDT amount; (3) the USDT sweep feature routes proceeds to USDT, but the system cannot read its own reserve back. Requested fix: include USDT (and any stablecoin/cash) as a balance line in the revolut object and add it to total_value_usd, or expose a separate usdCash field for Revolut X as already exists for Kraken.

---

## #18 — Trailing-stop auto-exec tried to sell NEAR with quantity 0E-8 (qty-0 bug in auto-exec path) AND auto-executed on a manual-only coin

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-06 | **Resolved:** 2026-06-06 | **Symbol:** NEAR

FULLY RESOLVED 2026-06-06. Both halves done and verified. HALF 1 (dust guard): autoExecuteSell + autoExecuteKrakenSell now guard `if (sellQty <= 0 || !isFinite(sellQty) || valueUSD < 1) { skip; return; }` — the 0E-8 NEAR error was a dust ghost (real NEAR position sold prior day, only ~0.00000449 dust left; 25% of dust rejected by exchange). Deployed, clean boot, NEAR now shows [dust] Skipping at monitor level consistently. HALF 2 (the real protective layer — manual_only_symbols, was dev_log #13): added manual_only_symbols gate to autoExecuteSell immediately after the hodl gate, mirroring its exact style (pendingAnalysis, alertContextBySymbol, lastAlertCoin, numbered-options Telegram message, return before shouldAutoExecute). Default ['CC','XRP','NEAR'] patched into ai_auto_execute config on startup (log: '[config] manual_only_symbols patched'). VERIFIED via get_context: ai_auto_execute config now contains manual_only_symbols:['CC','XRP','NEAR'] alongside the 20 hodl_symbols. Gate order: hodl -> manual_only -> shouldAutoExecute. These three coins now NEVER auto-execute regardless of confidence — always route to Telegram for Bryan's decision. CC matters most (75% of Revolut crypto). Had NEAR been a real position when the trailing stop fired, this gate would have prevented the unapproved auto-sell. Clean boot confirmed both deploys. dev_log #13 also resolved by this same work.

---

## #19 — Dashboard: per-asset Cycle &amp; Tranche History view

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-06 | **Symbol:** JTO

REFINEMENT to requirement (5): the single most-wanted field is a LIFETIME NET P&L per asset = sum of realized P&L across ALL closed cycles (from journal outcome_pnl) + current unrealized P&L on the open position. Today this is not surfaced anywhere: portfolio view shows unrealized-only on the current open position, and realized P&L lives per-trade in the journal (outcome_pnl) with no aggregation. Display as one headline figure per asset (USD and %), with a breakdown expandable into (a) total realized across closed cycles and (b) current unrealized. Validate against JTO right now: realized -$269.88 (closed cycle 1, full sell 453.20 @ $0.6345) + unrealized ~+$0.12 (open cycle 2: 242.42 @ $0.495, live ~$0.4955) = lifetime net ~ -$269.76. Also add a portfolio-wide total of these per-asset lifetime figures so Bryan can see true recovery progress including realized losses, not just unrealized on current holdings. Note: invested-capital figure should reconcile with these realized losses.

---

## #20 — Duplicate journal row + dedup/prompt-suppression failure on intention-matched fill

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-06 | **Symbol:** NEAR

RECURRENCE + NEW failure mode. NEAR T1: intention logged as id 1805 (claude_mcp, buy 111.11 @ $1.80, $200) but the actual fill came in as id 1809 (auto_detected, buy 106.95 @ $1.87, $200) because Bryan raised the limit before it filled. The dedup did NOT match them — likely because matching keys on price and the fill price ($1.87) deviated from the intention price ($1.80). So two NEAR buy rows now coexist in the journal for one tranche. NOTE: the live POSITION is correct (106.95 NEAR, reads actual exchange balance, not summed journal rows), so this is journal/cycle-history pollution (affects feature #19 aggregation), not a position double-count. FIX EXTENSION for the #20 dedup work: matching of an incoming detected fill to an existing claude_mcp intention must tolerate PRICE DEVIATION (and quantity deviation when value_usd is fixed) — match on symbol + side + approximate value_usd within a time window, then enrich the intention row with the actual fill price/qty, rather than requiring exact price match. Also still need: merge/remove the now-duplicate intention rows once a matching fill lands. Original JTO case (id 1798/1800) and this NEAR case (1805/1809) are the same root issue.

---

## #21 — Stale trailing stop not cleared on full position exit (fired on NEAR, AI auto-execute risk)

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-06 | **Symbol:** NEAR

Stale trailing stop fired on NEAR after the position was fully sold. Bryan exited his entire NEAR position (208.22 NEAR @ $2.11) but the trailing stop attached to that position (entry $2.3944, peak $2.2737, trail 10%, stop $2.0463) was NOT cleared on the full exit. It persisted tracking a zero-balance ghost position and triggered as NEAR fell to $1.8551, then kicked off 'Running AI analysis...' for a sell that cannot execute (no NEAR held). Now manually removed via remove_trailing. THIS IS DANGEROUS because NEAR has AI auto-execute enabled — a stale trailing stop on an auto-execute coin can spin up sell analysis/attempts on a position that no longer exists. Requested fixes: (1) When a position is fully exited (balance -> ~0), automatically cancel its trailing stop AND any AI auto-execute state for that symbol. (2) Before running AI sell analysis or executing any auto sell, verify a non-zero live balance exists for the symbol; abort if flat. (3) Audit other trailing stops for staleness — BOBA (entry $0.02575), FLOKI (entry $0.0000285), GHIBLI (entry null) still listed; verify these match live holdings. SEPARATE DATA-QUALITY NOTE: alerts list contains junk/parsed-as-symbol entries (RETRACE-USD, STOP-USD, HONEY-USD, ING-USD, AT-USD) and an INJ-USD fixed target with a 167% threshold/target $13.65 — likely command-parsing artifacts worth cleaning.

---

## #22 — Alert missed a wick that breached target ($0.17 CC) — engine should check interval high/low, not just polled price

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-06 | **Resolved:** 2026-06-06 | **Symbol:** CC

RESOLVED 2026-06-06 (Option A — high-water-mark accumulator). ROOT CAUSE confirmed via read-only diagnosis: the fixed-target check (line ~6151) compared currentPrice = priceMap[symbol] (a single last_price sample per 5-min poll) >= target, with NO between-poll high/low tracking. CC wicked to $0.17000 (above target $0.169994932) and reverted to ~$0.1627 between two polls, so the engine never sampled the breach. FIX (mirrors the existing updateTrailingStop peakPrice pattern): added module-level targetExtremes Map (line ~291); after priceMap is built each poll, an O(n) pass updates {high, low} per symbol; target comparison now uses effHigh = Math.max(currentPrice, ex.high) for UP targets and effLow = Math.min(currentPrice, ex.low) for DOWN targets, so a wick recorded at ANY poll over the target's armed lifetime fires the alert even if price later reverted. Accumulator resets (targetExtremes.delete(symbol)) on all 5 lifecycle exits: up-fire, down-fire, up auto-dismiss, down auto-dismiss, and acknowledgeAlert. In-memory only (rebuilds on restart — same as today, no regression); no new API call (reuses existing /tickers fetch). node --check could not run (sandbox down) but edits additive/no structural change; pushed, clean Railway boot confirmed, first poll cycle ran cleanly (Price map size 788, all targets processed, no throw). KNOWN LIMITATION (by design, was discussed and accepted): catches wicks spanning poll boundaries — a wick that spikes AND fully reverts BETWEEN two polls with no poll sampling during it is still unobservable to last_price polling; only exchange candle high/low (Option B) or faster polling would catch those. Option B reserved as a future precision upgrade if needed. MINOR (not fixed, optional tidy): targetExtremes accumulates entries for ALL ~788 priceMap symbols, not just ones with targets — trivial memory, harmless, but could be scoped to target-symbols only if ever desired.

---

## #23 — Dashboard: "Scorecards" section — saved strategy scorecards with live auto-recompute

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-07

Add a "Scorecards" section to the dashboard that surfaces saved strategy scorecards and auto-recomputes them against live prices. Bryan tracks named, living scorecards stored as Revolut X preferences (first one: key 'scorecard_june_dump_rotation' = "June Dump Rotation Scorecard"). Today these are stored as preference text blobs and recomputed manually by Claude on request — they should be first-class dashboard objects. Requirements: (1) List all saved scorecards by name, each opening a detail view. (2) Each scorecard stores a strategy description + a set of EXITS (coin, qty, sale price, proceeds) + REALIZED detour round-trips (fixed P&L) + an anchor position reference + baseline date/results. (3) Auto-recompute on load: for each clean exit, pull live price and compute 'loss saved vs holding' = proceeds - (qty x live price); sum; add fixed detour losses; show net vs holding, plus the anchor's live unrealized P&L. (4) Show current vs baseline (delta since the scorecard was created) so Bryan can see the trend over time, not just a point reading. (5) Persist baseline snapshot + reference prices so comparisons are apples-to-apples. (6) Include the honest caveats field (unrealized vs realized, damage-reduction vs profit, concentration/conviction notes). Data source: the existing preference store + live price feed — no new capture needed beyond a light schema for scorecard objects. Example to validate against = the June Dump Rotation Scorecard (baseline 2026-06-07: clean-exit loss saved +$562.55, detours -$191.08, net ~+$371, CC anchor +$427.81 / +11.41%).

---

## #24 — Auto-execute config should be per-coin (opt-in) not global (opt-out blocklist)

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-07

Make auto-execute configuration PER-COIN instead of global. Currently configure_auto_execute writes a single GLOBAL system_config (max_sell_pct, require_confidence, allowed_triggers, cooldown_minutes) that applies to every coin NOT in the hodl_symbols blocklist. The configure_auto_execute action already accepts a `symbol` param but it does not appear to scope the settings per-symbol — it overwrites the global config. PROBLEM/FOOTGUN observed today: enabling JTO auto-exec (max_sell_pct 75, trailing_stop, High) changed the setting for ALL non-hodl coins, including NEAR (whose intended cap was 25% per trigger). We worked around it via the hodl blocklist (added CC to protect the anchor), but the model is backwards — opt-out blocklist + global params instead of opt-in per-coin config. REQUESTED: store auto-exec config keyed BY SYMBOL so each selected coin has its own {enabled, max_sell_pct, require_confidence, allowed_triggers, cooldown_minutes}. Keep an optional global default, but per-coin overrides win. Net effect Bryan wants: auto-exec is OFF by default and turned ON for specifically selected coins with their own parameters (e.g. JTO 75%/trailing/High, NEAR 25%/trailing/High), rather than ON-for-all-non-hodl with one shared parameter set. This also removes the need to maintain a long hodl blocklist just to keep the default OFF.

---

## #25 — No delete/void capability for journal rows — orphaned dupes can't be removed (need MCP action + feed Delete button)

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-07 | **Symbol:** NEAR

No way to DELETE or void a journal/activity-feed row currently exists. Confirmed: manage_trading has no delete action (only log_journal/log_intention/etc. which ADD); the activity feed Edit only 'corrects the reason or type', not delete. IMPACT: orphaned rows can't be removed — e.g. the NEAR T1 duplicate where intention id 1805 ($1.80 x 111.11) was orphaned because the fill id 1809 ($1.87 x 106.95) deviated in price and didn't match (the #20 dedup bug). The real position is correct (~107 NEAR, reads exchange balance) but the phantom $1.80 buy double-counts in any journal-based P&L / cycle aggregation (the #19 P&L card). REQUESTED: add a delete (or soft-void/cancel-with-audit) capability — ideally BOTH (a) an MCP action e.g. manage_trading action=void_journal / delete_journal with a row id, and (b) a Delete button in the activity feed. Soft-void (flag excluded + reason) preferred over hard-delete for auditability. INTERIM WORKAROUND in use: edit the orphan's type from buy->transfer/payment so it's excluded from stats. RELATION: complements #20 (auto-merge prevents FUTURE dupes but does not retroactively clean EXISTING orphans like this NEAR row, so a delete/void is still needed). Specific row to clean now: NEAR journal id 1805 ($1.80 intention).

---

## #26 — USDT sweep bugs — wrong base (proceeds vs profit), % mismatch (20% cfg/25% actual), ignored $50 minimum; paused until fixed

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-07 | **Symbol:** JTO

USDT auto-sweep has multiple bugs; Bryan has PAUSED it (enabled=false) until fixed. Observed on the JTO 30% trim (sold 72.73 JTO @ $0.6123 = $44.53 proceeds): (1) WRONG BASE — Bryan's rule is 'sweep 25% of PROFIT', but the sweep computes a % of PROCEEDS. It swept $11.13 (25% of $44.53 proceeds) when 25% of profit (~$8.50 profit on the slice) would be ~$2.13 — ~5x too much, diverting tradeable powder into the payments-only USDT reserve while capital is tight. (2) PERCENTAGE MISMATCH — config returned sweep_pct=20 but the sweep actually took 25% of proceeds ($11.13/$44.53=25%). (3) MINIMUM IGNORED — config min_trade_value_usd=50 but the sweep fired on a $44.53 trade (< $50), so the minimum threshold wasn't enforced. REQUESTED FIXES before re-enable: (a) add a 'profit' basis mode so it can sweep % of realized PROFIT not proceeds (matches Bryan's actual rule); (b) ensure the configured sweep_pct is the value actually applied; (c) enforce min_trade_value_usd. Also confirm the swept USDT is correctly tagged as payments-reserve (not trading) per Bryan's policy. Sweep stays OFF until verified.

---

## #27 — ARCHITECTURE — Revolut X AI Portfolio Manager (living system overview, update as we build)

**Status:** in_progress | **Category:** note | **Source:** developer

**Created:** 2026-06-07

LIVING ARCHITECTURE DOC — last updated 2026-06-07. Update this entry (same dev_log id) whenever a component/tool/table changes. Plain-text by design (dev_log.detail is text). Shareable as-is.

=== ONE-LINE SUMMARY ===
A personal AI crypto portfolio manager: a Node.js server on Railway connects two exchanges + a hardware wallet to an AI assistant via an MCP tool layer, with scheduled monitoring, Telegram alerts/approvals, a trading journal, tax-lot tracking, and gated auto-execution. Operated from phone (Telegram) + web dashboard.

=== TEXT DIAGRAM (data + control flow) ===

                    +---------------------------+
                    |        BRYAN (phone)      |
                    |  Telegram app + Dashboard |
                    +------------+--------------+
                                 | one-tap replies / commands
                                 v
   +-----------------------------------------------------------+
   |              RAILWAY  (Node.js / Express server.js)        |
   |                                                           |
   |  +-----------------+   +-----------------------------+    |
   |  | SCHEDULED JOBS  |   |   CORE: checkPortfolio()    |    |
   |  | every 5 min     |-->|  - fetch balances+tickers   |    |
   |  | midnight prices |   |  - build priceMap           |    |
   |  | 10am outcomes   |   |  - drop/pump/target/trail   |    |
   |  | weekly snapshot |   |  - auto-exec GATES          |    |
   |  +-----------------+   +--------------+--------------+    |
   |                                       |                   |
   |   +-----------------+   +-------------v-------------+     |
   |   |  MCP SERVER     |   |  TELEGRAM BOT             |     |
   |   |  (AI tool layer)|   |  alerts + approvals       |     |
   |   +--------+--------+   +-------------+-------------+     |
   |            |                          |                   |
   +------------|--------------------------|-------------------+
                |                          |
    +-----------v--------+      +----------v-----------+
    |  AI ASSISTANT      |      |  EXTERNAL APIS       |
    |  (Claude via MCP)  |      |  Revolut X (ECDSA)   |
    |  read+analyse+act  |      |  Kraken (HMAC-SHA512)|
    |  through tools     |      |  Tangem XRP (read)   |
    +-----------+--------+      |  Anthropic API       |
                |               +----------+-----------+
                |                          |
                v                          v
       +-------------------------------------------------+
       |          MySQL  (Railway-hosted)                |
       |  trading_journal, tax_lots, uk_s104_pool,       |
       |  entry_prices, price_targets, trailing_stops,   |
       |  auto_trade_rules, trade_intentions,            |
       |  intention_tracking, custom_thresholds,         |
       |  invested_capital, balance_snapshots,           |
       |  system_config, dev_log, session_state,         |
       |  session_history, + ~10 more                    |
       +-------------------------------------------------+

=== LAYERS ===
1. INFRASTRUCTURE: Railway (server + MySQL). Repo github.com/BurhanDawood/revolut-claude. Code changes deployed via a PC agent (Cowork); SQL run via Railway Query tab. Secrets in Railway env vars.
2. INTEGRATIONS: Revolut X API (ECDSA-signed; GET balances/tickers, POST orders, COIN-USD dash format) | Kraken API (HMAC-SHA512; balances + execution) | Tangem (XRP wallet, read-only) | Anthropic API (AI recommendations) | Telegram Bot (alerts + one-tap approvals).
3. MCP TOOL LAYER (the AI's hands — defined, safe actions, not freeform): get_context, get_portfolio_data, get_prices, get_trading_data, get_tranches, manage_alerts, manage_trading (log_journal/log_intention/save_preference/update_capital/configure_sweep/configure_auto_execute/log_dev_issue/update_session_state), set_auto_trade_rule, set_entry_price, execute_kraken_trade (both exchanges), get_auto_rules. [NOTE: live server exposes 13 tools; system_capabilities config still says 11 — open discrepancy, dev_log #2.]
4. MONITORING ENGINE: checkPortfolio() every 5 min — drop/pump alerts, fixed price targets (now with high/low wick-catch accumulator, dev_log #22), trailing stops (high-water-mark), daily thresholds, macro news, auto-rule checks.
5. AUTOMATION + SAFETY GATES (the part that says NO): hodl_symbols (AI advises only, never sells — ~19 coins) -> manual_only_symbols (CC/XRP/NEAR: can sell but only with explicit approval) -> dust guard (never sell value < $1) -> shouldAutoExecute (only High-confidence, allowed triggers, cooldown). Moon-bag rules mark 25% never-auto-sell. USDT sweep optional.
6. RECORD/LEARNING: trading_journal (with reasoning + emotion), intention system (declare-before-trade, auto-matches fills), tax_lots (US HIFO + UK S104 dual-jurisdiction), learning_model (win-rate stats), session_state memory layer (cross-chat continuity, surfaced as working_notes_unverified so live DB always wins).

=== DESIGN PRINCIPLES (the real backbone) ===
- One change at a time; verify before the next.
- Diagnose read-only before editing live code.
- Additive server-side changes preferred over frontend edits.
- Always keep a git revert path.
- Verify tax_lots references before deleting any journal row.
- Guardrails before features: the system should be more careful than the trader on a bad day.
- Narrative is never truth — always re-check live DB (session_state is labelled 'unverified' for this reason).

=== ROADMAP ===
DONE: Kraken exec, Tangem integration, SOL automation w/ cascading rules, trade-intention system, Revolut X execution, US HIFO + UK S104 tax tracking, session_state memory, get_prices fix, USDT cash visibility, manual-only gating, dust guard, wick-catch targets.
PENDING/OPEN: native mobile app, rebalancing automation, auto-compound profits; open bugs #5 (dedup fail-open), #8 (cross-cycle P&L), #11 (Telegram parsing), #19 (lifetime P&L card), #20B/#21 (dedup + stale-trailing-stop cleanup).

---

## #28 — Auto-detect misses card payments — no payment-type entries ever logged (USDT card spends not captured)

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-07

CLARIFIED 2026-06-07 by Bryan — supersedes the 'regression' framing. The detailed May activity-feed payment entries (Fireaway/Anthropic/Morrisons breakdown etc.) were almost certainly written by the PM (Portfolio Manager) AI thread manually composing a payment journal row, NOT the server's auto-detect writing them automatically. So this is NOT a code regression — the server-side auto-detect likely NEVER auto-wrote payment-type rows; the nice historical entries were AI-authored. Reframes the ask from 'restore lost code' to 'ADD the auto-log behaviour'.

DESIRED RULE (Bryan, exact): when USDT DECREASES with NO corresponding USD rise (and no corresponding crypto-position rise), AUTO-LOG it as a payment-type journal entry. Three-case classification (the server already computes isUSDConversion + isCryptoPurchase): (1) USDT down + USD up ~same => conversion => transfer, capital unchanged (already works); (2) USDT down + a crypto up ~same => buy (already works); (3) USDT down + NEITHER => PAYMENT => log_journal action=payment, excluded from stats, capital adjusted. The payment branch ALREADY fires the Telegram alert + adjusts capital — the only missing step is the journal INSERT in that branch. FIX = in the fall-through payment branch of the USDT-decrease handler, add an automatic payment-type journal INSERT (symbol USDT, action=payment, value=decrease, excluded from trading stats), so the feed self-populates without the PM thread.

STILL SEPARATELY NEEDED: net-change masking (PROBLEM 1) — if a payment and a conversion/sell land in the SAME 5-min poll, net USDT change can look flat/positive so the 'USDT down' trigger never fires and the auto-log rule won't catch it. That case needs per-transaction reconciliation from the exchange activity feed, not net-balance diffing. So: simple auto-log rule fixes the common isolated-payment case; per-transaction reconciliation is the more complete (later) fix for masked cases.

NON-URGENT: capital is still adjusted on detected payments, so the capital figure stays ~right; the gap is the missing feed/journal record for recent card spends. Diagnose-then-fix next session: read the USDT-decrease payment branch, add the auto journal INSERT (low risk, additive), then consider per-transaction reconciliation for the masking case. Optional backfill: today's $63.45 + $21.60 as journal-only rows (capital already adjusted — do NOT re-adjust).

---

## #29 — HYPE stuck in permanently_ignored; no MCP un-ignore action; ignored-status may silently mute explicit price targets

**Status:** in_progress | **Category:** bug | **Source:** developer

**Created:** 2026-06-07 | **Symbol:** HYPE

CORE RESOLVED 2026-06-07 — un-ignore action added and verified live. FIX: added 'unignore' to the manage_alerts z.enum + a branch calling the EXISTING resumeAlerts() function (lines 2218-2227, which removes the coin from both the in-memory ignoredCoins Set AND the ignored_coins DB table AND alertState.acknowledged). No new function, no migration — 3 surgical additive lines. Clean Railway boot confirmed ([ignore] loaded 8 coins, HYPE no longer among them). VERIFIED end-to-end via MCP: called manage_alerts action=unignore symbol=HYPE-USD -> HYPE removed from permanently_ignored AND from acknowledged (the latter clears a stray session-mute too), AND its fixed_price_target (down $52.003, anchor 57.46) remains armed (priceTargets Map untouched by ignore/unignore). So HYPE reload alert is LIVE again; combined with #22 wick-catch it will fire even on a brief wick to $52. DIAGNOSTIC ANSWER (from the read): being ignored DOES suppress explicit price targets — !ignoredCoins.has(symbol) is a required condition on both UP (line 6174) and DOWN (line 6287) target branches in checkPortfolio. resumeAlerts re-arms cleanly because priceTargets is separate from the ignore list.

REMAINING (separate, lower priority now that un-ignore exists): (a) DECISION — should an explicit fixed_price_target fire EVEN WHILE a coin is ignored? Currently no. With a working unignore + the guidance 'don't ignore coins you're watching; unignore to re-arm', this is now optional polish rather than necessary. (b) FEATURE — multiple fixed targets per coin (ladder, e.g. $52 AND $49); set_target currently holds ONE target per coin per direction (second overwrites first). Separate feature, deferred. (c) Add a Telegram command + app toggle for unignore (MCP action now exists; surface it in the other interfaces). (d) Prefer 'acknowledge'(temp) over 'ignore'(permanent) when dismissing watchlist coins.

NOTE on junk symbols (RETRACE-USD, STOP-USD, AT-USD, ING-USD, HONEY-USD) and the broken INJ target (167% / target $13.65 = old entry) still present in daily_thresholds/fixed_price_targets — these are #11 (Telegram parsing) artifacts, to be cleaned with that fix.

---

## #30 — Orphaned/junk daily-threshold & target rows need cleanup + verify Kraken/Tangem threshold monitoring

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-07 | **Resolved:** 2026-06-08

PHASE 2 DONE + VERIFIED LIVE 2026-06-08. Added manage_alerts actions 'remove_target' and 'remove_threshold'. removeFixedTarget(symbol) (new fn line 2302) clears priceTargets + targetReminderCount + targetExtremes + alertFirstSent + alertReminderSent + activeFixedAlerts (clearInterval) then DELETE FROM price_targets — mirrors auto-dismiss teardown. removeThreshold(symbol) (new fn line 2315) does delete customThresholds[symbol] (plain object) + DELETE FROM custom_thresholds (the path that was commented-out-but-missing at line 326 since table creation). z.enum + 2 dispatch branches added. Pushed clean fast-forward (git verified local==origin at a5b584a2 before push, A1/A2/unignore already live, no overwrite), clean Railway boot (Loaded 22 price targets / 25 custom thresholds — down from pre-cleanup, confirming Phase 1 SQL deletes also held). VERIFIED END-TO-END via MCP: remove_threshold DASH-USD -> ok (removed 100% threshold on an ignored coin); remove_target BCH-USD -> ok (removed a 0.01% junk target on a non-held coin). System now has full ADD+REMOVE capability for alerts via MCP — no Query-tab SQL needed for routine cleanup. This also satisfies part of #25's intent for alerts (journal void/delete still separate). NOTE for #38: once targets become multi-per-coin, remove_target currently removes ALL of a coin's targets (remove-by-symbol) — will need a target-id param to remove a SPECIFIC rung. Build-now-as-symbol, extend-to-id-after-#38, as planned.

---

## #31 — Swing-detect fires BUY-THE-DIP on exit-only bags — need per-coin pump/exit-only alert mode

**Status:** in_progress | **Category:** feature | **Source:** developer

**Created:** 2026-06-07

A1 + A2 BOTH DEPLOYED 2026-06-08 — anchors/hodl/manual coins now protected from buy-the-dip on BOTH alert paths. A1 (done): role injected into getQuickAiRecommendation + batchGetRecommendations (daily-threshold path) — hodl/manual coins framed HOLD-only. A2 (done this session): swing-detect EXTREME DIP template (lines ~6535-6608) now calls await getCoinContext(coinBase) once inside the isExtremeDip block; for role hodl/manual_only it replaces 'Strong buy signal' with a HOLD/EXIT-framed message ('hold/exit bag — watch for strength to trim, not a dip to add'); role 'normal' keeps the original buy template verbatim. EXTREME PUMP branch + all trigger thresholds byte-for-byte unchanged. Clean Railway boot confirmed both deploys; swing path content proof pending next EXTREME DIP on a hodl/manual coin (market mostly green today so few dip alerts firing).

REMAINING #31 WORK (the dedicated exit-mode list — NOT yet built): A1+A2 infer suppression from hodl/manual_only role. But pure dead-bags Bryan only wants to EXIT (ADA, PYTH, SEI, FET, FLR, ILV, MOG, BONK, HFT, SUPER, POL, CRO, HBAR, BOBA + Kraken XPL/ZK) are NOT all in hodl/manual_only, so they still hit the 'normal' branch and would still get buy-the-dip signals on BOTH paths. To fully close #31 need an explicit per-coin alert MODE (e.g. an 'exit_only' / 'pump_only' list in config, or a new column) that getCoinContext also checks and returns as role='exit', which both the quick-rec generators (A1 code) and the swing template (A2 code) then treat like hodl (no buy). DESIGN DECISION NEEDED before building: where the exit-list lives (system_config key like ai_auto_execute, or trader_profile pref) + the initial coin list. This is the remaining piece — pairs with A3 plan-awareness. Mark #31 in_progress until the exit-mode list ships.

---

## #32 — Sleep / Do-Not-Disturb mode — urgent-only alert filter + morning digest

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-07

Bryan wants a notification-suppression mode for overnight/away periods so he isn't woken by non-actionable alert spam (his trades are manual/Telegram-approved, so most overnight pings can't be actioned anyway and just disrupt sleep). TWO MODES, same core behaviour: (1) SLEEP MODE — schedule-based (configurable overnight hours, or 'sleep on'/'sleep off' Telegram toggle); (2) DO NOT DISTURB — manual on/off toggle. When EITHER active, Telegram suppresses non-urgent notifications and only pushes URGENT ones. URGENT (allow through): (a) any auto-rule/auto-exec that ACTUALLY EXECUTED a trade (he must know something traded); (b) hard stop-loss / trailing-stop triggers; (c) BTC macro tripwires — capitulation break <$59.5K and risk-on reclaim >$68.5K (configurable key levels); (d) optional per-coin 'urgent' level. SUPPRESS/BATCH (hold for digest): swing-detect 'EXTREME DIP/buy the dip' signals, routine fixed-target dip pings, daily-threshold pings, and especially REMINDER REPEATS (e.g. FLOKI 'still active' 1/2 2/2 nags — collapse to one). MORNING DIGEST: when the mode lifts (or on first message of the day), send ONE consolidated summary of everything that fired overnight (which alerts, prices, any auto-exec) instead of a backlog of individual pings. Pairs with dev #31 (pump/exit-only mode) and #30 (alert cleanup). The reminder-repeat spam is the worst offender — consider global nag-suppression too.

---

## #33 — Emergency liquidation mode (capital protection) with safety rails

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-08

A deliberate fast 'pull to safety' mechanism for a genuine systemic crisis (Strait of Hormuz closure / war shock / cascade) — prompted by the June 8 2026 Iran-Israel escalation discussion. MUST have heavy safety rails because panic-liquidating a -68% book at the lows is the exact mistake to avoid (June dump netted only ~+$371 vs holding but cost ~$191 in re-entry whipsaw; Bryan's SELL win-rate 47% / BUY 33% — re-entry timing is his weakness).
SCOPE TIERS (never one-button 'everything' by default): (A) DE-RISK = sell liquid high-beta SWINGS + winners to stables, KEEP the dead bags (already -50/-90%, nothing left to protect) and cold storage; (B) FULL = everything except Tangem cold storage + 25% moon bags. User picks tier each time.
SAFETY RAILS: (1) Multi-step explicit confirmation — type a confirmation phrase + Telegram approval, NOT one-tap; arm-then-fire cooldown. (2) Pre-execution IMPACT PREVIEW: show the realized loss it will CRYSTALLIZE and cash-out value per coin before confirm. (3) SANITY CIRCUIT-BREAKER: if fired while BTC is NOT in a confirmed breakdown (above the $59.5K/$60K radar levels), warn 'this contradicts your buy-dips plan — BTC at $X, not capitulating. Confirm panic override?'. (4) Exclude Tangem XRP + moon bags by default. (5) Laddered/staggered execution option to limit slippage on illiquid bags. (6) Proceeds -> USDT (stables) for fast redeploy. (7) Full journal logging tagged 'emergency_liquidation' + reason. (8) Optional short undo window.
INTEGRATION: arm via toggle; ideally the system only RECOMMENDS it when a real breakdown confirms (radar $59.5K break / Hormuz-type headline), not on a whim. Pairs with the BTC macro radar.

---

## #34 — Autonomous bull-run / extreme-pump capture mode (sell-only, railed)

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-08

For sudden parabolic pumps too fast to manage via Telegram approval — temporarily shift trim execution to AUTONOMOUS so profit gets captured into vertical moves Bryan can't react to in time. The opposite emergency to dev #33 (crash shield).
TRIGGER: (a) 'pump regime' detector — a coin or BTC pumps >X% in Y minutes/hours (configurable thresholds), OR (b) manual 'BULL MODE ON' toggle when Bryan sees a parabola starting. TIME-BOXED: auto-reverts to manual after N hours or when the pump regime ends.
BEHAVIOUR: autonomously executes Bryan's PRE-DEFINED trim ladders (levels he already set — e.g. JTO $0.70, TON $2.28/$2.89, CC $0.17+ rungs) WITHOUT per-trade approval. It must NOT improvise new levels.
SAFETY RAILS: (1) SELL-ONLY — never autonomous BUYS in pump mode (buying a parabola = chasing, Bryan's documented weakness; meme 0% / BUY 33% win-rate). (2) Always preserve the 25% moon bag; per-coin max autonomous sell cap (<=50-75%). (3) SEMI-autonomous notify+undo: 'auto-trimming 25% JTO @ $0.70 in 30s — reply STOP to cancel' rather than silent execution. (4) Respect manual_only_symbols (CC/XRP) unless explicitly opted in per-coin. (5) Global max autonomous sell VALUE per session cap. (6) Cooldown between fires. (7) Full journal logging tagged 'auto_pump_trim'. (8) USDT sweep option on proceeds.
INTEGRATION: extends the existing ai_auto_execute config (currently allowed_triggers=['trailing_stop'] only) — add a 'pump_alert'/'parabolic' trigger with a dedicated railed profile, toggled ON only during bull regimes (OFF by default). Complements the swing-detect pump alerts already firing.

---

## #35 — Recommendation engine mislabeled CC as 'CyberConnect' — wrong-project fundamentals in buy/sell recs (ticker collision)

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-08 | **Resolved:** 2026-06-08

RESOLVED 2026-06-08 via A1 build (see plan #37). ROOT CAUSE confirmed in read: getQuickAiRecommendation + batchGetRecommendations sent only ticker+%move+price to the model — no project name — so the model guessed CC=CyberConnect from its own prior. The COIN_NARRATIVES map (lines 49-58) already had correct CC='Canton Network, institutional blockchain, DTCC, tokenization, RWA' but was only used in the macro-news builder, never passed to the rec generators. FIX: added getCoinContext(coinBase) helper (lines 61-77, mirrors the live DB read of ai_auto_execute from line 4817 — no cache exists; returns {narrative, role}). getQuickAiRecommendation (rewritten ~1991-2032) now builds projectLabel = 'CC-USD (Canton Network, ...)' when known, or 'XX-USD (project unknown — do not guess the project; price-action-only view)' otherwise. batchGetRecommendations (rewritten ~2034-2083) includes project name per line + a system-prompt rule 'Never invent project fundamentals; if a project name is given use it, otherwise comment on price action only' (one DB read per batch, not N). This closes the WHOLE class of wrong-project bugs (any ticker collision), not just CC — unknown coins now get an explicit do-not-guess instruction. Deployed, clean Railway boot confirmed, single-alert Claude call fired cleanly post-deploy. SCOPE: A1 touched only the two quick-rec generators (daily-threshold path) + the new helper; did NOT touch swing-detect template (A2) or handleFixedTargetAnalysis/handleTrailingStopAlert (A3). LIVE PROOF PENDING: next daily-threshold alert on CC should read 'Canton Network ... HOLD' not 'CyberConnect ... buy'.

---

## #36 — Alerts/recommendations must be PLAN-AWARE — check saved plan first, then recommend accordingly

**Status:** ✅ resolved | **Category:** feature | **Source:** developer

**Created:** 2026-06-08 | **Resolved:** 2026-06-12

✅ CLOSED 2026-06-12 (status corrected — was functionally resolved by #57 S3, status lagged). Plan-aware recommendation engine shipped + verified live: both rec generators (single + batch paths) load coin_strategy and frame recs against the saved plan as PRIMARY consideration; respects role (anchor/hodl/watch/manual_only); no plan-blind BUY-THE-DIP on anchors or dead-bags; hallucination guardrail strengthened (no invented product names). AERO canary 2026-06-11 proved it: rec said HOLD against an up-target, named the plan's add zones, respected building-phase role, invented nothing. #56 and #35 also closed by this work.

---

## #37 — BUILD PLAN — bundling &amp; sequencing of open dev items (living plan)

**Status:** in_progress | **Category:** note | **Source:** developer

**Created:** 2026-06-08

BUILD PLAN — living doc, updated 2026-06-08 after the Group A read-only diagnosis. Governing rule: BUNDLE changes that touch the SAME function or SAME read; NEVER bundle across the trade-execution boundary. Each group = one coordinated session, read-only diagnosis first.

=== GROUP A — RECOMMENDATION QUALITY (#35 + #31 + #36) — IN PROGRESS ===
READ DONE 2026-06-08. KEY FINDING: there is NO single shared rec generator — THREE separate paths, so Group A is NOT one bundle. It splits into A1/A2/A3, sequenced (one ship each, verify between). Unifying root cause confirmed: rec generators don't load context (project name / role / saved plan) before generating.

THREE PATHS (from read):
- Daily threshold (pump/drop): getQuickAiRecommendation (single, lines 1973-1996) / batchGetRecommendations (>=2 coins, 1999-2030). Gets ONLY ticker + %move + price. No entry, no role, no plan, no project name -> model guesses project (this is the #35 CC->CyberConnect bug).
- Fixed-price target: handleFixedTargetAnalysis (~4961-5013) — fuller: journal + entry + 5 hardcoded pref keys (trading_strategy, core_principles, mss_definition, moon_bag_rule, risk_tolerance). Does NOT read coin-specific plans.
- 7-day swing / EXTREME DIP (lines 6535-6608): NO Claude call — hardcoded template string ('Strong buy signal based on your swing strategy'). Always says buy.
COIN_NARRATIVES map (lines 49-58) ALREADY has correct CC='Canton Network...' but is only used in the macro-news builder (line 2945) — NOT passed to the rec generators. So #35 fix data already exists, just not wired in.
Preferences: flat trader_profile key/value table. Only the 5 hardcoded keys are ever read into prompts; coin-specific plans (xlm_reentry_ladder etc.) are stored but NEVER read by the rec engine. hodl/manual_only flags read only DOWNSTREAM (trailing-stop path, to gate execution) — rec text has zero role-awareness.

SPLIT INTO 3 SEQUENCED SUB-BUILDS:
- A1 (DO FIRST — highest value, lowest risk): inject COIN_NARRATIVES[coinBase] (project name) + coin ROLE (hodl/manual_only/normal) into getQuickAiRecommendation + batchGetRecommendations, and adjust the prompt so hodl/manual/exit coins are framed 'HOLD/EXIT — do not recommend buying; hold or trim-into-strength', never buy-the-dip. Fixes #35 (wrong project) + the worst half of #31 (buy-the-dip on anchors) in the most-fired path. Small, additive, one function pair.
- A2: make the swing-detect EXTREME DIP template (lines 6535-6608) role-aware — for exit-only/hodl coins, replace 'Strong buy signal' with 'pump/exit watch — hold-to-sell-on-strength'. No API call, conditional template text. Contained.
- A3 (biggest — #36 proper): widen the preference read beyond the 5 hardcoded keys to also pull a coin-specific plan (needs a key convention, e.g. {coinBase}_plan or a lookup list) and inject into handleFixedTargetAnalysis so recs quote actual MSS/ladder levels. Needs a plan-key convention decided first. Own careful step.
SEQUENCE: A1 -> verify -> A2 -> verify -> A3. Do NOT bundle the three (would edit three live alert paths in one push).

=== GROUP B — REMOVAL ACTIONS + CLEANUP (#30 + #29-remainder, then #25 careful follow-on) ===
'System can ADD but not REMOVE.' New manage_alerts remove_target/delete_threshold (clears junk RETRACE/STOP/AT/ING-USD, HONEY dust, stale ZKJ + FLOKI nag). #29 remainder: unignore Telegram cmd/app toggle; optional explicit-target-overrides-ignore; laddered targets. #25 journal void/delete (soft-void, audit) — DATA INTEGRITY, careful follow-on AFTER alert-removal, not blindly bundled. Also verify Kraken/Tangem price feeds poll for off-Revolut thresholds (XPL/ZK/XRP).

=== GROUP C — DEDUP / DATA-INTEGRITY FAMILY (#5 + #20; NOT with anything else) ===
LIVE trade-logging. #5 diagnosed (fail-open dedup). #20 = intention/fill match must tolerate price+qty deviation, enrich not duplicate. Bundle the two (same root). Bryan decides tradeoff: fail-safe vs retry-then-insert. #21 (clear stale trailing stop on full exit) related — ride with C or own small fix.

=== GROUP D — NOTIFICATION UX (standalone: #32) ===
Sleep/DND + morning digest + nag-suppression. Telegram-send filtering only. Safe standalone. High QoL.

=== GROUP E — AUTO-EXECUTION (each ALONE, never bundled) ===
#24 per-coin auto-exec config (footgun remover). #33 emergency liquidation (railed). #34 autonomous pump-capture (sell-only, railed). Highest stakes — one careful session each.

=== GROUP F — INDEPENDENT FEATURES (low-risk, any order) ===
#17 USDT cash in get_portfolio_data | #8 XLM cross-cycle P&L (tax) | #19 lifetime P&L card | #14 XRP multi-location | #23 scorecards | #15 rotation tracker (NEUTRAL not debt) | #2 tool count | #1 created_at columns.

=== RECOMMENDED SEQUENCE ===
1. GROUP A as A1 -> A2 -> A3 (start A1 — kills #35 wrong-project danger + buy-the-dip-on-anchor noise in one small change).
2. GROUP B (removal/cleanup quick wins).
3. GROUP C (dedup keystone, isolated).
4. Then D (#32) / E (#24) / F (#8, #17) by appetite.
NET: A=3 small ships, B=~2, C=1; auto-exec items stay individual.

---

## #38 — CRITICAL: only one fixed price target stored per coin — laddered alerts + BTC radar silently collapsed

**Status:** in_progress | **Category:** bug | **Source:** developer

**Created:** 2026-06-08

B3 RESOLVED — discovered already built + PROVEN LIVE 2026-06-10. IMPORTANT NARRATIVE-VS-CODE CORRECTION: the dev_log listed B3 as pending, but reading the current deployed server.js (via Drive synced copy, verified current — has the #1+#2 sent_at fix at L943 + total_mcp_tools:13) shows ALL THREE B3 pieces are ALREADY fully implemented and clean:\n(1) removeFixedTarget(symbol, targetPrice=null) L2371 — if targetPrice given, finds the matching rung, filters it from the array, DELETEs by id (fallback delete-by-price if no id), and cleans up per-symbol state (reminder counts/intervals) only when it's the LAST rung; omit targetPrice = original whole-symbol delete (backward compatible). Handles the undefined-id edge.\n(2) cancelObsoleteTargets L4457 — fully ARRAY-AWARE now (the dev_log's 'reads .targetPrice=undefined, never cancels' was the OLD pre-array version): iterates the array, filters obsolete rungs by direction+executedPrice, deletes each by id, keeps the rest, sends per-cancellation Telegram.\n(3) manage_alerts remove_target L8013 + target_price param L7953 ('remove only the rung at this exact target price; omit to remove ALL') — passes target_price through to removeFixedTarget, returns correct single-rung vs whole-symbol message.\n\nLIVE PROOF (SQL console was unavailable — Railway 'mintDevToken only in dev/staging' SSH error — so proven via MCP layer instead): set 2 TESTCOIN-USD rungs ($110,$125). remove_target target_price=110 -> 'Removed TESTCOIN target at 110' AND TESTCOIN STILL PRESENT in get_trading_data alerts (the $125 rung survived = surgical, not whole-symbol). Then remove_target target_price=125 -> 'Removed TESTCOIN target at 125' AND TESTCOIN now ABSENT. Chain proves each removal took exactly ONE rung. If it were whole-symbol delete, step 1 would have wiped TESTCOIN entirely. 20 real target-symbols all intact throughout.\n\nLIKELY EXPLANATION: B3 was built in a prior session whose work got committed under the reused/stale 'B3' commit message (same message that mislabeled last night's #1+#2 commits d3ff885/f9a9cc2). So the 'B3' label on those commits may have originally been accurate for an earlier B3 commit; the dev_log just never got marked resolved. Lesson reinforced: live code is ground truth; dev_log narrative drifted. #38 Part 1 (multi-target) + B3 (per-rung removal) BOTH now done + verified. Remaining: B4 cleanup (get_portfolio_data fixed_target array shape, alerts MCP surface should show per-target detail not just symbol, swing hold-guard cosmetic) — all misread-not-crash, non-blocking.

---

## #39 — Deep project researcher — web-research layer that builds/maintains fundamentals knowledge per watched coin, to inform PM strategy

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-08

BILLING REALITY CLARIFIED 2026-06-08 (verified against current Anthropic docs/pricing). Bryan asked if his Claude Max 5x plan already covers what the researcher needs — it does NOT, and this corrects the framing of the web-capability decision.

KEY FACT: Claude Max 5x is an INTERACTIVE-USE bucket only (claude.ai web/mobile/Projects + Claude Code terminal + Cowork). It does NOT include programmatic API access — there is no plan that bundles unlimited claude.ai use with API access; they are separate products with separate billing. The researcher runs INSIDE server.js making programmatic API calls, so it is pay-as-you-go API usage, NOT covered by Max. (Same interactive-vs-programmatic split that caused the earlier '1M context credits' error.)

WHAT BRYAN ALREADY HAS: server.js already holds a working ANTHROPIC_API_KEY in Railway env vars (boot log shows '[startup] ANTHROPIC_API_KEY present ✅') — this already powers the alert recommendation calls and is billed pay-as-you-go, SEPARATE from Max. So the synthesis-LLM side of the researcher can reuse this existing key/bill; no new vendor needed for that half.

IMPLICATION FOR WEB-CAPABILITY DECISION (revised): two candidates to COMPARE at build time —
1. ANTHROPIC WEB-SEARCH TOOL (likely better-suited, Bryan's lean): uses the API key the server ALREADY has — no second vendor, no new key, no new integration. NOTE from pricing page: web search has its OWN per-request fee ON TOP of input/output tokens ('does not include the tokens required to process requests'). Cleanest path — one vendor, one bill, one key already present.
2. PERPLEXITY SONAR API: Bryan has Perplexity PRO membership, but Pro (consumer chat) is SEPARATE from the Sonar developer API — API needs its own key + likely separate pay-as-you-go billing; Pro may include some monthly API credit but does NOT equal API access. Strength: Sonar is purpose-built for cited live web research (good for guardrail #2 source-URL+date requirement). Weakness: new vendor + new key + new bill + must confirm membership-vs-API billing.
DECISION LEANING: Anthropic web-search likely better suited (reuses existing key/integration, single vendor), but COMPARE both on cost-per-research-call + citation quality before committing. Confirm: does Anthropic web-search return source URLs usable for the dated-source guardrail? (Perplexity's citation output is its main edge.)

ALSO NOTE (timing, not blocking #39): Anthropic billing change 15 June 2026 — headless/Agent-SDK/'claude -p'/CI usage moves to a separate monthly credit ($100 for Max 5x) at API rates; INTERACTIVE Cowork + terminal Claude Code UNAFFECTED. Bryan's normal Cowork dev workflow keeps running off Max. This is about agent/headless automation, not server.js's own ANTHROPIC_API_KEY calls (those were always separate pay-as-you-go).

FEASIBILITY READ (still the first build step when #39 is picked up) now starts from: (a) does server.js already have a web-fetch/HTTP capability to call a search API (it makes outbound HTTPS to exchanges, so yes for raw fetch); (b) compare Anthropic web-search vs Perplexity Sonar on cost + citation quality; (c) confirm cost-per-research-call is acceptable given it is pay-as-you-go on top of the existing Anthropic API spend.

---

## #40 — Catalyst-intelligence / research pre-loading — proactive per-coin catalyst awareness, ready to act

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-08

WHY THIS MATTERS (motivating case today): Bryan asked about ENA's impending catalyst (Coinbase x Ethena USDe/sUSDe savings launch, target June 9-10). Claude had to cold-web-search it in the moment to dig into the details. It worked, but the system should have ALREADY KNOWN — the catalyst, its date, its priced-in/sell-the-news status, the supply overhang (June 5 unlock), and the pre-positioned plan — so analysis is instant and ACTION-READY rather than a scramble. When a catalyst is days away, being well-informed and ready is the difference between a disciplined pre-planned entry and a rushed FOMO decision.

REQUESTED FEATURE (builds on the research capability dev is already aware of): a proactive CATALYST-INTELLIGENCE / RESEARCH layer.
(1) CATALYST CALENDAR per held + watchlist coin: maintain known upcoming catalysts with date, type, expected direction/impact, and priced-in risk. Seed examples: ENA = USDe/Coinbase launch Jun 9-10 (sell-the-news risk, fee-switch pending, unlock overhang); CC/Canton = DTCC Jul/Oct; NEAR = v2.13 resharding (Jun) + Grayscale ETF ruling (Sep); TON = Telegram Stars / TON Pay Q3; LINK = DTCC Collateral AppChain Q4; HYPE = token unlocks + HYPG ETF.
(2) PROACTIVE REFRESH: periodically web-research each tracked coin's catalyst status so data is fresh and pre-loaded, not fetched cold at query time.
(3) CATALYST-AWARE OUTPUT: when an alert fires or Bryan asks about a coin, automatically surface the relevant catalyst + days-until + expected impact + sell-the-news/risk notes + the pre-set plan. Ties directly into #36 (plan-aware alerts) — recommendations should factor known catalysts.
(4) MORNING BRIEFING INTEGRATION: flag any held coin with a catalyst within ~7 days, with its readiness plan (e.g. 'ENA catalyst tomorrow — $0.085 add limit live, existing stack rides it, sell-the-news risk noted').
GOAL: when Bryan asks about a project with an impending catalyst, we are already well-informed and ready to act. Pairs with #36 (plan-aware) and #38 (multi-target, so catalyst-driven ladders can actually persist).

---

## #41 — Duplicate journal row — intention (claude_mcp) not merging with auto_detected fill (ENA $75 logged twice)

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-09

The ENA $75 @ $0.085 limit fill (June 9) is logged TWICE in the journal: id 1827 (source claude_mcp, from log_intention, full reasoning) + id 1828 (source auto_detected, 'no reason provided'). The intention was supposed to MATCH/merge with the auto-detected fill into ONE enriched row (per the dedup design) — instead a separate auto_detected duplicate was created. Same single 882.35 ENA / $75 buy, double-logged. NOTE: get_tranches shows the CORRECT position (two real lots: 2,660.85 @ $0.0917 + 882.35 @ $0.085 = 3,543.2 ENA), so the duplicate is journal-only and does NOT corrupt tranche/position accounting — but anything that sums journal 'buy' rows for ENA would double-count this $75. FIX: when an auto_detected fill matches an open claude_mcp intention (same symbol/side/price/qty within window), enrich the existing intention row instead of inserting a new auto_detected row; OR de-dupe on insert. MCP has no delete_journal, so existing dup (1828) can't be removed from here — needs manual/dev cleanup. Relates to the pre-journal duplicate-check rule.

---

## #42 — Dev bridge — review-gated message bus between Claude (dev thread) and Cowork via MCP/DB, with Bryan approval on every prompt

**Status:** ✅ resolved | **Category:** feature | **Source:** developer

**Created:** 2026-06-09 | **Resolved:** 2026-06-09

RESOLVED + ROUND-TRIP PROVEN 2026-06-09. The dev bridge v1 works END TO END: Cowork POSTed to /api/bridge (HTTP, x-bridge-token auth) -> row landed in dev_bridge -> Claude read it via get_trading_data include=['dev_bridge']. Confirmed live read: row id 1, type 'test', payload 'bridge round-trip test 2', ref_devlog_id 42. The earlier 'schema not surfacing' reads were stale client-cache lag that has now cleared — Claude's get_trading_data schema correctly shows the dev_bridge enum value + bridge_id/include_consumed/mark_consumed/ref_devlog_id params, and all 13 tools are visible.\n\nROOT CAUSE of the #2 confusion (Cowork diagnosis): there was NO real exposure cap. All 13 server.tool() registrations were correct and the MCP protocol was exposing all 13 the whole time (get_prices, get_portfolio_data, get_trading_data, manage_alerts, manage_trading, get_portfolio_summary, set_entry_price, set_auto_trade_rule, get_context, manage_auto_rules, execute_kraken_trade, get_tranches + get_auto_rules). The '11' was a STALE HARDCODED system_capabilities blob seeded into system_config on startup (~line 1239: total_mcp_tools:11 + a tools[] array missing manage_auto_rules, get_tranches, dev_bridge) which get_context serves to Claude (~line 8565). So Claude READ the stale self-description and mis-believed there were 11 tools — cosmetic metadata drift, not a real cap. The get_tranches/manage_auto_rules 'extra' in #2's title was the live truth; the config was the stale side.\n\nDESIGN NOTE (good): the dev_bridge branch is correctly gated on fetch.includes('dev_bridge') ONLY (never fetchAll), so routine get_trading_data / get_context calls do NOT pull or consume bridge rows — confirmed by the schema description 'dev_bridge is never included in all; request it explicitly'. v1 carries Cowork->Claude reads; Claude->Cowork prompts still relayed by Bryan (approval checkpoint preserved). REMAINING HOUSEKEEPING (small, non-blocking): (1) rotate BRIDGE_TOKEN (was pasted during testing); (2) mark row 1 consumed or leave as harmless test row; (3) for true production use, have Cowork POST real file-reads/read-backs with type='readback' + ref_devlog_id. This closes #42 v1.

---

## #43 — No auth on any /api/* route — all endpoints public, including trade-execution; add token middleware

**Status:** 🔵 open | **Category:** security | **Source:** developer

**Created:** 2026-06-09

RESOLVED 2026-06-10 night — deployed + VERIFIED LIVE. API_TOKEN env var created by Bryan in Railway (value never shared into chat/Cowork — lesson applied). Middleware inserted after express.json() (~L7031), read-back verified placement + content, node --check clean, pushed, clean boot.\n\nLIVE VERIFICATION (same-origin DevTools console tests from the dashboard, Bryan-executed):\n(1) POST /api/revolut/trade with no token -> 401 Unauthorized — rejected BEFORE the trade handler (pre-fix this returned 400 'requires approved:true', i.e. it REACHED the handler). Door confirmed shut on the critical endpoint.\n(2) POST /api/pause (exempt) -> 200 — dashboard controls unaffected; monitoring resumed after test.\nDashboard loads normally; MCP (/mcp) + Telegram webhook untouched (different path prefix), both confirmed alive on boot.\n\nNOW PROTECTED (all POST/PUT/DELETE/PATCH under /api/* behind x-api-token, fail-closed): /api/revolut/trade, /api/kraken/trade, auto-rules CRUD, /api/system/config, /api/capital, /api/tax/backfill, fix/cleanup endpoints, targets/thresholds/trailing-stops writes, journal writes, etc. EXEMPT (by design): /api/pause, /api/resume, /api/sweep/config (the dashboard's only 3 working POSTs), /api/bridge (own BRIDGE_TOKEN). GETs remain open (dashboard reads) — locking reads = optional phase 2 (e.g. HTTP Basic Auth on the whole site incl. dashboard).\n\nRESIDUAL/FOLLOW-ON (tracked, not blockers): (a) GET endpoints still expose portfolio/journal/tax data publicly on an obscure URL — phase-2 decision; (b) /api/pause+/resume open = minor unauthenticated pause risk, accepted for dashboard usability; (c) CORS still * — deliberately deferred, token blocks regardless; (d) /mcp endpoint itself is unauthenticated — its trade tool (execute_kraken_trade) IS Telegram-gated, but consider connector auth later; (e) BRIDGE_TOKEN rotation still pending from #42; (f) commit-message mislabel if PUSH_NOW.bat wasn't updated this push. Discovered during this work and tracked separately: #58 (startup patch force-enables auto-exec every boot — found in tonight's boot log, next small fix).

---

## #44 — Telegram approval only registers the LAST pending trade when multiple are sent — can't approve a batch/ladder

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-09 | **Symbol:** CC

CONFIRMED by Bryan 2026-06-09. When multiple execute_kraken_trade approval requests are sent close together (e.g. a 3-rung CC trim-sell ladder: 1500 CC @ $0.170, $0.178, $0.186), Telegram sends 3 separate 'APPROVAL NEEDED' messages — but the bot's approve handler only tracks/recognises the MOST RECENT pending trade. Bryan's 👍 / 'approve trade' only executes the last message ($0.186 filled); the earlier two ($0.170, $0.178) are NOT executed and the approval is ignored ('No pending trade to approve' after the one). Each new approval request overwrites the previous pending-trade pointer instead of maintaining a QUEUE.

IMPACT: Bryan cannot place laddered orders (multiple rungs) via MCP in one go — a core need for his ladder-in/ladder-out strategy. He's forced to do them one-at-a-time manually, and even then sequential MCP sends clobber each other.

FIX OPTIONS: (1) maintain a QUEUE of pending approvals, each addressable — reply could reference which (e.g. 'approve 1', 'approve all', or inline buttons per-message that carry a unique trade_id). (2) Telegram inline keyboard buttons with callback_data carrying the specific trade UUID so each message's 👍 maps to ITS trade, not a shared 'last pending' variable. (3) support a single batched approval message listing all rungs with one 'approve all'. Option 2 (per-trade callback_data) is cleanest and also fixes any race. RELATES TO: this is why the CC ladder only partially placed; pairs with the need for multi-rung support generally.

---

## #45 — Auto-exec needs a per-coin "never auto-sell below $X" price floor parameter

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-09 | **Symbol:** NEAR

REQUESTED 2026-06-09 (Bryan: 'I don't want NEAR to sell below $1.87' — his NEAR entry). configure_auto_execute currently has NO minimum-sell-price floor parameter, so there is no structural way to guarantee an auto-exec sell never fires below a given price. The only below-entry auto-sell paths are the trailing_stop and pump_alert triggers (AI-discretion sells that can't be price-bounded), since fixed_target sells only fire at explicitly-set levels. INTERIM WORKAROUND APPLIED: restricted NEAR allowed_triggers to ['fixed_target'] only (removed trailing_stop + pump_alert), so NEAR can only auto-act at explicit levels I control (buy $1.68, sell $2.50 — both respect the $1.87 floor). COST of workaround: loses autonomous trailing-stop gain-protection and sudden-pump capture for NEAR; upside capture now requires explicit fixed_target sell rungs (all above $1.87). REQUESTED FIX: add an optional per-coin min_sell_price (and/or 'never sell below entry' flag) to the auto-exec config; when set, shouldAutoExecute aborts any SELL below it regardless of trigger — then trailing_stop/pump_alert can be safely re-enabled with the floor enforced. PAIRS WITH #24 (per-coin auto-exec config) and #21 (stale trailing stop firing below entry — the exact risk this floor would also neutralise).

---

## #46 — Availability-gated auto-exec — railed auto-execute ONLY during sleep/DND, analyse-first when awake

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-09 | **Symbol:** NEAR

REQUESTED 2026-06-09 (Bryan). MOTIVATING TENSION: we just set NEAR to analyse-first (auto-exec OFF) because Bryan wants to analyse momentum before trimming (don't sell the first pop, ladder out on MSS not arbitrary levels). GOOD when he's awake — but the cost is a pump WHILE HE'S ASLEEP/AWAY gets missed entirely (no one to analyse + approve). This feature resolves that: keep the analyse-first/manual tactic as the DEFAULT, but allow the SAME railed tactic to AUTO-EXECUTE only during a sleep/Do-Not-Disturb window when Bryan can't respond — then auto-revert to analyse-first when he's reachable again.

CONCEPT: make Bryan's AVAILABILITY a gate on auto-exec. Awake = analyse-then-NOTIFY (current behaviour, he decides). Asleep/DND = analyse-then-EXECUTE autonomously (same analysis runs, but it acts instead of waiting for a 👍 that won't come). The ONLY difference between the two modes is whether it waits for approval — the analysis + rails are identical.

BEHAVIOUR: when sleep/DND is ACTIVE, eligible (opt-in) coins' PRE-SET fixed_target rungs may auto-execute, subject to ALL the rails of the manual tactic:
(1) PRE-SET LEVELS ONLY — never improvise; only the exact rungs Bryan already set (e.g. NEAR trim $2.75+, buy $1.68). No new levels invented overnight.
(2) PRICE FLOOR — never auto-SELL below the per-coin floor (NEAR $1.87 = entry). Depends on dev #45 (min_sell_price param).
(3) STILL RUNS MOMENTUM/5-PILLAR ANALYSIS before trimming — not a blind fire; if analysis isn't High-confidence / structure looks like a fakeout, it HOLDS and just logs+notifies for morning review rather than selling.
(4) CAPS — max_sell_pct (e.g. 25%), preserve 25% moon bag, max_buy_usd, per-session max autonomous sell value.
(5) PER-COIN OPT-IN (#24) — only coins Bryan flags as 'sleep-auto eligible'; OFF by default.
(6) SEMI-AUTO NOTIFY+UNDO where possible — 'auto-trimmed 25% NEAR @ $2.81 while you slept — reply UNDO within Xmin'; full journal tag 'sleep_auto_trim'.
(7) TIME-BOXED — only fires within the sleep/DND window; auto-reverts to analyse-first/notify when window ends.
(8) MORNING DIGEST — summarise anything that auto-fired overnight (what, price, P&L, reasoning) on wake.

INTEGRATION — this is the connective tissue between four existing items:
- #32 (sleep/DND mode) provides the availability state/toggle that gates this.
- #45 (per-coin min_sell_price floor) is a PREREQUISITE for safe sleep-auto sells.
- #34 (autonomous pump-capture, sell-only railed) is the execution engine — this feature = #34 but availability-gated + analysis-aware rather than pure threshold.
- #24 (per-coin auto-exec config) provides the opt-in scoping.
SEQUENCING: build #32 + #45 first, then this rides on top of / merges with #34. Default posture stays: manual/analyse-first when awake, railed-auto only when unreachable. This lets Bryan keep his discretion-first style without sacrificing overnight pump capture.

---

## #47 — Phantom legacy tranche mis-seeded for new positions (TON ~+44 phantom) + limit-order double-log at approval AND fill

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-10 | **Symbol:** TON

PART 1 DEPLOYED 2026-06-11 evening (commit 'fix: #47 pt1 remove false spot-priced execution message from auto-detect suppression'). CHECK 2's sendTelegram removed — suppression branch now console-logs only (source + id + #47 note). Read-back verified: detection query, CHECK 1/3, journal insert, and L10440+ execution path all untouched; -5 lines; clean boot. The false '✅ executed at spot' message class is dead. Verification is by absence — the new console line will show next CHECK 2 trigger.

LIVE WATCH (CLOSED 06-11): PYTH 1,400 @ $0.0365 limit FILLED; books self-reconciled (row 1843 + tranche reduction correct), tracker alert removed, pyth_pending_order_1843 preference cleared.

REMAINING: PART 2 (limit-order lifecycle — placement/pending/fill/cancel states, order-status-based not balance-diff, side-effects only on confirmed fill, partial fills; venue facts documented above) — own fresh session. Also fold in: the boot's '[reminder] Restored 1 reminder state(s)' line (first sighting, presumed conditional logging like the manual_only patch — confirm benign during Part 2's reads).

AUDIT UPDATE 2026-06-12 (from #55's FIRST reconciliation run, 03:00 BST): LINK is a THIRD coin carrying the 22:54:20 phantom-legacy-seed signature — audit-all set now TON + JTO + LINK confirmed. Reconciliation flagged LINK-USD/revolut: exchange available 0.125185 vs non-legacy tranche sum 1.033 (+725%, tagged 'system_high_maybe_open_order' — FALSE POSITIVE, LINK has no resting order, only moon_bag rule #37 @ $999). Root cause: three REAL May-23 non-legacy buy tranches (0.326 @ $9.20, 0.344 @ $8.71, 0.363 @ $8.27 = 1.033) were never decremented when LINK was sold down in the June 4 dump — orphaned, should be disposed/zeroed. The 0.125185 @ $9.0805 legacy seed (22:54:20) happens to MATCH the true exchange balance, so the seed is correct here while the three real tranches are the stale ones. Materiality trivial (~$1 of LINK). FIX: fold orphaned-tranche disposal into Part 2 lifecycle work (single-write + dispose-on-sell), don't one-off patch LINK. Note for Part 2 build: when auditing 22:54:20 seeds, also re-check whether other sold-down coins carry orphaned pre-dump non-legacy tranches that the sell path never decremented — same class as LINK.

---

## #48 — Outcome loop — auto-grade every trade at +7d/+30d and feed the learning model

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-10

REQUESTED 2026-06-10 (Bryan — 'improve my trading abilities' feature set, item 1 of 8, HIGHEST LEVERAGE). Journal captures entries/reasoning/emotion but outcome fields (outcome, outcome_price, outcome_pnl, outcome_notes) are almost all NULL — win-rate stats are built from sparse manually-closed data. FEATURE: auto-grade every journal trade at +7 days and +30 days after entry: snapshot price at those horizons, compute pnl vs decision price, tag win/loss/wash (e.g. ±2% = wash), write to outcome fields, and roll results into the learning model (category win rates, buy-vs-sell, emotion correlation). For SELLS, grade inversely: did price keep rising after the sell (early exit) or fall (good exit)? Include followed_recommendation correlation. Implementation: daily cron scans journal rows older than 7/30d with null outcome_7d/outcome_30d, pulls price (existing price feed), writes grades. Add outcome_7d_pct + outcome_30d_pct columns if needed. This turns EVERY trade into training data for both Bryan and Claude — the learning model's win rates become real instead of sparse. PAIRS WITH: emotion×outcome correlation ticket, shadow-tracker ticket (same grading engine reusable).

---

## #49 — MSS structure tracker — detect swing HH/HL/LH/LL per coin and alert on Market Structure Shift forming/confirmed

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-10

REQUESTED 2026-06-10 (Bryan feature set, item 2 of 8). Bryan's core exit/entry signal is MSS — Market Structure Shift: price fails to make a new high, then breaks the previous Higher Low. Currently eyeballed from charts; static price alerts only approximate it (e.g. JTO $0.54 is doing double duty as MSS line AND potential add level — ambiguous until structure is read). FEATURE: per-coin swing-structure tracker. From price history, detect swing highs/lows (e.g. zigzag with ATR-scaled threshold or fractal pivots on 1h/4h), maintain the sequence of HH/HL (uptrend) vs LH/LL (downtrend), and fire dedicated alerts: 'MSS FORMING — failed new high on X, watching HL at $Y' and 'MSS CONFIRMED — X broke previous higher-low $Y'. Telegram alert should state which structure level broke and the prior swing map. Opt-in per coin (active swing positions: CC, JTO, NEAR, TON, AERO, ENA). This converts Bryan's primary strategy rule from manual chart-reading into a system signal — strategy-native, much better than static rungs for exits. NOTE: keep it ALERT-ONLY (notify + Claude analyses); never auto-execute off MSS without explicit later opt-in.

---

## #50 — Abnormal-move detection — ATR/volatility-based 'outside normal range' alerts (real-time sharp dip/pump capture)

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-10

BUILD 1 DEPLOYED + VERIFIED LIVE 2026-06-12. Intraday price capture running: captureIntradayPrices() fires on boot + every 2 min (CAPTURE_INTERVAL_MS = 2min, decoupled from 5-min checkPortfolio loop). Captures all non-meta coin_strategy rows (held + watch coins: AVAX/BCH/HYPE/RENDER/XLM included). DB verified: 48 rows in price_intraday within ~4 min of deploy (2 capture cycles × ~24 coins). Table: price_intraday (symbol, price, recorded_at, indexed on symbol+recorded_at). Prune cron: 2:15 AM deletes rows >30d. node --check clean, +49 lines (L32 const, L437 table, L2660 function, L7165-66 interval registration, L7214-20 prune cron).

PATH C CONFIRMED: phased build — data clock started now (watch coins included), ATR baseline needs ~2-4 weeks to accrue. Data will be meaningful by early July.

REMAINING BUILD 2 (own session, Opus): ATR/volatility baseline computation + abnormal-move detector. Design: for each coin, compute rolling volatility from price_intraday (e.g. std-dev of % moves over 14-30d, or simplified ATR proxy using price_intraday highs/lows over a rolling window). Fire when a move within the LAST capture interval (2 min) exceeds k×baseline (k configurable per coin, default ~3). Telegram: 'ABNORMAL MOVE — CC moved +6.2% in 2min, 3.4× its normal range — SHARP PUMP'. Alert-only, plan-aware (coin_strategy role), per-coin cooldown, no auto-trade trigger. DEPENDS ON: ~2-4 weeks of price_intraday data for meaningful ATR. Can run BUILD 2 sooner with a looser/wider baseline (e.g. 7d) — lower signal quality but usable.

NOTE: #60 (baseline24h = 0) recurred again on this boot — same daytime-boot condition. Still not urgent but queued for a read-only diagnosis session. Fix is simple (grab latest row ≥20h old instead of 22-26h window). Both are low-risk surgical fixes.

---

## #51 — Pre-trade checklist gate — score every trade against Bryan's own rules before approval (chase/catalyst/macro/concentration/cap/floor)

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-10

REQUESTED 2026-06-10 (Bryan feature set, item 4 of 8). Bryan's discipline rules currently live in conversation with Claude — they should also be encoded so they fire at 3am or when FOMO is loud. FEATURE: pre-trade checklist gate. Before any trade reaches Telegram approval, score it against Bryan's own rules and attach the scorecard to the approval message: (1) Setup: is this a sharp dip/pump outside range, or a chase? (distance from recent high/low, abnormal-move check) (2) Catalyst: live, upcoming, or spent? (from catalyst calendar #40) (3) Macro: BTC tape position vs radar levels (4) Concentration: what does this do to theme exposure (DTCC%, BTC-beta%)? (5) Sizing: within coin cap / powder rules? (6) Floor check: is this a sell below entry on a never-sell-below-entry coin? (7) Cooldown: rebuying within pennies of a recent trim (churn check — would have flagged the $0.59 JTO rebuy vs $0.61 trim). Output: PASS/CAUTION/BLOCK per item + overall. CAUTION/BLOCK don't prevent execution (Bryan stays in control) — they make the approval message show exactly which of his own rules the trade bends. Implementation: middleware in the trade-approval path; rules read from saved preferences (caps, floors, coin roles).

---

## #52 — Shadow tracker — log passed/declined trades and grade them, measuring whether discipline saves or costs money

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-10

REQUESTED 2026-06-10 (Bryan feature set, item 5 of 8). Bryan's discipline shows up as much in NON-trades as trades: passed ARB (@$0.082), passed BCH bounce (@~$204), held GHIBLI instead of round-tripping (+22.9% spike @$0.000365), paused ENA T3 (@$0.079), declined JTO rebuy (@$0.5938), converted LINK nibble to alert (@$7.658). None of these are measured — so we can't know if his passes are saving money (suspected yes) or costing upside. FEATURE: shadow tracker. New journal action type 'pass' (or shadow_trade table): log symbol, hypothetical action (the buy/sell NOT taken), hypothetical price, date, reasoning. Grade at +7d/+30d with the SAME engine as ticket #48 (outcome loop): 'pass saved X%' (price fell) or 'pass cost X%' (price rose). Roll into learning model as pass-accuracy stat alongside trade win-rate — calibrates BOTH directions of judgment (when to act AND when to sit). Morning brief / scorecard can surface 'your passes this month: 5 saves, 1 miss, net +$Y avoided'. Low build cost (reuses #48 grading), high self-knowledge value. Claude should log passes at decision time via log_journal with the new action type.

---

## #53 — Concentration dashboard — live theme/beta exposure (DTCC %, BTC-beta %, meme %) with ceiling warnings

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-10

REQUESTED 2026-06-10 (Bryan feature set, item 6 of 8). Concentration risk is currently a mental note in conversation (CC ~50% of Revolut book; LINK + XLM are the SAME DTCC institutional-tokenization bet; high-beta names cluster). FEATURE: live concentration/correlation dashboard + MCP field. Tag each coin with theme(s) and beta class in a config table: DTCC/institutional-tokenization (CC, LINK, XLM), L1 (TON, NEAR, SOL...), DeFi (JTO, AERO, ENA), meme/lotto (GHIBLI, PEPE, BONK, FLOKI, BOBA), dead-bag, BTC-beta high/low. Compute live: % of portfolio per theme, % per beta class, largest single-coin %. Surface in get_portfolio_summary (concentration block), the dashboard, and morning brief. Alert when a PENDING TRADE would push a theme past a configurable ceiling (e.g. DTCC > 55%) — feeds checklist gate item 4 (#51). Makes the 'this deepens DTCC concentration' conversation a visible number instead of a recalled warning.

---

## #54 — Emotion×outcome correlation — win-rate by emotion tag, action, and category (depends on #48)

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-10

REQUESTED 2026-06-10 (Bryan feature set, item 7 of 8). Journal already tags emotion (confident/uncertain/fomo/fearful/neutral) on most trades but it has never been correlated with results. FEATURE: emotion×outcome analysis. Once outcome grading exists (#48), compute win-rate and avg pnl per emotion tag, per action (buy vs sell), and per category (L1/DeFi/meme). Output examples: 'confident buys: 55% win; fomo buys: 0% win; uncertain sells: 60% win'. Also correlate followed_recommendation true/false vs outcome. Surface in learning model summary (get_context), dashboard scorecard (#23), and periodically in morning brief when sample size is meaningful (n≥10 per bucket; show n). Cheap to build (one aggregation query on top of #48's graded data), potentially the most behaviour-changing stat in the system. DEPENDS ON: #48 outcome loop.

---

## #55 — Nightly ground-truth reconciliation — auto-compare system positions vs real exchange balances, flag drift

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-10

DEPLOYED 2026-06-11 night (commit 'feat: #55 nightly ground-truth reconciliation'). Survived a mid-dispatch PC reboot — post-reboot verification done by reading the SYNCED file directly (not trusting Cowork's pre-freeze 'done'): all 4 edits present + byte-correct, node --check clean on synced copy, 619,000 bytes (+~135 lines). runReconciliation() confirmed: Revolut /balances(available) + Kraken vs non-legacy tranche SUM(remaining_quantity) GROUP BY symbol,exchange; keying ENA-USD::exchange aligns build+lookup; TOL 0.5%; systemQty===null skip (no false drift on untracked/dust); open-order tag for revolut system>available (PYTH-reservation lesson); 7-day unacked-dup suppression; Telegram only on NEW drifts. Cron '0 3 * * *' Europe/London. get_trading_data include='reconciliation' OUTSIDE fetchAll (explicit-only) — VERIFIED LIVE returns {reconciliation:[]} clean. Boot clean, table created no error. FIRST REAL RUN tonight 3AM. CHECK TOMORROW: '✅ clean' console or '⚠️ RECONCILIATION — N drift(s)' Telegram; triage real drift vs benign 'may be open order' tag. Institutionalizes the ground-truth check that caught #47 manually.

---

## #56 — Alert content bugs: up-target fired with 'FLOOR HIT' label + plan-blind BUY-THE-DIP recommendation on a radar-only coin (canary test evidence)

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-10 | **Resolved:** 2026-06-12 | **Symbol:** BTC

✅ CLOSED 2026-06-12 (status corrected — was resolved 2026-06-11, status lagged). All 4 items fixed + verified: (1) wick-trigger 'Now' opacity → S2 wick line; (2) rung description not rendered → S2 📝 line; (3) direction mislabel (up-target showed FLOOR HIT) → S2 geometry guards at all 3 setters; (4) plan-blind BUY-THE-DIP rec + hallucinated product names on a radar-only coin → resolved by #57 S3 (plan-aware engine), proven by AERO canary 2026-06-11. All closed.

---

## #57 — Per-asset Strategy Registry — every holding/dust/watchlist coin gets status, role, strategy notes + described alert targets, on dashboard cards, updatable from PM thread

**Status:** ✅ resolved | **Category:** feature | **Source:** developer

**Created:** 2026-06-10 | **Resolved:** 2026-06-12

✅ CLOSED 2026-06-12 — S4 DEPLOYED + VERIFIED LIVE (Bryan confirmed cards render correctly on the dashboard: HOLDINGS section with role badges, expand showing STATUS/ROLE/THEME + Cycle P&L pending #8 + strategy notes + LOTS via /api/tranches). All four stages now complete: S1 (registry table+MCP) ✓, S2 (descriptions+wick+geometry) ✓, S3 (plan-aware engine) ✓, S4 (dashboard coin cards) ✓. #36 RESOLVED by S3, #56 RESOLVED.

S4 SHIPPED: dashboard.js v3.1.0 (709 lines) via 3 surgical edits (per the relaxed edit policy #66) + dashboard.js.bak backup; node --check clean; deployed clean. Two new GET endpoints (Stage 1): /api/coin-strategy + /api/tranches/:symbol. coin_strategy structured columns backfilled for 10 migrated rows. Sections: BTC macro-radar strip; HOLDINGS (featured cards + collapsed Dead bags group); WATCHING FOR ENTRY (AVAX,BCH,HYPE,RENDER,XLM,LINK). Card journal sourced from /api/activity (client-filtered).

REMAINING items now live in their OWN tickets (NOT part of #57):
- #8 cross-cycle P&L engine (tax-relevant) — gates the card's 'Cycle P&L' line (currently 'pending #8' placeholder)
- #14/#19 XRP multi-location (card shows Revolut dust ~$1, not the ~$1,140 Tangem holding)
- #65 /api/journal/:symbol base-vs-USD bug
- OPTIONAL v2: live-target rung cross-ref on card (rungs currently shown via strategy_md TARGETS text)

Original S1-S3 detail and AERO canary verification archived in prior log revisions.

---

## #58 — Startup patch force-enables ai_auto_execute on every boot — reverts deliberate disables (Bryan's June 9 disable silently undone)

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-10 | **Resolved:** 2026-06-12

RESOLVED 2026-06-10 night (fix deployed) → CLOSED 2026-06-12 (receipt confirmed). FIX DEPLOYED: Fix 3 force-enable block deleted from the auto-exec startup IIFE (~L1366); Fix 4 status log retained; properly-labeled commit ('fix: #58 remove auto-exec force-enable startup patch'). VERIFIED at deploy: Boot 1 after deploy showed NO 'Enabled via startup patch' line (first boot ever without it); read-back confirmed block gone, node --check clean.

DISABLE RESTORED: configure_auto_execute(enabled:false) called 21:42 06-10 — saved to system_config with enabled:false, max_sell 25, triggers [] preserved, hodl_symbols (19) preserved via the handler's ?? merge. manual_only_symbols dropped by the handler's fixed-key rebuild (expected) — re-added by the L1300 boot patch on next boot.

RECEIPT CLOSED 2026-06-12 via LIVE CONFIG (no need to wait on a Railway log): live ai_auto_execute reads enabled:false, allowed_triggers:[], AND manual_only_symbols:[CC,XRP,NEAR] present. The presence of manual_only_symbols proves a boot has run since the 21:42 disable (only the L1300 boot patch re-adds that key after configure_auto_execute strips it) — and on that post-boot config enabled is STILL false. If the force-enable block were still live, that boot would have flipped enabled:true. It didn't = the disable survived a boot = exactly the proof #58 was waiting for. Both config layers (systemConfig + traderProfile preference) agree enabled:false.

STANDING TRIPWIRE (keep): if ai_auto_execute ever reads enabled:true again, something else is writing the config — investigate immediately.

HANDLER NOTE for future config work: configure_auto_execute rebuilds the config with a FIXED key set (enabled, max_sell_pct, max_buy_usd, allowed_triggers, require_confidence, cooldown_minutes, hodl_symbols, updated_at) — any other keys (e.g. manual_only_symbols) are dropped on every configure write and depend on the L1300 boot patch to restore. When #24 per-coin config is built, make the handler preserve unknown keys.

---

## #59 — Does 'acknowledged' mute future fixed-target fires? ENA+TON flagged acknowledged — verify rung re-arm behavior + add unacknowledge

**Status:** in_progress | **Category:** bug | **Source:** developer

**Created:** 2026-06-11 | **Symbol:** ENA

EVIDENCE 2026-06-11 — PARTIALLY RESOLVED. TON-USD was in the 'acknowledged' list, yet its $1.65 fixed down-target FIRED and delivered to Telegram today (anchor $1.65 → $1.6443). CONCLUSION: 'acknowledged' does NOT suppress fixed-price-target fires — it only stops re-nags of an already-fired alert cycle. Bryan's ENA/TON watch sets are NOT muted; the manual-eyeball precaution can be dropped. STILL OPEN from this ticket: (a) confirm a fired rung RE-ARMS for subsequent distinct touches (hysteresis), (b) add an unacknowledge/clear action for completeness. SIDE NOTE (contrast evidence for #56/#36): this TON alert's recommendation was PLAN-AWARE and correct — it cited the T1 fill at $1.6474, identified no active plan trigger, and pointed to the $1.55 add zone per the saved plan. Whatever generated this rec (possibly reading coin_strategy/#57 data) is the behavior #36 wants everywhere — worth Cowork checking why this one was plan-aware while BTC/ENA recs (#56) were plan-blind, and standardizing on this path. Stale-rung cleanup done: $1.65 rung removed (T1 already filled); real ladder $1.55/$1.40/$2.28/$2.89 intact.

---

## #60 — 24h baselines loaded 0 (was 43) — % calcs fell back to stale long-term baselines, false daily alerts possible; suspect midnight cron

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-11 | **Resolved:** 2026-06-12

✅ CLOSED 2026-06-13. ROOT CAUSE confirmed: the query used a strict 4-hour window (recorded_at BETWEEN 26h ago AND 22h ago) to find yesterday's price. recordDailyPrices writes at midnight, so any boot outside 22:00–02:00 produces an empty window — the midnight row is >26h old by afternoon. Deterministic by boot time, not random. FIX: removed the upper bound entirely, widened lower bound to 28h (WHERE recorded_at >= DATE_SUB(NOW(), INTERVAL 28 HOUR)). Now grabs the most-recent row per symbol within 28h — always catches the midnight write regardless of boot time. -1 line. VERIFICATION: boot log will show [baseline24h] Loaded 43 24h prices at any time of day (not just post-midnight deploys). Confirmed by the 2026-06-13 #70 deploy boot which loaded 43 rows (nighttime boot) vs 0 on all daytime boots pre-fix.

---

## #61 — YouTube analyst feed monitor — auto-review videos against my book

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-11

GOAL: automate the manual "review this analyst's video against my holdings" workflow. Monitor a curated set of crypto-YouTube channels; on each new upload (or on demand) transcribe -> analyse against trader profile + live holdings -> surface ONLY what's relevant to held/watch coins or a real BTC-macro shift.

ARCHITECTURE (proposed):
1. WATCHLIST not subscriptions — hand-picked channel IDs in MySQL (new table). Avoids Google OAuth + sub-feed noise; Bryan curates.
2. DETECTION — YouTube public per-channel RSS feed (no API key/quota) + WebSub (PubSubHubbub) push so Railway is pinged on upload rather than polling.
3. TRANSCRIPT = THE KEY TECHNICAL RISK / brittle link. Caption-scraping works but YouTube keeps tightening it; robust fallback = audio + Whisper (heavier, ToS grey area). COWORK VALIDATE THIS FIRST before committing — most likely piece to break / need ongoing maintenance.
4. ANALYSIS — transcript + holdings + LIVE prices (get_portfolio_summary/get_prices) to Claude. Output = which of MY coins mentioned, the take, key levels, AND cross-check every price/claim vs live MCP data so a stale/wrong figure is never relayed as fact. Value = filtering + reality-check, not summary.
5. DELIVERY — Telegram digest push when relevant + on-demand MCP tool ("review latest from my channels").

GUARDRAILS (critical):
- Quality varies wildly (NyQuil-brain TA + leverage/affiliate funnels mixed with occasional useful levels). Surface a video ONLY if it names a held/watch coin or signals a real BTC macro shift. Score-and-suppress, not relay-all (daily 20min transcripts would drown without ranking).
- ALWAYS tag affiliate/funnel/leverage-pitch content as such. NEVER let an analyst's leverage/borrow pitch (e.g. Nexo) become a system suggestion — Bryan is no-stop-loss + recovery-focused; leverage stays out.
- Analyst opinion = INPUT to Bryan's judgment, never an auto-trade trigger. No execution path off this feature.

SCOPE: MVP = RSS detection + watchlist table + on-demand review of ONE channel, transcript reliability validated first. THEN WebSub push + Telegram digest + scoring.

PLACEMENT: overlaps #40 (catalyst pre-loading) + morning-briefing news step — consider scoping as extension of #40 rather than standalone. Tier 2 / QoL candidate — below safety (#43/#12/#55) and data-trust (#47). Not urgent. Confirm position in dev_priority_queue next dev session.

---

## #62 — Researcher module — automated per-coin catalyst/fundamentals fetch + re-entry/opportunity scanner + batch prices (engine behind #40)

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-11

COMPONENT 3 (batch prices) NOW FULLY VERIFIED END-TO-END 2026-06-11 afternoon — client tool-cache propagated (same lifecycle as #42, resolved within ~2h). Batch call get_prices symbols=['BTC-USD','ENA-USD','GHIBLI-USD'] returned {prices:{BTC:{62402.18,source:'revolut'}, ENA:{0.0753,source:'revolut'}, GHIBLI:{0.000326,source:'kraken'}}} — one call, three prices, Kraken fallback + source labels proven. Single-symbol back-compat already verified this morning. COMPONENT 3 CLOSED. Remaining #62 components: (1) catalyst/fundamentals research fetcher (merge w/ #40), (2) re-entry/opportunity scanner, (4) catalyst calendar.

---

## #63 — Cash-flow ledger + true lifetime economic return — track deposits/withdrawals/payments distinctly, value ALL accounts (fix Revolut-only −77% overstatement)

**Status:** in_progress | **Category:** feature | **Source:** developer

**Created:** 2026-06-11

EVIDENCE UPDATE 2026-06-11: (1) PARTIAL PROGRESS CONFIRMED — card payments are now auto-captured (journal rows 1847/1848 today, source=revolut_card, USDT payments $18.86 + $14.55). (2) REMAINING GAP CONFIRMED — crypto→personal bank WITHDRAWALS are NOT detected: Bryan withdrew $13.39 USD → £10.00 GBP at 14:22 BST today ('Crypto → Personal', no fees, completed) and no journal row was created. Manually reconciled: update_capital withdrawal -$13.39 (capital $20,945.20 → $20,931.81) + journal transfer row id 1849. FIX NEEDED: detect fiat/crypto transfers OUT of the Revolut crypto account (and IN — deposits) the same way card payments are now captured, writing both a journal transfer row AND the capital adjustment atomically so manual reconciliation isn't needed. These withdrawal events are exactly the cash_flow ledger rows this ticket specifies.

---

## #64 — WORKFLOW CONVENTION — Cowork prompts AND read-backs as single copyable code boxes

**Status:** 🔵 open | **Category:** note | **Source:** developer

**Created:** 2026-06-12

STANDING CONVENTION (Bryan 2026-06-12, every dev session): (1) Every Cowork/Dispatch prompt Claude writes goes in ONE single fenced code block — no nested fences — for one-tap copy. (2) The prompt must explicitly instruct Cowork to return its READ-BACK in the same single copyable code-box format. (3) That read-back box must contain EVERYTHING Claude needs to verify the change WITHOUT a follow-up round-trip: the full read-back of each edit site, the node --check result (pass/fail + any error text), and any other check the prompt requested (line numbers, file size, boot lines, etc.). A read-back missing the node --check result or any requested check is INCOMPLETE. Therefore every prompt's closing checklist must ENUMERATE exactly what Cowork must include in that one box. Also saved to Claude cross-session memory.

---

## #65 — /api/journal/:symbol returns empty — appends -USD but journal stores base symbols (format mismatch)

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-12 | **Resolved:** 2026-06-12

✅ CLOSED 2026-06-13. ROOT CAUSE: GET /api/journal/:symbol normalized the param by APPENDING -USD (param.includes('-USD') ? param : param+'-USD') then queried `WHERE symbol = 'JTO-USD'`. But trading_journal stores BASE symbols ('JTO', 'PYTH', 'TRX' etc — confirmed from recentTrades in get_context). Every query returned empty. FIX: replaced the append logic with `req.params.symbol.toUpperCase().replace('-USD', '')` — strips -USD if present, leaving the base symbol that matches journal storage. Handles both 'JTO' and 'JTO-USD' inputs correctly. -0 net lines (1-for-1 replacement). The dashboard's loadJournalEntries uses /api/activity (not this route), so the card was unaffected; but this endpoint is now functional for any future consumer. Bundled with #60 in one Cowork prompt.

---

## #66 — POLICY: dashboard.js atomic-rewrite rule relaxed — surgical edits OK, Dev decides per situation (node --check + .bak still required)

**Status:** ✅ resolved | **Category:** note | **Source:** developer

**Created:** 2026-06-12

POLICY UPDATE (Bryan 2026-06-12): the "dashboard.js must ALWAYS be a complete atomic delete-then-create, never partial-edit" rule was introduced because of EARLIER tool limitations. With the upgraded tooling those limitations no longer apply, so the rule is RELAXED: surgical/targeted edits to dashboard.js are acceptable and often PREFERRED (lower risk than retransmitting the whole file through chat, and leaves unchanged functions byte-identical). Claude (Dev) decides atomic-vs-surgical per situation based on what's safest for that change. STILL MANDATORY either way: (1) node --check public/dashboard.js must pass before every push; (2) for surgical edits, back up dashboard.js.bak first for instant rollback. This validated the #57 S4 Stage 2 delivery (3 targeted edits rather than a 709-line full-file paste). ALSO LOGGED: model_usage_policy preference — Claude proactively suggests switching to the model that fits the task (lighter for routine work, Opus/Fable for heavy reasoning) to moderate Claude.ai usage.

---

## #67 — DEV CONVENTION — Claude recommends the fitting model at each step (light vs heavy); Bryan toggles, to moderate usage

**Status:** ✅ resolved | **Category:** note | **Source:** developer

**Created:** 2026-06-12

DEV WORKFLOW CONVENTION (Bryan 2026-06-12, mirrors the model_usage_policy preference): in Dev/Dispatch sessions, Claude proactively NAMES the recommended model at each step/juncture so Bryan can toggle it (Claude CANNOT self-switch — the model picker is user-controlled). Use a lighter model (Sonnet/Haiku) for routine work — read-only diagnosis, read-back verification, browser-result checks, small Cowork prompts, dev_log writes — and reserve Opus/Fable for heavy work — feature design, multi-file reasoning, tricky root-cause diagnosis, building/rewriting code. Flag the recommended switch up-front whenever the upcoming work shifts lighter or heavier, not mid-task. Goal: moderate Claude.ai usage/credits. Pairs with claude_ai_usage (batch fixes, resolve in 1-2 sessions, avoid repeated failed deploys).

---

## #68 — INTELLIGENCE LAYER (umbrella) — one research engine (#39), pluggable sources (#40 catalyst / #61 YouTube / new social), shared guardrails + pipeline

**Status:** 🔵 open | **Category:** note | **Source:** developer

**Created:** 2026-06-12

ARCHITECTURE FRAMING (Bryan 2026-06-12): the research/catalyst/YouTube/social tickets should be built as ONE intelligence layer, not separate scrapers. Structure = one shared ENGINE + pluggable SOURCES + common guardrails + one delivery pipeline.

ENGINE (#39): web-research + LLM synthesis, runs on the server's existing ANTHROPIC_API_KEY (pay-as-you-go, separate from Max). Build decision pending: Anthropic web-search tool vs Perplexity Sonar (compare cost-per-call + citation/URL quality). Provides a single 'research(query)→cited findings' + 'analyse(content, holdings, live prices)→relevant-to-book takeaways' interface that every source calls.

PLUGGABLE SOURCES (adapters that feed the engine, built incrementally):
- #40 Catalyst calendar — per-coin catalysts (date, type, priced-in/sell-the-news, days-until), pre-loaded so analysis is instant not cold-scrambled.
- #62 Researcher module — catalyst fetcher + re-entry/opportunity scanner (batch-prices component already built/verified); merge its fetcher with #40.
- #61 YouTube analyst feed — curated channel watchlist, RSS+WebSub detection, transcript→analysis (transcript reliability is the brittle link, validate first).
- [NEW] X / social / news feeds — see the new sibling ticket; same curated-watchlist pattern.

SHARED PIPELINE (every source): fetch → analyse vs trader profile + LIVE holdings/prices → FILTER HARD (surface only if it names a held/watch coin or signals a real BTC-macro shift) → reality-check every price/claim against live MCP data → deliver (Telegram digest when relevant + on-demand MCP tool 'review my feeds' + morning-briefing integration).

SHARED GUARDRAILS (non-negotiable, all sources): (1) score-and-suppress, never relay-all; (2) tag affiliate/funnel/leverage/paid-promo content; (3) analyst/social opinion = INPUT to Bryan's judgment, NEVER an auto-trade trigger — no execution path off this layer; (4) never relay a stale/wrong figure as fact (cross-check vs live prices); (5) source + date (+ URL where possible) on every claim.

SEQUENCING: build #39 engine + the source-normalization interface FIRST; then add sources cheapest/highest-signal first (catalyst #40), then YouTube #61 (validate transcripts first), then X/social. Positions #40/#61/social as adapters, not standalone bolt-ons. Tier 2 / QoL — below safety (#12) and data-trust (#47).

---

## #69 — X / social / news feed monitor — pluggable intelligence-layer source (under #68), sibling to #61 YouTube

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-12

REQUESTED 2026-06-12 (Bryan). A pluggable SOURCE under the intelligence-layer umbrella (#68), sibling to #61 (YouTube). GOAL: monitor curated X (Twitter) accounts + other social/news feeds for posts relevant to held/watch coins or a BTC-macro shift — same pattern as #61: Bryan curates a hand-picked watchlist (NOT a firehose), system detects new posts, the #39 engine analyses them against holdings + LIVE prices, filters hard, delivers a Telegram digest + on-demand review.

SOURCES (in likely build order, cheapest/most-reliable first): (1) NEWS/PROJECT RSS — official exchange/project announcement feeds + crypto news RSS; cheap, reuses #61's RSS+WebSub path, highest signal-to-noise. (2) Curated X accounts — analysts/projects/official handles. X ACCESS IS THE KEY RISK/COST (validate FIRST, like #61's transcript link): official X API is paid + rate-limited; evaluate vs RSS/nitter-style bridges vs a third-party social aggregator on cost + reliability + ToS. (3) Optional: other social (Reddit/Discord announcement channels) later.

INHERITS umbrella guardrails (#68): opinion = INPUT not an auto-trade trigger (no execution path); TAG promotional/shill/paid/affiliate content aggressively (X is saturated with it — paid 'calls', leverage funnels, pump groups); reality-check every price/claim vs live MCP data; surface ONLY what's relevant to the book or a real macro shift; source + handle + date on every item.

SCOPE: MVP = news/project RSS feeds + a few curated X accounts via whatever access proves cheapest, validated X-access path first. Tier 2 / QoL — below safety (#12) and data-trust (#47). Build AFTER the #39 engine + #40/#61 sources establish the shared pipeline.

---

## #70 — Redeploy resets acknowledged alert states — re-fires already-actioned levels

**Status:** ✅ resolved | **Category:** bug | **Source:** developer

**Created:** 2026-06-12 | **Resolved:** 2026-06-12 | **Symbol:** JTO

✅ CLOSED 2026-06-13. ROOT CAUSE: two compounding gaps. (1) The macro_alerts_sent write inside acknowledgeAlert() was conditional on `if (activeFixedAlerts.has(symbol) || priceTargets.has(symbol))` — but activeFixedAlerts is cleared EARLIER in the same function, so the condition always evaluated to false unless priceTargets still had entries. Result: any ack after the target interval cleared silently skipped the macro_alerts_sent write, leaving only the ignored_coins 24h row as protection. (2) The fixed-target fire-path cooldown window was only 4 HOUR — any redeploy >4h after an ack lost the secondary protection. Both defences failed simultaneously when JTO $0.54 re-fired. FIX (3 surgical edits, -3 lines): (1) Removed the conditional from acknowledgeAlert() — macro_alerts_sent now always written unconditionally on any ack. (2+3) Extended both fixed-target fire-path cooldown windows (UP at L6594, DOWN/floor at L6709) from INTERVAL 4 HOUR to INTERVAL 24 HOUR — matches the ignored_coins 24h expiry. Comments updated from '4h' to '#70: 24h window matches ignored_coins expiry'. Grep confirmed: 0 target-path INTERVAL 4 HOUR remaining, 2 INTERVAL 24 HOUR present, all other 4h intervals (pump/drop hash cooldown, journal sell-recency, startup restore) untouched. node --check SYNTAX OK, -3 lines (12374 total). STALE QUANTITY NOTE: the re-fired alert also showed JTO quantity as 169.69 (phantom tranche) not real 109.69 — that's the #47 family, not #70; left for Part 2. REMAINING TIDY-UP (non-blocking): the startup restore at L992 that rebuilds alertState.acknowledged from macro_alerts_sent still uses INTERVAL 4 HOUR — should be extended to 24 HOUR for consistency in a future session.

---

## #71 — Portfolio undercounts holdings — coins in resting limit sells excluded from balance/value

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-13 | **Symbol:** CC

CORRECTION (Bryan, 2026-06-14): In the Revolut X app, limit orders — BUY or SELL — NEVER change displayed holdings. Coins stay fully counted in the balance until a sell actually fills; cash stays counted until a buy fills. The app always shows true total holdings. So this is NOT an acceptable 'free vs total' quirk to work around — it is purely a system-side defect: the MCP feed is dropping coins reserved in resting orders when Rev X itself does not.

EXPECTED BEHAVIOUR: system holdings/value must MATCH the Rev X app — count reserved-in-order coins in the balance, exactly as the app does. The earlier suggestion ('add ~3,000 CC manually until fixed') is a stopgap only; correct fix is the feed reports total holdings, full stop.

EVIDENCE (2026-06-14): system 16,896 CC / $2,760 / total $4,932 vs app 19,895 CC / $3,250 / total $5,422. Gap = 3,000 CC in two resting limit sells ($0.178 + $0.186). Reconciles to the dollar. Likely cause: feed reads 'available/free' balance from the API instead of total wallet balance — pull total balance (free + reserved) or add reserved-in-orders back per asset. Filling a limit must then NOT cause an apparent value jump (reserved coin simply reclassifies free→cash, net zero).

---

## #72 — Researcher feature — auto deep-research on held/watched assets + strategy-aware adjustment recommendations (PRIORITISE)

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-13

BUILD 1 TEST PASSED 2026-06-13 — research_asset ran end-to-end in PM thread on CC. QUALITY: excellent. Real web search fired (Console showed 4 web searches + ~48K-token claude-sonnet-4-6 spike). Output pulled verbatim DTCC dates (July 2026 limited production, Oct 2026 full launch), caught Digital Asset raise BEAT ($355M actual vs plan's ~$300M, a16z $100M + Citadel/Apollo/BNP/CME/HSBC/ADIA), flagged structural risks (unlimited supply, top-100 wallets ~89% per Grayscale S-1), gave clean plan-drift verdict (NO CHANGE — trim ladder well-positioned for July sell-the-news, hold for unpriced Oct), plus one optional upper-rung idea. Cited sources, reality-checked vs live $0.16303, recommend-only. Guardrails held.

COST FINDING (gates Build 2): ~48K tokens + ~4 web searches for ONE call ≈ $0.20-0.25/call (Sonnet 4.6 ~$3/M in, ~$15/M out, web search ~$10/1k). IMPLICATION: per-call cost is fine for ON-DEMAND use, but a DAILY full-book sweep (~20 coins × $0.22 = ~$4.40/sweep = ~$130/mo) is ~30× current API spend ($3.94/mo) and NOT justified. Weekly sweep ≈ $18/mo (reasonable). Event-driven (research only on trigger: #50 abnormal move, alert fire, manual ask, or the 3-5 coins with active decisions) ≈ near-trivial.

BUILD 2 REDESIGN (supersedes 'daily book-sweep'): make it EVENT-DRIVEN / SELECTIVE, not blanket-daily. Options: (a) on-trigger — research a coin only when #50 fires an abnormal move or an alert hits; (b) selective — research only coins with active armed decisions (3-5 at a time), weekly; (c) manual batch — a research_book tool Bryan invokes for held coins on demand. Probably (a)+(c). Keeps cost near current. Change-detector + Telegram notify-only delivery still applies, just gated by trigger not cron.

ALSO NOTED: no cost-visibility tool — claude_api_calls table exists but isn't exposed via get_trading_data (no 'claude_costs' include). Worth adding a costs include or a small dashboard panel so spend is queryable not eyeballed. Low priority QoL.

STILL OPEN: #72 Build 1 itself proven — mark research_asset DONE/verified. Build 2 = own session (Opus, event-driven design per above).

---

## #73 — Living ARCHITECTURE.md + decision record in repo — single durable reference for build history, data flow, subsystems, design rationale (history currently fragmented across dev_log/git/memory)

**Status:** ✅ resolved | **Category:** feature | **Source:** developer

**Created:** 2026-06-13 | **Resolved:** 2026-06-13

✅ CLOSED 2026-06-13. ARCHITECTURE.md committed to repo root (commit 79a5548 'docs: #73 add ARCHITECTURE.md', 138 lines / 15.8KB, verified on GitHub). Pure documentation — server never reads it, zero runtime effect, no node --check needed. Kept the commit pure-docs (declined Cowork's offer to bundle a .gitignore change + the already-done #12 cleanup — one-change-at-a-time; git diff confirmed server.js was clean vs HEAD so nothing code shipped).

CONTENTS (7 sections): §1 System overview (stack, secrets, the 3-thread PM/Dev/Cowork model) §2 Data-flow map (5-min checkPortfolio loop, 2-min intraday capture, full cron schedule, alert pipeline, trade+approval path, reconciliation) §3 Subsystem map (14 MCP tools, auto-rules, tranche/tax HIFO+S104, intentions, coin_strategy registry, USDT sweep, dashboard, #12 backup, #72 research layer) §4 Design decisions+rationale (why MySQL/single-file, auto-exec OFF, no leverage/stops, Telegram-gated exec, phased builds, COIN-USD format, single-write tranche, live-DB-wins) §5 Conventions (#64 single-box prompts, #66 surgical edits, node --check, #67 model policy, session continuity, credential-bug diagnostics) §6 Build timeline (from git history) §7 Open-issues index (points to dev_log as live board).

MAINTENANCE: saved to Claude memory (#5) as a standing rule — update ARCHITECTURE.md when a major subsystem ships / load-bearing decision changes / Tier-1 closes, drafted via Cowork prompt alongside the dev_log entry + checkpoint at session close. NOT updated for every small fix (dev_log is the live per-ticket record; this tracks system SHAPE only, changes slowly). Safe when slightly stale — every section points to dev_log as authoritative. Fills the previously-empty Project knowledge slot conceptually (could also be pasted into the Project knowledge box if desired).

FOLLOW-ON (noted, not done): git history HEAD sits on 'test: #12 temp' labelled commits (cosmetic, code is clean); .tmp.driveupload/ + html-ids.txt + dashboard.js.bak are untracked scratch/backup files — consider a .gitignore tidy as its own small commit someday. Periodic dev_log→dated-markdown export still a candidate (guards log_dev_issue detail-replacement).

---

## #74 — AI-analysis bot recommends LADDER/sell on rebuild-mode ENA — context-blind, contradicts saved plan (feeds #36)

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-13 | **Symbol:** ENA

The AI-analysis bot recommended LADDER (sell partial) on ENA at $0.0855 / +2.8%, reasoning 'strategy rules require laddering out on pumps + retain 25% moon bag.' This is WRONG for ENA's actual posture and is a context-blindness failure the plan-aware alert engine (#36) must fix.

WHY IT'S WRONG:
1. POSITION MODE IGNORED — ENA is in REBUILD/INCREASE mode, not profit-taking. Bryan already laddered most of ENA out earlier and is holding 3,552 to RECOVER, with ~$181 reserved to ADD. 'Ladder out on pumps' is a trim rule for positions being harvested — applying it to a rebuild position tells Bryan to sell something he's trying to grow.
2. TRIVIAL GAIN — +2.8% is not a trim-worthy pump; the generic pump-ladder rule fired on noise.
3. CONTRADICTS THE COIN'S OWN PLAN — coin_strategy_ENA has NO upside trim rungs; its named triggers are $0.072 (fade-retest ADD) and $0.098 (reversal-confirmation), plus $0.068 capitulation re-arm. The bot invented a sell action with no basis in the saved plan.
4. The Telegram FIXED TARGET alert + its own note correctly said HOLD/FADE-WATCH; the AI-analysis block then contradicted it with LADDER. Two engines, opposite calls, same coin, same instant.

FIX (feeds #36 plan-aware alerts): recommendations must be conditioned on (a) the coin's POSITION MODE (rebuild/increase vs harvest/trim vs hodl) and (b) the coin's OWN saved trigger levels — never apply generic 'ladder on pump' to a coin whose plan has no upside trim rungs or is flagged increase-mode. If no named plan level is in play, default to HOLD/ACKNOWLEDGE, not an invented action. Also: suppress action recs on sub-threshold moves (e.g. <5-8% with no level breach).

---

## #75 — Verify dashboard coin card renders MCP-made changes (new rungs, id-less rungs, coin_strategy notes)

**Status:** 🔵 open | **Category:** task | **Source:** developer

**Created:** 2026-06-13 | **Symbol:** CC

VERIFY the dashboard coin card actually renders strategy changes made via MCP (alerts + coin_strategy_* notes). Data layer is confirmed persisted (get_portfolio_summary shows the new rungs), but front-end rendering is unverified.

CHECK 1 — fixed_target rungs render: CC now has R4 $0.200 / R5 $0.230 / R6 $0.270 (up) + $0.175/$0.160/$0.155/$0.148, AERO has new $0.350/$0.335 (down). Confirm all show on the card after refresh and that dashboard cache TTL isn't hiding fresh rungs.

CHECK 2 — id-less rungs (IMPORTANT): in the latest get_portfolio_summary, the NEWEST fixed_target entries returned with NO 'id' field (e.g. CC R5 $0.230 & R6 $0.270; AERO rungs had ids 85/86 but CC R5/R6 did not). Older rungs all have ids. If the dashboard keys rrow rendering off 'id', the newest rungs may silently fail to display, and remove_target (which matches on target_price) is fine but any id-based UI action would break. Investigate why some set_target writes aren't getting an id assigned/returned — possible insert race or missing RETURNING id.

CHECK 3 — coin_strategy_* notes: confirm whether the coin card surfaces the saved coin_strategy_<SYM> preference text (thesis, July vs Oct framing) or only the price rungs. If it doesn't read the preference, decide whether it should (Bryan expected the adjusted plan to show on the card).

Note: this overlaps #55 reconciliation and the #71 holdings undercount (card also shows CC qty 16,896 vs true ~19,895 due to coins reserved in resting limits).

---

## #76 — URGENT macro alert fires risk-off panic while BTC rising — not price-aware, contradicts live tape (feeds #72/#36)

**Status:** 🔵 open | **Category:** bug | **Source:** developer

**Created:** 2026-06-13 | **Symbol:** BTC

An 'URGENT MACRO ALERT' fired a risk-OFF / downside-panic warning that directly CONTRADICTS live price action. Alert claimed: 'BTC support at $60K under pressure / crumbling,' '$60K may not hold,' 'rally to $70K stalled, confidence fading,' 'tighten stops if BTC breaks $62K.' REALITY at fire time: BTC live $64,167, +0.73% 24h, printing green higher-highs and RISING through $64K — i.e. ~$4K ABOVE the $60K support it claimed was crumbling, and the '$62K break' trigger was already behind price. Direction is backwards.

SPECIFIC DEFECTS:
1. NOT PRICE-AWARE — alert generated a bearish macro narrative without checking live BTC. Reads like it summarised older/aggregated '$60K at risk' web articles + sentiment rather than the live feed (similar context-blindness class to #74).
2. ADVICE DOESN'T FIT TRADER — 'tighten stops on leveraged alts' — Bryan runs NO leverage and uses NO stop-losses (only trailing stops to protect gains). Generic risk-off boilerplate, not strategy-aware.
3. SELF-CONTRADICTORY / SCARY FRAMING — staples a real SpaceX-liquidity note onto a panic frame the tape doesn't support; lists Bryan's alts as 'vulnerable to liquidation' while they're actually rising with BTC.
4. FALSE URGENCY — tagged 'URGENT' for a scenario that isn't happening; erodes trust in the alert channel (cry-wolf risk).

FIX: macro/news alerts MUST be price-aware before firing — cross-check the claimed level against live price and current structure; suppress or invert if the narrative contradicts the tape. Strip leverage/stop-loss boilerplate (respect trader profile: no leverage, no stop-losses). Reserve 'URGENT' for confirmed live-structure breaks (e.g. BTC actually losing $59.5K), not sourced sentiment. Fold guardrail into #72 Researcher: no alert fires against live structure without verifying it first.

---

## #77 — #72 refinement — Researcher must STORE research, RE-SCAN, DIFF vs baseline, and LINK changes to the strategies built on them

**Status:** 🔵 open | **Category:** feature | **Source:** developer

**Created:** 2026-06-13

SHARPENS #72 (Researcher) — Bryan clarified 2026-06-14 the core value is PERSISTED, SELF-RE-CHECKING research tied to the strategies it generated. Current state: research_asset is one-shot/ephemeral — the full report is NOT stored (only what Claude hand-copies into coin_strategy_*), and nothing re-scans or diffs it. #72 must explicitly include this loop:

1. STORE — every research_asset pass saved as a timestamped snapshot per asset (research_history table or coin_research_<SYM> preference). Capture: thesis status, dated catalysts, key facts/figures, risks, source refs, live price at time of research.

2. RE-SCAN PERIODICALLY — scheduled re-research per held/watched asset (cadence configurable, e.g. weekly or catalyst-proximity-weighted). On-demand still available.

3. DIFF vs BASELINE — compare new pass to the stored snapshot and surface WHAT CHANGED: catalyst date slipped/confirmed/hit, raise/partnership terms changed, new material news, fundamental/tokenomics shift, price-vs-thesis divergence. Don't just re-report — report the delta.

4. STRATEGY-IMPACT LINK (the key part) — each stored research snapshot is LINKED to the coin_strategy_* plan + specific alert rungs built on it. When a diff materially undermines (or strengthens) the basis for the plan, flag it explicitly, e.g. 'DTCC July date slipped to Q4 → CC July trim-ladder thesis WEAKENED, review $0.178/$0.186' or 'NEAR resharding shipped on schedule → thesis intact.' Tie the finding to the exact rungs/role it affects.

5. NOTIFY → EVALUATE — material strategy-impacting changes fire Telegram notify-only → Bryan brings to PM → Claude proposes adjustment → Bryan approves → update (per daily_strategy_review_cadence). NO auto-exec, NO auto-edit of strategy records.

CONCRETE SEED: today's CC research_asset findings were hand-saved into coin_strategy_CC but the raw report was lost. Under this design that pass would have been stored as the CC baseline and the Oct ladder (R4/R5/R6) explicitly linked to the DTCC Jul/Oct dates + Digital Asset raise — so any future slip auto-flags against those rungs. Guardrails unchanged from #72/#61: no auto-exec, notify-only, source-quality filtering, no affiliate/leverage content.

---

## #78 — README.md front door — proper repo README orienting to ARCHITECTURE.md + live boards (currently empty, 1 title line)

**Status:** ✅ resolved | **Category:** feature | **Source:** developer

**Created:** 2026-06-13 | **Resolved:** 2026-06-13

✅ CLOSED 2026-06-13. Proper front-door README committed (commit f7ae702 'docs: #78 proper front-door README', 36 lines, verified on GitHub). Overwrote the near-empty 1-line placeholder. CONTENTS: what-it-is paragraph (assistant+safety-net framing, owner is sole decision-maker); 3-thread model (PM/Dev/Cowork); stack one-liner; 'where to look' map → ARCHITECTURE.md for how/why, dev_log via get_trading_data for live tickets, git for diffs; safety posture (auto-exec OFF, Telegram-gated, no leverage/stops, node--check); secrets note (Railway env vars, never in repo). Kept pure-docs, README-only commit (caught + corrected a PUSH_NOW.bat bundling issue mid-session — it had staged ARCHITECTURE.md with a stale #73 message; diagnostic confirmed ARCHITECTURE.md untouched, fixed to README-only before push). MAINTENANCE: stable, updates rarely needed (only if stack/thread model changes fundamentally). Can also be added to GitHub→Project-knowledge if desired (same pattern as ARCHITECTURE.md). SIDE NOTE: PUSH_NOW.bat has a recurring 'stale git add + commit message' issue — hardcoded line bundles whatever was last staged. Flagged twice this session (ARCHITECTURE.md + README.md). Should be fixed: either clear the staged files between uses, or parameterise the commit message. Low priority but worth a small cleanup session.

---

## #79 — dev_log → dated CHANGELOG.md export — append-only durable record (guards against log_dev_issue detail-replacement loss)

**Status:** ✅ resolved | **Category:** feature | **Source:** developer

**Created:** 2026-06-13 | **Resolved:** 2026-06-13

FOLLOW-ON to #79 (export_dev_log action works, tool closed). The CHANGELOG.md commit needs a clean local script approach — NOT clipboard paste of 500+ lines, NOT Cowork's network-blocked sandbox calling Railway. SOLUTION: a small Node.js helper script committed to docs/export-changelog.js that Cowork can run locally on the PC (which has outbound network). Script: calls revolut-claude-production.up.railway.app/mcp with the export_dev_log action, parses the JSON response, writes docs/CHANGELOG-YYYY-MM-DD.md with today's date, logs ticket count. Cowork runs it from the repo root, confirms file written, then commits + pushes docs/CHANGELOG-YYYY-MM-DD.md. SEQUENCE: (1) Claude writes the script here, (2) Cowork creates docs/export-changelog.js, (3) Cowork runs it (node docs/export-changelog.js), (4) Cowork commits both the script AND the generated CHANGELOG file. After that, future CHANGELOG snapshots = just 'run the script + commit the output'. Simple, repeatable, no clipboard. Build when convenient — low priority, #79 export tool is the real value.

---

