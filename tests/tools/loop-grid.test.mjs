// T3 tools/backtest/loop-grid.mjs: the offline driver runs the LIVE runLadderBacktest (extracted from server.js by name) on exported
// hourly data. Parity: on small synthetic series its output deep-equals the extracted runLadderBacktest run in its own sandbox on
// the same bars (no stub filtering, no tap). Mode A never buys back; mode B does; the floor blocks a sale; C cannot run; the robust
// pick prefers a plateau to a lone spike. A query or helper the stubs do not provide fails loudly, naming it.
// Run: node tests/tools/loop-grid.test.mjs
import assert from 'node:assert/strict';
import { runner, readServer, extractFunction, strictSandbox, plain } from '../lib.mjs';
import { makeEngine, makeStubDb, runCell, cellOpts, robustPick, extractLoopCode, sqlTime, FUNCS, Q_HOURLY, MODES } from '../../tools/backtest/loop-grid.mjs';
import { series, flat, walk, toMap, T0, H } from './fixtures.mjs';

const { test, report } = runner('T3 tools: offline loop settings grid (tests/tools/loop-grid.test.mjs)');
const SRC = readServer();
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ');

// A pump from 1.0 to 1.5, a 13% drop through a 9% trail, a slide to 0.9 (through the 50% retrace gate), an 8% bounce, then 1.2.
const pumpDump = () => flat(48, 1).concat([1.1, 1.2, 1.3, 1.4, 1.5], flat(5, 1.5), [1.3], flat(5, 1.2), [1.05, 0.95, 0.9, 0.9, 0.99], flat(60, 1.2));
const DATA = toMap([
  ...series('PD-USD', pumpDump()),
  ...series('RW-USD', walk(1500, 5), { wick: (i, c) => (i % 83 === 7 ? c * 0.85 : null) }),
  ...series('RW2-USD', walk(1200, 9)),
]);
const START = iso(T0), END = iso(T0 + 3000 * H);

// the oracle: runLadderBacktest and its helpers straight from server.js, in their own sandbox, with a db that just returns the bars
function oracle(bars) {
  const db = { execute: async () => [bars.map(r => ({ t: new Date(r.t * 1000), o: r.o, h: r.h, l: r.l, c: r.c }))] };
  const api = strictSandbox({ db }, FUNCS.map(f => extractFunction(SRC, f)).join('\n'), ['runLadderBacktest']);
  return (opts) => api.runLadderBacktest(opts);
}
const slice = (sym, a, b) => DATA.get(sym).filter(r => r.t >= sqlTime(a) / 1000 && r.t <= sqlTime(b) / 1000);

const engine = makeEngine(DATA);
const SETTINGS = [{ arm: 20, trail: 9, sell: 100 }, { arm: 15, trail: 5, sell: 50 }, { arm: 40, trail: 12, sell: 100 }, { arm: 25, trail: 20, sell: 50 }];

await test('LG1', 'parity: for modes A and B and four settings on three coins (full and part windows), the driver equals the extracted runLadderBacktest', async () => {
  let n = 0;
  for (const sym of ['PD-USD', 'RW-USD', 'RW2-USD']) for (const [a, b] of (sym === 'PD-USD' ? [[START, END]] : [[START, END], [iso(T0 + 200 * H), iso(T0 + 900 * H)]])) {
    const bars = slice(sym, a, b), run = oracle(bars);
    for (const mode of ['A', 'B']) for (const s of SETTINGS) {
      const opts = cellOpts({ coin: sym.replace('-USD', ''), start: a, end: b, setting: s, mode, floor: null, slippage: 0.5, initialQty: 1000 / bars[0].c });
      const got = plain(await engine.backtest(opts)), want = plain(await run(opts));
      assert.deepEqual(got, want, sym + ' ' + mode + ' ' + JSON.stringify(s) + ' ' + a);
      n++;
    }
  }
  assert.equal(n, 40);
});
await test('LG2', 'runCell reports the engine\'s own metrics (vs hold, vs half-cash, sales, buys, cycle classes) unchanged', async () => {
  const s = { arm: 15, trail: 5, sell: 50 }, bars = slice('RW-USD', START, END);
  for (const mode of ['A', 'B']) {
    const r = await runCell(engine, DATA, { coin: 'RW', start: START, end: END, setting: s, mode });
    const o = await oracle(bars)(cellOpts({ coin: 'RW', start: START, end: END, setting: s, mode, floor: null, slippage: 0.5, initialQty: 1000 / bars[0].c }));
    const m = o.metrics;
    assert.equal(r.vs_hold_pct, m.vs_hold_pct); assert.equal(r.vs_half_cash_pct, m.vs_half_cash_pct);
    assert.equal(r.sells, m.sells_filled); assert.equal(r.buys, m.buys_filled); assert.equal(r.arms, m.cycles.length);
    for (const k of ['round_trip', 'churned', 'cash_parked', 'inert']) assert.equal(r['cyc_' + k], m.cycles.filter(c => c.cls === k).length, k);
    assert.ok(r.sells >= 2, 'the random walk sells (' + r.sells + ')');
  }
});
await test('LG3', 'the pump-and-dump: mode A sells once and never buys back; mode B buys back on the 8% bounce off the trough', async () => {
  const s = { arm: 20, trail: 9, sell: 100 };
  const a = await runCell(engine, DATA, { coin: 'PD', start: START, end: END, setting: s, mode: 'A', keepFills: true });
  assert.equal(a.sells, 1); assert.equal(a.buys, 0); assert.equal(a.cyc_cash_parked, 1);
  assert.deepEqual(a.fills.map(f => [f.leg, f.price]), [['sell', 1.3]], 'gap-aware: the bar opened at 1.3, below the 1.365 stop, so it fills at the open');
  const b = await runCell(engine, DATA, { coin: 'PD', start: START, end: END, setting: s, mode: 'B', cost: 1.0, keepFills: true });
  const buys = b.fills.filter(f => f.leg === 'buy');
  assert.ok(buys.length >= 1, 'mode B bought back');
  assert.equal(Number(buys[0].trigger.toFixed(6)), 0.972, 'bounce 8% off the 0.9 trough (the live default, not the engine default of 5)');
  assert.equal(b.c_buys_ok, 0, 'mode-C diagnostic: the 0.9 trough is below cost 1.0 x 0.95');
  const b2 = await runCell(engine, DATA, { coin: 'PD', start: START, end: END, setting: s, mode: 'B', cost: 0.94 });
  assert.equal(b2.c_buys_ok, b2.buys, 'with cost 0.94 the line is 0.893, so every buy passes');
  assert.equal(MODES.A.opts.abandon_hours, 0); assert.equal(MODES.B.opts.bounce_pct, 8); assert.equal(MODES.B.opts.retrace_pct, 50);
});
await test('LG4', 'the floor blocks the sale (the engine\'s below_entry_floor), and mode C cannot run', async () => {
  const r = await runCell(engine, DATA, { coin: 'PD', start: START, end: END, setting: { arm: 20, trail: 9, sell: 100 }, mode: 'A', floor: 1.4 });
  assert.equal(r.sells, 0); assert.ok(r.floor_blocks >= 1);
  assert.throws(() => cellOpts({ coin: 'PD', start: START, end: END, setting: { arm: 20, trail: 9, sell: 100 }, mode: 'C' }), /not expressible without a server.js change/);
});
await test('LG5', 'the stub reads the window as MySQL does (inclusive, UTC) and refuses a time it cannot read', async () => {
  const { db } = makeStubDb(DATA);
  const [rows] = await db.execute(Q_HOURLY, ['PD-USD', iso(T0 + 10 * H), iso(T0 + 20 * H)]);
  assert.equal(rows.length, 11); assert.equal(rows[0].t.getTime(), (T0 + 10 * H) * 1000);
  assert.equal(sqlTime('2026-06-01'), Date.UTC(2026, 5, 1)); assert.equal(sqlTime('2026-05-31 23:59:59'), Date.UTC(2026, 4, 31, 23, 59, 59));
  await assert.rejects(db.execute(Q_HOURLY, ['PD-USD', '31/05/2026', END]), /cannot read the time/);
  const [none] = await db.execute(Q_HOURLY, ['NOPE-USD', START, END]);
  assert.deepEqual(none, []);
});
await test('LG6', 'a query or helper the stubs do not provide fails loudly and names itself', async () => {
  const { db, unknown } = makeStubDb(new Map());
  await assert.rejects(db.execute('SELECT * FROM holdings'), /stub db does not answer this query.*SELECT \* FROM holdings/);
  assert.deepEqual(unknown, ['SELECT * FROM holdings']);
  const opts = cellOpts({ coin: 'PD', start: START, end: END, setting: SETTINGS[0], mode: 'A', floor: null, slippage: 0.5, initialQty: 1000 });
  const src = SRC.replace(/^async function runLadderBacktest\(opts\) \{/m, "$&\n  await db.execute('SELECT balance FROM wallets').catch(() => {});");
  assert.notEqual(src, SRC);
  await assert.rejects(makeEngine(DATA, { src }).backtest(opts), /does not answer[\s\S]*SELECT balance FROM wallets/);
  const src2 = SRC.replace(/^async function runLadderBacktest\(opts\) \{/m, '$&\n  someNewHelper();');
  await assert.rejects(makeEngine(DATA, { src: src2 }).backtest(opts), /someNewHelper is not defined/);
  await assert.rejects(engine.backtest(Object.assign({}, opts, { _profile: { ref: 'X' } })), /does not run _profile/);
});
await test('LG7', 'robust pick: the median of the 3x3 neighbourhood prefers a plateau to a lone best cell', async () => {
  const grid = { arm: [10, 20, 30, 40], trail: [5, 10, 15, 20], sell: [100] }, cells = [];
  for (const arm of grid.arm) for (const trail of grid.trail) cells.push({ arm, trail, sell: 100, value: arm === 10 && trail === 5 ? 50 : (arm >= 30 && trail >= 15 ? 10 : 0) });
  const p = robustPick(cells, grid);
  assert.deepEqual([p.best_cell.arm, p.best_cell.trail], [10, 5]);
  assert.equal(p.best_robust.score, 10); assert.ok(p.best_robust.arm >= 30 && p.best_robust.trail >= 15, 'on the plateau');
  assert.equal(p.scores.find(c => c.arm === 10 && c.trail === 5).score, 0, 'the lone spike scores the median of its neighbours: 0');
  // ties (30/20 and 40/20 both score 10 with own value 10) go to the setting nearest the current one
  assert.deepEqual([robustPick(cells, grid, { arm: 40, trail: 20, sell: 100 }).best_robust.arm, robustPick(cells, grid, { arm: 25, trail: 20, sell: 100 }).best_robust.arm], [40, 30]);
});
await test('LG9', 'hourly diagnostics: a sale in the bar that set the peak, and an arm on a rebound after a crash, are counted', async () => {
  const wide = series('WIDE-USD', flat(48, 1).concat([1.3]).concat(flat(10, 1.55)));
  wide[49] = Object.assign({}, wide[49], { o: 1.3, h: 1.6, l: 1.3, c: 1.55 });   // armed at 1.3; this bar goes 1.3 -> 1.6: peak 1.6, stop 1.456
  const reb = series('REB-USD', flat(48, 1).concat(flat(3, 0.7), [0.9], flat(3, 0.8), flat(10, 0.8)));
  const d = toMap([...wide, ...reb]), e = makeEngine(d);
  const w = await runCell(e, d, { coin: 'WIDE', start: START, end: END, setting: { arm: 20, trail: 9, sell: 100 }, mode: 'A', keepFills: true });
  assert.deepEqual(w.fills.map(f => [f.leg, f.price]), [['sell', 1.3]], 'sold at the open of the bar whose high made the peak');
  assert.equal(w.same_bar_sales, 1);
  const r = await runCell(e, d, { coin: 'REB', start: START, end: END, setting: { arm: 25, trail: 9, sell: 100 }, mode: 'A' });
  assert.equal(r.arms, 1); assert.equal(r.rebound_arms, 1, '0.7 -> 0.9 is +28.6% from the rolling low, still below the 1.0 of the day before');
});
await test('LG8', 'extracted by name from server.js: the driver runs the live engine text, not a copy', async () => {
  const code = extractLoopCode(SRC);
  for (const f of ['runLadderBacktest', 'shadowEvalLadder', 'shadowEvalTier', 'shadowNewState', 'btComputeMetrics']) assert.ok(code.includes(extractFunction(SRC, f)), f);
});

report();
