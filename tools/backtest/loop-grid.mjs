// T3: pump-loop settings grid, offline, on the exported hourly price history (read-only research).
// It runs the LIVE backtest engine: runLadderBacktest and everything it calls (shadowNewState, shadowEvalTier, shadowEvalLadder,
// btComputeMetrics) are extracted from server.js BY NAME (tests/lib.mjs) and run in a strict vm sandbox. Nothing is rewritten.
// The sandbox gets a stub db that answers runLadderBacktest's hourly SELECT from the export; any other query fails loudly and is
// named (runLadderBacktest sends no other query for source 'hourly' without a _profile, which this tool refuses).
//
// Buy-back modes, always reported SEPARATELY (never blended):
//   A sell_only     proceeds stay cash to the end (what live has done: 8 loop sales, 0 automatic buy-backs). Expressed by
//                   CONFIGURATION only: abandon_hours 0, so the engine abandons the buy-back on the first bar after a sale. The
//                   driver checks every mode-A run for zero buys and throws if one appears.
//   B as_engine     the engine's own retrace/bounce buy-back: retrace 50, bounce 8 (the live armReboundTracker defaults), the
//                   engine's defaults for the rest (buy_pct 70, further_drop 10, ceiling 15, abandon 48 h).
//   C cost_anchored mode B plus the batch-463 safety line: a buy-back only if the trough stayed at or above cost x 0.95, through
//                   the engine's buyback_floor option (T3-1, added with 463). It needs a real cost, so it runs for the held coins
//                   (LIVE) only. On a server.js without that option the driver refuses C (it would silently equal B). Mode B still
//                   carries the old diagnostic (how many B buy-backs had a trough at or above the line).
// Common to all modes: rule_mode 'ladder', max_legs 1 (one sale per arm, as live), retention_floor_pct 0 (live has none; the
// engine's ladder default of 50 would trim a 100% sale), fee 0.09%, entry_floor = the live floor, $1000 of the coin at the window's
// first close.
//
// Run:  node tools/backtest/loop-grid.mjs --coins held|all|AST,HIGH --grid '{"arm":[25],"trail":[9],"sell":[100]}' \
//         [--start 2025-09-11 --end 2026-05-31] [--split 2026-06-01 --end2 2026-09-26] [--buyback A,B,C] [--slippage 0.5]
//         [--floors live|none] [--out reports/x]   (writes x.json and x.csv)
//   --split  walk-forward: --start..--end is in-sample, --split..--end2 is out-of-sample; picks are made on in-sample only.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readServer, extractFunction, strictSandbox } from '../../tests/lib.mjs';
import { loadPrices, findPricesDir } from '../data/load.mjs';

export const FUNCS = ['shadowNewState', 'shadowEvalLadder', 'shadowEvalTier', 'btComputeMetrics', 'runLadderBacktest'];

// The nine held, enabled loops today (brief T3). cost = real average cost; floor = max(cost x 1.005, stored floor).
export const LIVE = {
  AST: { arm: 45, window: 1440, trail: 10, sell: 100, cost: 0.00641474 },
  CC: { arm: 65, window: 1440, trail: 6, sell: 50, cost: 0.133443, stored_floor: 0.134678 },
  COTI: { arm: 40, window: 1440, trail: 10, sell: 100, cost: 0.0170951 },
  DASH: { arm: 25, window: 1440, trail: 8, sell: 100, cost: 63.0314 },
  HFT: { arm: 20, window: 1440, trail: 9, sell: 100, cost: 0.00631759 },
  HIGH: { arm: 25, window: 1440, trail: 9, sell: 100, cost: 0.0336424 },
  HONEY: { arm: 40, window: 1440, trail: 12, sell: 100, cost: 0.0013567 },
  IDEX: { arm: 25, window: 1440, trail: 9, sell: 100, cost: 0.000950986 },
  JTO: { arm: 40, window: 1440, trail: 25, sell: 50, cost: 0.493296 },
};
export const liveFloor = (c) => Math.max(c.cost * 1.005, c.stored_floor || 0);
export const MODES = {
  A: { name: 'sell_only', opts: { abandon_hours: 0 } },
  B: { name: 'as_engine', opts: { retrace_pct: 50, bounce_pct: 8 } },
  C: { name: 'cost_anchored', opts: { retrace_pct: 50, bounce_pct: 8 }, line_of_cost: 0.95 },   // + buyback_floor = cost x 0.95 per cell
};
export const C_NOTE = 'not expressible without a server.js change (tests/FINDINGS.md T3-1)';
// T3-1: does this server.js's engine have the absolute buy-back line (463)? Without it mode C would silently run as mode B.
export const engineHasBuybackFloor = (src = readServer()) => /buybackFloor: Number\(cfg\.buyback_floor\)/.test(src) && /buyback_floor: Number\(opts\.buyback_floor\)/.test(src);
export const DEFAULT_GRID = { arm: [15, 20, 25, 30, 40, 50, 65], trail: [5, 6, 8, 9, 10, 12, 15, 20, 25], sell: [50, 100], window: 1440 };

// The live code, extracted by name. src: server.js text (default: this checkout's).
export function extractLoopCode(src = readServer()) { return FUNCS.map(f => extractFunction(src, f)).join('\n'); }

const norm = (q) => String(q).replace(/\s+/g, ' ').trim();
export const Q_HOURLY = 'SELECT hour_bucket AS t, open_px AS o, high_px AS h, low_px AS l, close_px AS c FROM price_intraday_hourly WHERE symbol = ? AND hour_bucket >= ? AND hour_bucket <= ? ORDER BY hour_bucket ASC';
// MySQL compares a DATETIME column with a 'YYYY-MM-DD[ HH:MM[:SS]]' string as that datetime (the server runs in UTC).
export function sqlTime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s));
  if (!m) throw new Error('stub db: cannot read the time ' + JSON.stringify(s) + ' (want YYYY-MM-DD[ HH:MM[:SS]])');
  return Date.parse(m[1] + 'T' + (m[2] || '00') + ':' + (m[3] || '00') + ':' + (m[4] || '00') + 'Z');
}

// hourly: Map symbol -> [{t (unix s), o, h, l, c}] oldest first. Returns { db, unknown }; unknown[] records every query the stub
// could not answer (the query is also rejected).
export function makeStubDb(hourly) {
  const unknown = [];
  const answer = (sql, p) => {
    if (sql === Q_HOURLY) {
      if (p.length !== 3) throw new Error('stub db: expected [symbol, start, end], got ' + JSON.stringify(p));
      const rows = hourly.get(p[0]);
      if (!rows) return [[]];   // MySQL returns no rows for an unknown symbol; runLadderBacktest then says 'insufficient bars'
      const a = sqlTime(p[1]) / 1000, b = sqlTime(p[2]) / 1000;
      return [rows.filter(r => r.t >= a && r.t <= b).map(r => ({ t: new Date(r.t * 1000), o: r.o, h: r.h, l: r.l, c: r.c }))];
    }
    return undefined;
  };
  const db = {
    execute(q, p = []) {
      const sql = norm(q);
      let a;
      try { a = answer(sql, p); } catch (e) { unknown.push(sql + ' ' + JSON.stringify(p) + ': ' + e.message); return Promise.reject(e); }
      if (a === undefined) {
        unknown.push(sql);
        return Promise.reject(new Error('stub db does not answer this query (tools/backtest/loop-grid.mjs makeStubDb): ' + sql));
      }
      return Promise.resolve(a);
    },
  };
  return { db, unknown };
}

// The extracted engine bound to a stub db over `hourly`. backtest(opts) = the live runLadderBacktest(opts), plus the loud checks.
// A read-only TAP is installed on shadowEvalTier (runLadderBacktest's per-bar call): it passes every argument and the result through
// unchanged and only copies out.fills, because runLadderBacktest returns metrics but not the fills (the dates and trigger prices the
// report and the mode-C diagnostic need). The tap is the only code added to the sandbox.
export const TAP = 'const __evalTier = shadowEvalTier; var __tap = null;\n' +
  'shadowEvalTier = function (state, bar, cfg, ctx) { const o = __evalTier(state, bar, cfg, ctx); if (__tap) __tap(o.fills); return o; };\n' +
  'function __setTap(f) { __tap = f; }';
export function makeEngine(hourly, { src } = {}) {
  const { db, unknown } = makeStubDb(hourly);
  const errors = [];
  const api = strictSandbox({ db, console: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) } },
    extractLoopCode(src) + '\n' + TAP, ['runLadderBacktest', 'shadowEvalLadder', 'shadowNewState', 'btComputeMetrics', '__setTap']);
  const backtest = async (opts, { fills = null } = {}) => {
    if (opts._profile) throw new Error('loop-grid does not run _profile backtests (profileCfgFor needs the daily table and is not extracted)');
    api.__setTap(fills ? (f) => { for (const x of f) fills.push(x); } : null);
    let out;
    try { out = await api.runLadderBacktest(opts); } finally { api.__setTap(null); }
    if (unknown.length) throw new Error('the live runLadderBacktest asked for something the stub db does not answer:\n  ' + unknown.join('\n  '));
    if (errors.length) throw new Error('the live runLadderBacktest reported an error:\n  ' + errors.join('\n  '));
    return out;
  };
  return { backtest, api, unknown };
}

// The options one grid cell sends to runLadderBacktest.
export function cellOpts({ coin, start, end, setting, mode, floor, slippage, initialQty, fee = 0.09, cost = null, cSupported = false }) {
  if (!MODES[mode]) throw new Error('mode ' + mode + ': unknown (A, B or C)');
  if (mode === 'C' && !cSupported) throw new Error('mode C: ' + C_NOTE);
  if (mode === 'C' && !(Number(cost) > 0)) throw new Error('mode C needs a real cost (the held coins in LIVE only)');
  const extra = mode === 'C' ? { buyback_floor: Number(cost) * MODES.C.line_of_cost } : {};
  return Object.assign({
    symbol: coin + '-USD', source: 'hourly', start, end, rule_mode: 'ladder',
    arm_pump_pct: setting.arm, arm_window_min: setting.window || 1440, trail_pct: setting.trail, sell_pct: setting.sell,
    entry_floor: floor == null ? null : floor, fee_pct: fee, slippage_pct: slippage,
    initial_qty: initialQty, initial_usd: 0, retention_floor_pct: 0, max_legs: 1,
  }, MODES[mode].opts, extra);
}

const CLS = ['round_trip', 'churned', 'cash_parked', 'inert'];
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
// One cell: runs the engine and keeps what the report needs. cost (mode B) feeds the mode-C diagnostic; keepFills keeps the
// filled sales / buys and the per-cycle rows.
export async function runCell(engine, hourly, { coin, start, end, setting, mode, floor = null, slippage = 0.5, cost = null, keepFills = false, cSupported = false }) {
  const rows = hourly.get(coin + '-USD') || [];
  const a = sqlTime(start) / 1000, first = rows.find(r => r.t >= a);
  const initialQty = first ? 1000 / first.c : 1000;
  const fills = [];
  const out = await engine.backtest(cellOpts({ coin, start, end, setting, mode, floor, slippage, initialQty, cost, cSupported }), { fills });
  const base = { coin, mode, start, end, arm: setting.arm, trail: setting.trail, sell: setting.sell, window: setting.window || 1440, slippage, floor };
  if (!out.ok) return Object.assign(base, { ok: false, error: out.error });
  const m = out.metrics, cyc = m.cycles || [];
  if (mode === 'A' && m.buys_filled > 0) throw new Error('mode A (sell_only) bought back on ' + coin + ' ' + JSON.stringify(setting) + ': abandon_hours 0 no longer stops the buy-back');
  const done = fills.filter(f => f.would_have_filled);
  if (done.filter(f => f.leg === 'sell').length !== m.sells_filled || done.filter(f => f.leg === 'buy').length !== m.buys_filled) throw new Error('tap and metrics disagree on ' + coin);
  const r = Object.assign(base, {
    ok: true, bars: out.window.bars, price_change_pct: out.price.change_pct,
    vs_hold_pct: m.vs_hold_pct, vs_half_cash_pct: m.vs_half_cash_pct, end_qty_pct: m.end_qty_pct_of_start,
    sells: m.sells_filled, buys: m.buys_filled, arms: cyc.length, floor_blocks: (m.blocked_by_reason || {}).below_entry_floor || 0,
    buyback_line_blocks: (m.blocked_by_reason || {}).below_buyback_floor || 0,   // T3-1 mode C: buy-backs the 463 line refused
    cost_drag_pct: m.cost_drag_pct_of_hold,
  });
  for (const k of CLS) r['cyc_' + k] = cyc.filter(c => c.cls === k).length;
  // Two hourly-bar diagnostics (read tests/FINDINGS.md T3-3 / T3-4; they count, they do not change anything):
  //   same_bar_sales  sales in the bar that also set the peak: shadowEvalLadder raises the peak to the bar's high and then tests the
  //                   bar's low against it, so a bar whose range exceeds the trail sells - at the open when the open is below the
  //                   stop - although the high may have come after the low
  //   rebound_arms    arms whose arm price was still below the highest close of the 24 hours before (the engine arms from the
  //                   rolling low, so a rebound after a crash arms; live checkPumpArm measures from the price at the window start)
  const byT = new Map(rows.map(x => [x.t * 1000, x]));
  r.same_bar_sales = done.filter(f => f.leg === 'sell').filter(f => { const b = byT.get(f.t); return b && Math.abs(f.trigger_price - b.h * (1 - setting.trail / 100)) <= b.h * 1e-9; }).length;
  r.rebound_arms = cyc.filter(c => { const t = Date.parse(c.armed_at + ':00Z') / 1000; const prev = rows.filter(x => x.t < t && x.t >= t - 86400); return prev.length && c.arm_price < Math.max(...prev.map(x => x.c)); }).length;
  // per-sale quality from the engine's own per-cycle measures (#381): sale price vs the arm price, and the whole cycle vs holding to
  // its evaluation point (close + 14 days, the next arm, or the end of the data) - medians over the cycles that sold
  const sold = cyc.filter(c => c.cls !== 'inert');
  r.med_sale_vs_arm_pct = median(sold.map(c => c.sale_vs_arm_pct)); r.med_cycle_vs_hold_pct = median(sold.map(c => c.cycle_vs_hold_pct));
  if (mode === 'B' && cost != null) {
    // Mode-C diagnostic (NOT a result): each filled buy's trough = trigger / (1 + bounce). The batch-463 line allows a buy-back
    // only if the trough stayed at or above cost x 0.95.
    const line = cost * 0.95, b = done.filter(f => f.leg === 'buy');
    r.c_line = line; r.c_buys_ok = b.filter(f => f.trigger_price / 1.08 >= line * (1 - 1e-9)).length; r.c_buys_blocked = b.length - r.c_buys_ok;
  }
  if (keepFills) {
    r.fills = done.map(f => ({ at: iso(f.t), leg: f.leg, price: f.price, trigger: f.trigger_price, usd: f.intended_usd, cycle: f.cycle_id }));
    r.cycles = cyc.map(c => ({ cycle: c.cycle, armed_at: c.armed_at, arm_price: c.arm_price, cls: c.cls, outcome: c.outcome, sale_vs_arm_pct: c.sale_vs_arm_pct,
      buyback_edge_pct: c.buyback_edge_pct, cycle_vs_hold_pct: c.cycle_vs_hold_pct, truncated: c.truncated }));
  }
  return r;
}

export function gridSettings(g) {
  const out = [];
  for (const sell of g.sell) for (const arm of g.arm) for (const trail of g.trail) out.push({ arm, trail, sell, window: g.window || 1440 });
  return out;
}

const median = (a) => { const s = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); if (!s.length) return null; const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
export { median };
// ROBUST pick on the arm x trail plane for each sell_pct: score = median of the cell's 3x3 neighbourhood (clipped at the grid edge).
// Highest score wins; ties go to the higher own value, then to the setting closest to `current` (fewest grid steps).
// cells: [{arm, trail, sell, value}]. Returns { best_robust, best_cell, scores } (value = the metric, e.g. in-sample vs_hold).
export function robustPick(cells, grid, current = null) {
  const at = new Map(cells.map(c => [c.arm + '/' + c.trail + '/' + c.sell, c.value]));
  const idx = (arr, v) => arr.indexOf(v);
  const dist = (c) => !current ? 0 : Math.abs(idx(grid.arm, c.arm) - idx(grid.arm, nearest(grid.arm, current.arm))) + Math.abs(idx(grid.trail, c.trail) - idx(grid.trail, nearest(grid.trail, current.trail))) + (c.sell === current.sell ? 0 : 1);
  const scores = cells.map(c => {
    const i = idx(grid.arm, c.arm), j = idx(grid.trail, c.trail), nb = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const a = grid.arm[i + di], t = grid.trail[j + dj];
      if (a == null || t == null) continue;
      const v = at.get(a + '/' + t + '/' + c.sell);
      if (v != null) nb.push(v);
    }
    return Object.assign({}, c, { score: median(nb), n: nb.length });
  });
  const cmp = (x, y) => (y.score - x.score) || (y.value - x.value) || (dist(x) - dist(y));
  const best_robust = scores.filter(s => s.score != null).sort(cmp)[0] || null;
  const best_cell = cells.filter(c => c.value != null).slice().sort((x, y) => (y.value - x.value) || (dist(x) - dist(y)))[0] || null;
  return { best_robust, best_cell, scores };
}
const nearest = (arr, v) => arr.reduce((b, x) => Math.abs(x - v) < Math.abs(b - v) ? x : b, arr[0]);

export function toCsv(rows) {
  const cols = [...new Set(rows.flatMap(r => Object.keys(r).filter(k => typeof r[k] !== 'object' || r[k] === null)))];
  const q = (v) => v == null ? '' : (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  return [cols.join(','), ...rows.map(r => cols.map(k => q(r[k])).join(','))].join('\n') + '\n';
}

// CLI ------------------------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  return o;
}
const dayEnd = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + ' 23:59:59' : d;

async function main(argv) {
  const o = parseArgs(argv), t0 = Date.now();
  const dir = findPricesDir(o.dir || null);
  const { hourly, manifest } = loadPrices(dir, { tables: ['hourly'] });
  console.error('data: ' + dir + ' (exported ' + manifest.exported_at + ', server ' + manifest.server_sha + ', ' + hourly.size + ' hourly symbols)');
  const coins = !o.coins || o.coins === 'held' ? Object.keys(LIVE) : o.coins === 'all' ? [...hourly.keys()].map(s => s.replace(/-USD$/, '')).sort() : String(o.coins).split(',');
  const grid = Object.assign({}, DEFAULT_GRID, o.grid ? JSON.parse(o.grid) : {});
  const modes = String(o.buyback || 'A,B,C').split(',');
  const slippage = o.slippage != null ? Number(o.slippage) : 0.5;
  const floors = o.floors || 'live';
  const windows = [{ name: 'in_sample', start: o.start || '2025-09-11', end: dayEnd(o.end || (o.split ? '2026-05-31' : '2026-09-26')) }];
  if (o.split) windows.push({ name: 'out_of_sample', start: o.split, end: dayEnd(o.end2 || '2026-09-26') });
  const engine = makeEngine(hourly);
  const cSupported = engineHasBuybackFloor();
  const settings = gridSettings(grid), rows = [], picks = [];
  for (const coin of coins) {
    const live = LIVE[coin] || null;
    const floor = floors === 'live' && live ? liveFloor(live) : null;
    const cur = live ? { arm: live.arm, trail: live.trail, sell: live.sell, window: live.window } : null;
    for (const mode of modes) {
      if (mode === 'C' && !cSupported) { rows.push({ coin, mode: 'C', ok: false, error: C_NOTE }); continue; }
      if (mode === 'C' && !live) { rows.push({ coin, mode: 'C', ok: false, error: 'no cost for this coin (mode C runs for the held coins only)' }); continue; }
      const byWin = {};
      for (const w of windows) {
        const list = settings.concat(cur && !settings.some(s => s.arm === cur.arm && s.trail === cur.trail && s.sell === cur.sell) ? [cur] : []);
        byWin[w.name] = [];
        for (const s of list) {
          const r = await runCell(engine, hourly, { coin, start: w.start, end: w.end, setting: s, mode, floor, slippage, cost: live ? live.cost : null, cSupported });
          r.window_name = w.name; r.is_current = !!(cur && s.arm === cur.arm && s.trail === cur.trail && s.sell === cur.sell);
          rows.push(r); byWin[w.name].push(r);
        }
      }
      const is = byWin.in_sample.filter(r => r.ok && grid.arm.includes(r.arm) && grid.trail.includes(r.trail));
      if (!is.length) continue;
      const p = robustPick(is.map(r => ({ arm: r.arm, trail: r.trail, sell: r.sell, value: r.vs_hold_pct })), grid, cur);
      const find = (wn, s) => s && (byWin[wn] || []).find(r => r.arm === s.arm && r.trail === s.trail && r.sell === s.sell) || null;
      const pick = { coin, mode, robust: p.best_robust && { arm: p.best_robust.arm, trail: p.best_robust.trail, sell: p.best_robust.sell, score: p.best_robust.score }, best_cell: p.best_cell && { arm: p.best_cell.arm, trail: p.best_cell.trail, sell: p.best_cell.sell } };
      for (const wn of Object.keys(byWin)) pick[wn] = { current: find(wn, cur), robust: find(wn, pick.robust), best_cell: find(wn, pick.best_cell) };
      picks.push(pick);
    }
    console.error(coin + ' done (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
  }
  const res = { generated_at: new Date().toISOString(), data: { dir, exported_at: manifest.exported_at, server_sha: manifest.server_sha }, grid, windows, slippage, floors, modes, c_note: cSupported ? 'mode C runs: buyback_floor = cost x 0.95 (463)' : C_NOTE, picks, rows };
  if (o.out) {
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out + '.json', JSON.stringify(res));
    writeFileSync(o.out + '.csv', toCsv(rows));
    console.error('wrote ' + o.out + '.json / .csv (' + rows.length + ' rows, ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
  } else console.log(JSON.stringify({ picks }, null, 1));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(e => { console.error('loop-grid FAILED: ' + e.message); process.exit(1); });
}
