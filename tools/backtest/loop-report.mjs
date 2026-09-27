// T3: turns loop-grid.mjs output into the tables of reports/loop-backtest-2026-09.md, and runs the extra engine runs the report
// needs (the 1.0% slippage rerun of the top settings, and HIGH's trail study). Every number comes from the extracted live
// runLadderBacktest via loop-grid.mjs; this file only selects, reruns and formats.
//
// Run:  node tools/backtest/loop-report.mjs --held <held.json> --all <all.json> [--out reports/loop-backtest-2026-09]
//   --held  loop-grid output for the nine held coins (live floors, modes A,B,C, walk-forward)
//   --all   loop-grid output for all hourly coins (no floors, modes A,B, walk-forward)
//   prints the markdown tables; --out also writes <out>-results.json (picks, sensitivity, HIGH study, cross-coin summary) and
//   <out>-held.csv (every held-coin grid row).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPrices, findPricesDir } from '../data/load.mjs';
import { makeEngine, runCell, robustPick, median, toCsv, LIVE, liveFloor, DEFAULT_GRID } from './loop-grid.mjs';

const IS = { start: '2025-09-11', end: '2026-05-31 23:59:59' }, OOS = { start: '2026-06-01', end: '2026-09-26 23:59:59' };
const WIN = { in_sample: IS, out_of_sample: OOS };
const fmt = (v, d = 1) => v == null ? 'n/a' : (v > 0 ? '+' : '') + Number(v).toFixed(d) + '%';
const setStr = (s) => s ? s.arm + ' / ' + s.trail + ' / ' + s.sell : 'n/a';
const cls = (r) => r ? ['round_trip', 'churned', 'cash_parked', 'inert'].map(k => r['cyc_' + k] || 0).join(' / ') : 'n/a';
const px = (v) => v == null ? '' : Number(Number(v).toPrecision(4));
const key = (r) => r.arm + '/' + r.trail + '/' + r.sell;

// ---- per held coin -----------------------------------------------------------------------------------------------------------
function heldTables(held) {
  const out = [];
  for (const coin of Object.keys(LIVE)) {
    const live = LIVE[coin], picks = held.picks.filter(p => p.coin === coin);
    out.push('#### ' + coin + '  (live: arm ' + live.arm + '%, trail ' + live.trail + '%, sell ' + live.sell + '%; floor ' + liveFloor(live).toPrecision(6) + ')\n');
    out.push('| Mode | Setting (arm / trail / sell) | Window | vs hold | vs half-cash | Sales | Buy-backs | Cycles RT / CH / CP / IN | Floor blocks | Median sale vs arm | Same-bar sales | Rebound arms |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const p of picks) {
      for (const [label, k] of [['current', 'current'], ['robust pick', 'robust']]) {
        for (const wn of ['in_sample', 'out_of_sample']) {
          const r = p[wn][k];
          out.push('| ' + p.mode + ' | ' + label + ' ' + setStr(r) + ' | ' + (wn === 'in_sample' ? 'IS' : 'OOS') + ' | ' + fmt(r && r.vs_hold_pct) + ' | ' + fmt(r && r.vs_half_cash_pct) + ' | ' +
            (r ? r.sells : 'n/a') + ' | ' + (r ? r.buys : 'n/a') + ' | ' + cls(r) + ' | ' + (r ? r.floor_blocks : 'n/a') + ' | ' + fmt(r && r.med_sale_vs_arm_pct) + ' | ' + (r ? r.same_bar_sales : 'n/a') + ' | ' + (r ? r.rebound_arms : 'n/a') + ' |');
        }
      }
    }
    const b = picks.find(p => p.mode === 'B');
    const cd = (wn) => { const r = b && b[wn].current; return r ? r.c_buys_ok + ' of ' + r.buys : 'n/a'; };
    out.push('| C | cost-anchored | both | not expressible without a server.js change (FINDINGS T3-1) | | | | | | | | |');
    out.push('\nMode-C diagnostic (not a result): of mode B\'s buy-backs at the current setting, ' + cd('in_sample') + ' (IS) and ' + cd('out_of_sample') +
      ' (OOS) had a trough at or above cost x 0.95 = ' + (live.cost * 0.95).toPrecision(6) + ', the line batch 463 ships; the rest would have been blocked.');
    const bc = picks.map(p => p.mode + ': best single cell ' + setStr(p.best_cell) + ' IS ' + fmt(p.in_sample.best_cell && p.in_sample.best_cell.vs_hold_pct) + ', OOS ' + fmt(p.out_of_sample.best_cell && p.out_of_sample.best_cell.vs_hold_pct));
    out.push('For contrast (overfitting check): ' + bc.join('; ') + '.\n');
  }
  return out.join('\n');
}

// the verdict row per coin/mode: did the robust pick beat the current setting OUT of sample?
function verdicts(held) {
  const rows = ['| Coin | Mode | Current | Robust pick (IS) | OOS current vs hold | OOS robust vs hold | Better OOS? |', '|---|---|---|---|---|---|---|'];
  for (const p of held.picks) {
    const c = p.out_of_sample.current, r = p.out_of_sample.robust;
    const d = c && r ? r.vs_hold_pct - c.vs_hold_pct : null;
    rows.push('| ' + p.coin + ' | ' + p.mode + ' | ' + setStr(c) + ' | ' + setStr(p.robust) + ' | ' + fmt(c && c.vs_hold_pct) + ' | ' + fmt(r && r.vs_hold_pct) + ' | ' +
      (d == null ? 'n/a' : Math.abs(d) < 0.5 ? 'same' : d > 0 ? 'yes (' + fmt(d) + ' pts)' : 'no (' + fmt(d) + ' pts)') + ' |');
  }
  return rows.join('\n');
}

// ---- slippage sensitivity: current + robust picks at 1.0% ----------------------------------------------------------------------
async function sensitivity(engine, hourly, held) {
  const rows = [];
  for (const p of held.picks) {
    const live = LIVE[p.coin];
    for (const [label, s] of [['current', { arm: live.arm, trail: live.trail, sell: live.sell }], ['robust', p.robust]]) {
      for (const [wn, w] of Object.entries(WIN)) {
        const at05 = p[wn][label === 'current' ? 'current' : 'robust'];
        const r = await runCell(engine, hourly, { coin: p.coin, start: w.start, end: w.end, setting: s, mode: p.mode, floor: liveFloor(live), slippage: 1.0, cost: live.cost });
        rows.push({ coin: p.coin, mode: p.mode, label, setting: setStr(s), window: wn, vs_hold_05: at05 && at05.vs_hold_pct, vs_hold_10: r.vs_hold_pct, sells_05: at05 && at05.sells, sells_10: r.sells, buys_10: r.buys });
      }
    }
  }
  return rows;
}

// ---- monthly restarts: a fresh $1000 position on the 1st of each month, run to the month's end (more samples than one window,
// where a 100% sale happens at most once). Current vs the robust picks, per month.
const MONTHS = ['2025-09-11', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'];
const monthEnd = (m) => { const d = new Date(Date.parse(m.slice(0, 7) + '-01T00:00:00Z')); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCSeconds(-1); return d.toISOString().slice(0, 19).replace('T', ' '); };
async function monthly(engine, hourly, held) {
  const out = [];
  for (const p of held.picks) {
    const live = LIVE[p.coin], cur = { arm: live.arm, trail: live.trail, sell: live.sell };
    for (const m of MONTHS) {
      const oos = m >= '2026-06-01', end = m === '2026-09-01' ? '2026-09-26 23:59:59' : monthEnd(m);
      const a = await runCell(engine, hourly, { coin: p.coin, start: m, end, setting: cur, mode: p.mode, floor: liveFloor(live) });
      const b = await runCell(engine, hourly, { coin: p.coin, start: m, end, setting: p.robust, mode: p.mode, floor: liveFloor(live) });
      if (!a.ok || !b.ok) continue;
      out.push({ coin: p.coin, mode: p.mode, month: m.slice(0, 7), oos, current: a.vs_hold_pct, robust: b.vs_hold_pct, current_sells: a.sells, robust_sells: b.sells });
    }
  }
  return out;
}
function monthlyTable(rows) {
  const t = ['| Coin | Mode | IS months: robust better / worse / same | OOS months: robust better / worse / same | OOS months where current sold | OOS months where robust sold |', '|---|---|---|---|---|---|'];
  const g = new Map(); for (const r of rows) { const k = r.coin + ' ' + r.mode; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  const bws = (a) => [a.filter(r => r.robust > r.current + 0.5).length, a.filter(r => r.robust < r.current - 0.5).length, a.filter(r => Math.abs(r.robust - r.current) <= 0.5).length].join(' / ');
  for (const [k, a] of g) { const [coin, mode] = k.split(' '), i = a.filter(r => !r.oos), o = a.filter(r => r.oos);
    t.push('| ' + coin + ' | ' + mode + ' | ' + bws(i) + ' | ' + bws(o) + ' | ' + o.filter(r => r.current_sells > 0).length + ' / ' + o.length + ' | ' + o.filter(r => r.robust_sells > 0).length + ' / ' + o.length + ' |'); }
  return t.join('\n');
}

// ---- HIGH: is the 9% trail too tight? ------------------------------------------------------------------------------------------
async function highStudy(engine, hourly) {
  const live = LIVE.HIGH, floor = liveFloor(live), trails = DEFAULT_GRID.trail, out = { pump_26sep: [], windows: [] };
  // the 26 Sep pump alone: a fresh $1000 position from 25 Sep 12:00 UTC (runLadderBacktest needs 24 bars; the 26 Sep 17:00 spike is the first arm), arm 25, each trail
  for (const trail of trails) {
    const r = await runCell(engine, hourly, { coin: 'HIGH', start: '2026-09-25 12:00', end: '2026-09-26 23:59:59', setting: { arm: 25, trail, sell: 100 }, mode: 'A', floor, keepFills: true });
    const s = (r.fills || []).find(f => f.leg === 'sell');
    out.pump_26sep.push({ trail, sold_at: s ? s.at : null, price: s ? px(s.price) : null, vs_hold_pct: r.vs_hold_pct });
  }
  // arm 25, every trail, both windows, modes A and B
  for (const [wn, w] of Object.entries(WIN)) for (const mode of ['A', 'B']) for (const trail of trails) {
    const r = await runCell(engine, hourly, { coin: 'HIGH', start: w.start, end: w.end, setting: { arm: 25, trail, sell: 100 }, mode, floor, cost: live.cost, keepFills: true });
    out.windows.push({ window: wn, mode, trail, vs_hold_pct: r.vs_hold_pct, vs_half_cash_pct: r.vs_half_cash_pct, sells: r.sells, buys: r.buys,
      first_sale: (r.fills || []).filter(f => f.leg === 'sell').map(f => f.at + ' @ ' + px(f.price))[0] || null, med_sale_vs_arm_pct: r.med_sale_vs_arm_pct, med_cycle_vs_hold_pct: r.med_cycle_vs_hold_pct });
  }
  return out;
}

// ---- cross-coin: one profile, or per coin? -------------------------------------------------------------------------------------
function crossCoin(all) {
  const grid = all.grid, res = {};
  for (const mode of ['A', 'B']) {
    const rows = all.rows.filter(r => r.mode === mode && r.ok);
    const by = new Map();   // coin -> window -> key -> row
    for (const r of rows) { if (!by.has(r.coin)) by.set(r.coin, { in_sample: new Map(), out_of_sample: new Map() }); by.get(r.coin)[r.window_name].set(key(r), r); }
    const coins = [...by.keys()].filter(c => by.get(c).in_sample.size && by.get(c).out_of_sample.size);
    const cells = [];
    for (const sell of grid.sell) for (const arm of grid.arm) for (const trail of grid.trail) {
      const k = arm + '/' + trail + '/' + sell, get = (wn, f) => coins.map(c => by.get(c)[wn].get(k)).filter(Boolean).map(f);
      cells.push({ arm, trail, sell, value: median(get('in_sample', r => r.vs_hold_pct)), is_hc: median(get('in_sample', r => r.vs_half_cash_pct)),
        oos: median(get('out_of_sample', r => r.vs_hold_pct)), oos_hc: median(get('out_of_sample', r => r.vs_half_cash_pct)),
        oos_beat_hold: get('out_of_sample', r => r.vs_hold_pct > 0).filter(Boolean).length, oos_sold: get('out_of_sample', r => r.sells > 0).filter(Boolean).length, n: coins.length });
    }
    const one = robustPick(cells, grid).best_robust;
    const oneCell = cells.find(c => c.arm === one.arm && c.trail === one.trail && c.sell === one.sell);
    // per-coin robust picks (IS) scored OOS, against the one profile OOS on the same coin
    const per = coins.map(c => {
      const isCells = [...by.get(c).in_sample.values()].map(r => ({ arm: r.arm, trail: r.trail, sell: r.sell, value: r.vs_hold_pct }));
      const pk = robustPick(isCells, grid).best_robust, pr = by.get(c).out_of_sample.get(key(pk)), po = by.get(c).out_of_sample.get(key(one));
      return { coin: c, pick: setStr(pk), oos_pick: pr ? pr.vs_hold_pct : null, oos_one: po ? po.vs_hold_pct : null, oos_pick_hc: pr ? pr.vs_half_cash_pct : null, oos_one_hc: po ? po.vs_half_cash_pct : null };
    });
    const named = [[25, 9, 100], [40, 10, 100], [20, 6, 50], [50, 20, 50], [15, 5, 100], [30, 15, 100]].map(([arm, trail, sell]) => cells.find(c => c.arm === arm && c.trail === trail && c.sell === sell));
    const pickCounts = {}; for (const p of per) pickCounts[p.pick] = (pickCounts[p.pick] || 0) + 1;
    res[mode] = { coins: coins.length, one_profile: oneCell, named, per_coin: per,
      per_coin_beats_one_oos: per.filter(p => p.oos_pick != null && p.oos_one != null && p.oos_pick > p.oos_one + 0.5).length,
      one_beats_per_coin_oos: per.filter(p => p.oos_pick != null && p.oos_one != null && p.oos_one > p.oos_pick + 0.5).length,
      median_oos_per_coin: median(per.map(p => p.oos_pick)), median_oos_one: median(per.map(p => p.oos_one)),
      median_oos_hc_per_coin: median(per.map(p => p.oos_pick_hc)), median_oos_hc_one: median(per.map(p => p.oos_one_hc)),
      distinct_picks: Object.keys(pickCounts).length, top_picks: Object.entries(pickCounts).sort((a, b) => b[1] - a[1]).slice(0, 5) };
  }
  return res;
}
function crossTables(cc) {
  const out = [];
  for (const mode of ['A', 'B']) {
    const x = cc[mode];
    out.push('**Mode ' + mode + ' (' + (mode === 'A' ? 'sell only' : 'engine buy-back') + '), ' + x.coins + ' coins with data in both windows, no floor:**\n');
    out.push('| Profile (arm / trail / sell) | IS median vs hold | IS median vs half-cash | OOS median vs hold | OOS median vs half-cash | OOS coins that sold | OOS coins beating hold |');
    out.push('|---|---|---|---|---|---|---|');
    const line = (c, tag) => '| ' + tag + setStr(c) + ' | ' + fmt(c.value) + ' | ' + fmt(c.is_hc) + ' | ' + fmt(c.oos) + ' | ' + fmt(c.oos_hc) + ' | ' + c.oos_sold + ' / ' + c.n + ' | ' + c.oos_beat_hold + ' / ' + c.n + ' |';
    out.push(line(x.one_profile, 'best robust single profile: '));
    for (const c of x.named) out.push(line(c, ''));
    out.push('\nPer-coin robust picks (chosen in-sample, scored out-of-sample): median OOS vs hold ' + fmt(x.median_oos_per_coin) + ' (vs half-cash ' + fmt(x.median_oos_hc_per_coin) +
      ') against ' + fmt(x.median_oos_one) + ' (' + fmt(x.median_oos_hc_one) + ') for the single profile on the same coins. The per-coin pick did better OOS on ' + x.per_coin_beats_one_oos +
      ' coins, worse on ' + x.one_beats_per_coin_oos + ', the same on the rest. ' + x.distinct_picks + ' different per-coin picks; the most common: ' + x.top_picks.map(([k, n]) => k + ' (' + n + ')').join(', ') + '.\n');
  }
  return out.join('\n');
}

async function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const held = JSON.parse(readFileSync(opt('--held'), 'utf8')), all = opt('--all') ? JSON.parse(readFileSync(opt('--all'), 'utf8')) : null;
  const { hourly } = loadPrices(findPricesDir(opt('--dir')), { tables: ['hourly'] });
  const engine = makeEngine(hourly);
  const mon = await monthly(engine, hourly, held);
  const sens = await sensitivity(engine, hourly, held), high = await highStudy(engine, hourly), cc = all ? crossCoin(all) : null;
  const md = [];
  md.push('## Verdicts (out-of-sample, robust pick vs current)\n', verdicts(held), '\n## Per held coin\n', heldTables(held));
  md.push('\n## Monthly restarts (fresh $1000 each month; robust pick vs current, vs hold)\n', monthlyTable(mon));
  md.push('\n## Slippage 1.0% (current and robust picks)\n', '| Coin | Mode | Setting | Window | vs hold @0.5% | vs hold @1.0% | Sales @1.0% | Buy-backs @1.0% |', '|---|---|---|---|---|---|---|---|');
  for (const r of sens) md.push('| ' + [r.coin, r.mode, r.label + ' ' + r.setting, r.window === 'in_sample' ? 'IS' : 'OOS', fmt(r.vs_hold_05), fmt(r.vs_hold_10), r.sells_10, r.buys_10].join(' | ') + ' |');
  md.push('\n## HIGH: the 26 Sep pump, arm 25, sell 100, each trail (fresh $1000 from 25 Sep 12:00 UTC)\n', '| Trail | Sold at (UTC, hour bar) | Price | vs hold at 26 Sep 23:00 |', '|---|---|---|---|');
  for (const r of high.pump_26sep) md.push('| ' + r.trail + '% | ' + (r.sold_at || 'no sale') + ' | ' + px(r.price) + ' | ' + fmt(r.vs_hold_pct) + ' |');
  md.push('\n## HIGH: arm 25, sell 100, each trail\n', '| Window | Mode | Trail | vs hold | vs half-cash | Sales | Buy-backs | First sale | Median sale vs arm | Median cycle vs hold (14 d) |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of high.windows) md.push('| ' + [r.window === 'in_sample' ? 'IS' : 'OOS', r.mode, r.trail + '%', fmt(r.vs_hold_pct), fmt(r.vs_half_cash_pct), r.sells, r.buys, r.first_sale || 'none', fmt(r.med_sale_vs_arm_pct), fmt(r.med_cycle_vs_hold_pct)].join(' | ') + ' |');
  if (cc) md.push('\n## Cross-coin\n', crossTables(cc));
  console.log(md.join('\n'));
  if (opt('--out')) {
    const slim = (r) => r && Object.fromEntries(Object.entries(r).filter(([k]) => !['start', 'end', 'window', 'floor'].includes(k)));
    const picks = held.picks.map(p => ({ coin: p.coin, mode: p.mode, robust: p.robust, best_cell: p.best_cell,
      in_sample: Object.fromEntries(Object.entries(p.in_sample).map(([k, v]) => [k, slim(v)])), out_of_sample: Object.fromEntries(Object.entries(p.out_of_sample).map(([k, v]) => [k, slim(v)])) }));
    writeFileSync(opt('--out') + '-results.json', JSON.stringify({ generated_at: new Date().toISOString(), data: held.data, grid: held.grid, windows: WIN, slippage: held.slippage, c_note: held.c_note,
      picks, monthly: mon, sensitivity_1pct: sens, high, cross_coin: cc }, null, 1));
    writeFileSync(opt('--out') + '-held.csv', toCsv(held.rows.filter(r => r.ok).map(slim)));
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(e => { console.error('loop-report FAILED: ' + (e.stack || e.message)); process.exit(1); });
}
