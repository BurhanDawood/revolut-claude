// T1 (e) spikeRef: a one-hour wick does not lower the reference; a crash-and-recover is not a spike; under 20 hourly closes it
//        fails closed; the unfinished hour is ignored.
// T1 (f) spikeChase: each step's floor = max(step price, cost floor, give-up line); it offers AT the line once, then stops; a failed
//        cancel or an error after the first order stops the chase (no next step).
// T1 (g) spikeLoopArmOver: a loop arming over an insurance trail never lowers the peak or the stop.
// Run: node tests/money/spike.test.mjs
import assert from 'node:assert/strict';
import { readServer, extractFunction, extractConst, strictSandbox, runner, recDb, quiet, rng, plain } from '../lib.mjs';

const SRC = readServer();
const CODE = [extractConst(SRC, 'SPIKE_DEFAULTS'), ...['spikeMedian', 'spikeRef', 'spikeChase', 'spikeLoopArmOver'].map(f => extractFunction(SRC, f))].join('\n');
const { test, report } = runner('T1 money: spike insurance (tests/money/spike.test.mjs)');

function env({ floor = 90, trails = [] } = {}) {
  const calls = [];
  const trailingStops = new Map(trails);
  const g = { console: quiet, db: recDb(calls), trailingStops, computeDerivedFloor: async () => ({ floor }), spikeCfg: async () => { throw new Error('cfg must be passed'); },
    revolutTickerMap: async () => { throw new Error('ticker must be passed'); }, floorCappedLimitSell: async () => { throw new Error('sell must be passed'); } };
  const api = strictSandbox(g, CODE, ['spikeRef', 'spikeChase', 'spikeLoopArmOver', 'SPIKE_DEFAULTS']);
  return { api, calls, trailingStops };
}

// ── spikeRef ─────────────────────────────────────────────────────────────────────────────────
const H = 3600000, NOW = Date.parse('2026-09-26T12:30:00Z'), CUR = Math.floor(NOW / H) * H;
// n closed hourly bars ending at the last finished hour, oldest first; close(i) i = hours before the current hour (1 = last closed)
const bars = (n, close = () => 1, low) => Array.from({ length: n }, (_, j) => { const i = n - j; const c = close(i); return { t: CUR - i * H, h: c, l: low ? low(i, c) : c, c }; });
const { api: S } = env();

await test('SR1', 'control: 7 days flat at 1.0, price 2.1 -> triggered (>= 2x the 24 h low close, >= 1.5x the 7-day median)', async () => {
  const r = S.spikeRef(bars(7 * 24), 2.1, S.SPIKE_DEFAULTS, NOW);
  assert.equal(r.triggered, true); assert.equal(r.low24, 1); assert.equal(r.ref7, 1); assert.equal(r.reason, 'spike');
  assert.equal(S.spikeRef(bars(7 * 24), 1.99, S.SPIKE_DEFAULTS, NOW).triggered, false, 'under 2x');
});
await test('SR2', 'a one-hour wick (candle low 0.3 in one hour) does not lower the reference: only closes count', async () => {
  const wick = bars(7 * 24, () => 1, (i, c) => (i === 5 ? 0.3 : c));
  const r = S.spikeRef(wick, 1.5, S.SPIKE_DEFAULTS, NOW);
  assert.equal(r.low24, 1, 'the reference is the lowest CLOSE'); assert.equal(r.triggered, false, '1.5x the close low is not a spike (it would be 5x the wick)');
  assert.deepEqual(plain(r), plain(S.spikeRef(bars(7 * 24), 1.5, S.SPIKE_DEFAULTS, NOW)), 'identical to the same history without the wick');
});
await test('SR3', 'crash-and-recover (24 h at 0.4 after 6 days at 1.0, back to 1.0) is not a spike', async () => {
  const b = bars(7 * 24, (i) => (i <= 24 ? 0.4 : 1));
  const r = S.spikeRef(b, 1.0, S.SPIKE_DEFAULTS, NOW);
  assert.ok(r.ratio >= 2, 'it IS 2.5x the 24 h low');
  assert.equal(r.triggered, false); assert.match(r.reason, /7-day median/);
});
await test('SR4', 'fewer than 20 hourly closes in 24 h -> fails closed (not triggered), whatever the price', async () => {
  for (const n of [0, 1, 10, 19]) {
    const r = S.spikeRef(bars(n, () => 0.01), 100, S.SPIKE_DEFAULTS, NOW);
    assert.equal(r.triggered, false, n + ' closes'); assert.equal(r.n24, n); assert.match(r.reason, /fewer than 20/);
  }
  const old = bars(7 * 24).filter(b => b.t < CUR - 24 * H);   // plenty of history, but none in the last 24 h
  assert.equal(S.spikeRef(old, 100, S.SPIKE_DEFAULTS, NOW).triggered, false);
  assert.equal(S.spikeRef(bars(20, () => 1), 2.1, S.SPIKE_DEFAULTS, NOW).triggered, true, 'control: exactly 20 is enough');
  assert.equal(S.spikeRef(bars(48), 0, S.SPIKE_DEFAULTS, NOW).triggered, false, 'no price -> fails closed');
});
await test('SR5', 'the unfinished current hour is ignored (neither its close nor its count)', async () => {
  const b = bars(7 * 24).concat([{ t: CUR, h: 1, l: 0.2, c: 0.2 }]);   // the live hour dips to 0.2
  const r = S.spikeRef(b, 1.5, S.SPIKE_DEFAULTS, NOW);
  assert.equal(r.low24, 1); assert.equal(r.n24, 24); assert.equal(r.triggered, false);
  const nineteen = bars(19).concat([{ t: CUR, h: 1, l: 1, c: 1 }]);
  assert.equal(S.spikeRef(nineteen, 5, S.SPIKE_DEFAULTS, NOW).n24, 19, 'the live hour does not make up the 20');
  assert.equal(S.spikeRef(nineteen, 5, S.SPIKE_DEFAULTS, NOW).triggered, false);
});

// ── spikeChase ───────────────────────────────────────────────────────────────────────────────
const CFG = (o = {}) => ({ chase_steps: 20, chase_step_pct: 1, give_up_pct: 25, chase_polls: 1, ...o });
// sellFn(k, args) -> result of floorCappedLimitSell for step k; default: nothing fills, cancel confirmed
async function chase({ floor = 90, peak = 110, bid = 100, cfg = CFG(), qty = 10, sellFn } = {}) {
  const { api } = env({ floor });
  const sells = [], sends = [];
  const sell = async (symbol, left, lim, ref, cid, o) => {
    sells.push({ left, lim, ref, cid });
    const f = sellFn ? await sellFn(sells.length, { left, lim }) : null;
    return { order_id: 'O' + sells.length, limit_price: lim, filled_qty: 0, avg_price: null, state: 'cancelled', remainder_resting: false, order: {}, ...(f || {}) };
  };
  const tick = async () => (typeof bid === 'function' ? bid(sells.length) : { CC: { bid, mid: bid } });
  const out = await api.spikeChase('CC-USD', 'CC', qty, { peak, cid: 'sx-1' }, { cfg, ticker: tick, sell, onSend: () => sends.push(sells.length) });
  return { out, sells, sends };
}

await test('SC1', 'each step offers at max(bid x (1 - k x step%), cost floor, give-up line)', async () => {
  for (const [floor, peak, bid, stepPct] of [[90, 110, 100, 1], [50, 110, 100, 3], [95, 100, 100, 0.5], [10, 200, 100, 7]]) {
    const { out, sells } = await chase({ floor, peak, bid, cfg: CFG({ chase_step_pct: stepPct }) });
    const line = Math.max(floor, peak * 0.75);
    assert.equal(out.line, line);
    sells.forEach((s, i) => { const k = i + 1; assert.equal(s.lim, Math.max(bid * (1 - k * stepPct / 100), floor, peak * 0.75), 'step ' + k); assert.ok(s.lim >= line); });
  }
});
await test('SC2', 'property: with a moving bid, no step ever offers under the cost floor or the give-up line', async () => {
  const R = rng(9);
  for (let i = 0; i < 300; i++) {
    const floor = 1 + R() * 100, peak = floor * (0.5 + R() * 2), start = floor * (0.8 + R());
    const { out, sells } = await chase({ floor, peak, bid: () => ({ CC: { bid: start * (0.7 + R() * 0.6) } }), cfg: CFG({ chase_step_pct: 0.5 + R() * 5, chase_steps: 1 + Math.floor(R() * 20) }) });
    for (const s of sells) assert.ok(s.lim >= floor && s.lim >= peak * 0.75, 'offer ' + s.lim + ' under floor ' + floor + ' / line ' + peak * 0.75);
    assert.ok(out.steps <= 20);
  }
});
await test('SC3', 'offers AT the line exactly once, then stops (cost floor binding -> "floor", give-up line binding -> "give_up")', async () => {
  const a = await chase({ floor: 90, peak: 110, bid: 100, cfg: CFG({ chase_step_pct: 7 }) });   // 93, then 86 -> 90 (the line), then stop
  assert.deepEqual(a.sells.map(s => s.lim), [93, 90]); assert.equal(a.out.stopped, 'floor');
  const b = await chase({ floor: 50, peak: 120, bid: 100, cfg: CFG({ chase_step_pct: 5 }) });   // line = 90: 95, 90, stop
  assert.deepEqual(b.sells.map(s => s.lim), [95, 90]); assert.equal(b.out.stopped, 'give_up');
  const c = await chase({ floor: 90, peak: 110, bid: 100, cfg: CFG({ chase_step_pct: 1 }) });   // 99 ... 90 (k = 10 is exactly the line), then stop
  assert.equal(c.sells.filter(s => s.lim === 90).length, 1, 'the line is offered once'); assert.equal(c.sells.length, 10); assert.equal(c.out.stopped, 'floor');
  const d = await chase({ floor: 99.5, peak: 100, bid: 100, cfg: CFG({ chase_step_pct: 1 }) });   // step 1 is already under the line
  assert.deepEqual(d.sells.map(s => s.lim), [99.5]);
});
await test('SC4', 'a failed cancel (remainder_resting) stops the chase dead: no next step', async () => {
  const { out, sells } = await chase({ sellFn: (k) => (k === 2 ? { remainder_resting: true, filled_qty: 1, avg_price: 98, state: 'partially_filled' } : null) });
  assert.equal(sells.length, 2); assert.equal(out.stopped, 'cancel_failed'); assert.equal(out.resting_order_id, 'O2'); assert.equal(out.filled_qty, 1);
});
await test('SC5', 'an error after the first order stops the chase (stopped "error", no next step); an error on the first order throws', async () => {
  const { out, sells } = await chase({ sellFn: (k) => { if (k === 3) throw new Error('ECONNRESET'); return null; } });
  assert.equal(sells.length, 3); assert.equal(out.stopped, 'error'); assert.equal(out.steps, 2); assert.match(out.error, /ECONNRESET/);
  await assert.rejects(chase({ sellFn: () => { throw new Error('timeout'); } }), /timeout/, 'first order errors -> thrown to the caller (autoExecuteSell: order_sent true)');
});
await test('SC6', 'onSend fires before the first order; a missing cost floor throws before any order', async () => {
  const { sends } = await chase({});
  assert.equal(sends[0], 0, 'onSend ran before the first sell call');
  const { api } = env({ floor: null });
  let sold = 0, sent = 0;
  await assert.rejects(api.spikeChase('CC-USD', 'CC', 10, { peak: 110, cid: 'x' }, { cfg: CFG(), ticker: async () => ({ CC: { bid: 100 } }), sell: async () => { sold++; }, onSend: () => { sent++; } }), /no cost floor/);
  assert.equal(sold, 0); assert.equal(sent, 0);
});
await test('SC7', 'fills: done when all is sold; no price -> stops with no order', async () => {
  const all = await chase({ sellFn: (k, a) => ({ filled_qty: a.left, avg_price: a.lim, state: 'filled' }) });
  assert.equal(all.sells.length, 1); assert.equal(all.out.stopped, 'done'); assert.equal(all.out.filled_qty, 10); assert.equal(all.out.left, 0);
  const np = await chase({ bid: () => ({}) });
  assert.equal(np.sells.length, 0); assert.equal(np.out.stopped, 'no_price');
});

// ── spikeLoopArmOver ─────────────────────────────────────────────────────────────────────────
const spikeTrail = (o = {}) => ({ trailPct: 15, peakPrice: 2.0, stopPrice: 1.7, entryPrice: null, autoExecute: true, sellPct: 100, exchange: 'revolut', source: 'spike', ...o });
await test('SL1', 'a loop arming over an insurance trail never lowers the peak or the stop (property over 500 arms)', async () => {
  const R = rng(13);
  for (let i = 0; i < 500; i++) {
    const old = spikeTrail({ trailPct: 1 + R() * 30, peakPrice: 0.5 + R() * 5 });
    old.stopPrice = old.peakPrice * (1 - old.trailPct / 100);
    const e = env({ trails: [['CC-USD', { ...old }]] });
    const price = old.peakPrice * (0.3 + R() * 1.4), loopPct = 1 + R() * 50;
    const handled = await e.api.spikeLoopArmOver('CC-USD', price, loopPct, 0.5, true, 50);
    const ts = e.trailingStops.get('CC-USD');
    assert.equal(handled, true);
    assert.ok(ts.peakPrice >= old.peakPrice, 'peak lowered'); assert.ok(ts.stopPrice >= old.stopPrice, 'stop lowered');
    assert.ok(ts.trailPct <= old.trailPct, 'trail loosened');
    assert.equal(ts.source, 'loop'); assert.equal(ts.autoExecute, true);
    const upd = e.calls.find(c => c[0] === 'db' && /^UPDATE trailing_stops/.test(c[1]));
    assert.deepEqual(plain(upd[2]).slice(0, 3), [ts.trailPct, ts.peakPrice, ts.stopPrice], 'the DB gets the same values');
  }
});
await test('SL2', 'notify-only loop -> insurance kept untouched; no insurance trail -> not handled (false)', async () => {
  const e = env({ trails: [['CC-USD', spikeTrail()]] });
  assert.equal(await e.api.spikeLoopArmOver('CC-USD', 1.0, 5, 0.5, false, 50), true);
  assert.deepEqual(plain(e.trailingStops.get('CC-USD')), spikeTrail()); assert.equal(e.calls.length, 0);
  const f = env({ trails: [['CC-USD', spikeTrail({ source: 'loop' })]] });
  assert.equal(await f.api.spikeLoopArmOver('CC-USD', 1.0, 5, 0.5, true, 50), false);
  assert.equal(await env().api.spikeLoopArmOver('CC-USD', 1.0, 5, 0.5, true, 50), false);
});
report();
