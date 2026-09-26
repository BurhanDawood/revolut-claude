// T1 (b) autoExecuteSell: the floor guard blocks a sale at or below the derived floor; paused -> no sale; dust -> no sale;
// with opts.chase it never places a market order; order_sent is set only once an order may have gone out.
// The real autoExecuteSell, spikeChase and floorCappedLimitSell run together; the venue, db and Telegram are stubs.
// Run: node tests/money/autoExecuteSell.test.mjs
import assert from 'node:assert/strict';
import { readServer, extractFunction, extractConst, looseSandbox, runner, recDb, quiet, instantTimeout, rng } from '../lib.mjs';

const SRC = readServer();
const CODE = [extractConst(SRC, 'EDGE_LIMIT_WAIT_MS'), extractConst(SRC, 'SPIKE_DEFAULTS'),
  ...['priceDecimals', 'floorCappedLimitSell', 'spikeChase', 'autoExecuteSell'].map(f => extractFunction(SRC, f))].join('\n');
const { test, report } = runner('T1 money: autoExecuteSell (tests/money/autoExecuteSell.test.mjs)');

// w: price, qty (available), floor (derived; null = none), paused, edge, chase venue behaviour...
function env(w = {}) {
  const calls = [];
  const W = { price: 2, qty: 100, floor: 1, paused: false, edge: false, bid: 2, fill: 'all', ...w };
  let floorCalls = 0;
  const g = {
    console: quiet, setTimeout: instantTimeout,
    db: recDb(calls),
    isAutoExecPaused: async () => W.paused,
    getCurrentPrice: async () => { if (W.priceThrows) throw new Error('ticker down'); return W.price; },
    revolutRequest: async (method, path, b, q, o) => {
      calls.push(['revolutRequest', method, path]);
      if (method === 'GET' && path === '/balances') return [{ currency: 'CC', available: String(W.qty), reserved: '0' }];
      if (method === 'GET' && path.startsWith('/orders/')) return { data: { state: W.fill === 'all' ? 'filled' : 'new', filled_quantity: W.fill === 'all' ? W.lastQty : 0, average_fill_price: W.fill === 'all' ? W.lastPrice : null } };
      if (method === 'DELETE') return { ok: W.cancelOk !== false, status: W.cancelOk === false ? 500 : 204 };
      throw new Error('UNMOCKED ' + method + ' ' + path);
    },
    computeDerivedFloor: async () => { floorCalls++; if (W.floorThrowsOn === floorCalls) throw new Error('db down'); return { floor: W.floor, source: 'test' }; },
    edgeSellCheck: async () => ({ edge: W.edge, floor: W.floor, clearance_pct: 1, required_pct: 3 }),
    getPairQuoteStep: async () => 0.0001,
    spikeCfg: async () => ({ chase_steps: 10, chase_step_pct: 1, give_up_pct: 25, chase_polls: 1 }),
    revolutTickerMap: async () => (W.bid ? { CC: { bid: W.bid, mid: W.bid } } : {}),
    placeRevolutOrder: async (symbol, side, type, qty, price) => {
      calls.push(['placeRevolutOrder', side, type, qty, price]);
      if (W.placeThrows) throw Object.assign(new Error('ETIMEDOUT'), {});
      W.lastQty = qty; W.lastPrice = price != null ? Number(price) : W.price;
      return { data: { venue_order_id: 'V-' + calls.length }, client_order_id: 'C-1' };
    },
    fmtPriceShort: String, priceTargets: new Map(), pendingUndo: new Map(), troughTrackers: new Map(),
    formatAutoExecuteMessage: () => 'sold', spikeChaseText: () => 'chase',
  };
  const api = looseSandbox(g, CODE, ['autoExecuteSell'], calls);
  const run = (opts) => api.autoExecuteSell('CC-USD', 100, 'test analysis', 'High', opts);
  const places = () => calls.filter(c => c[0] === 'placeRevolutOrder');
  return { run, calls, places, W };
}

await test('AE1', 'floor guard: price AT the floor -> floor_blocked, no order', async () => {
  const e = env({ price: 1, floor: 1 });
  const r = await e.run();
  assert.equal(r.executed, false); assert.equal(r.reason, 'floor_blocked'); assert.equal(r.floor, 1);
  assert.equal(e.places().length, 0);
});
await test('AE2', 'floor guard: property over 500 prices at/below the floor (market, EDGE and chase modes) -> never an order', async () => {
  const R = rng(3);
  for (let i = 0; i < 500; i++) {
    const floor = Number((0.0001 + R() * 100).toPrecision(8)), price = floor * (1 - R() * 0.5);
    const opts = [undefined, { chase: { peak: floor * 3, cid: 'sx' } }][i % 2];
    const e = env({ price, floor, qty: 1e6, edge: i % 3 === 0, bid: price });
    const r = await e.run(opts);
    assert.equal(r.reason, 'floor_blocked', 'price ' + price + ' floor ' + floor);
    assert.equal(e.places().length, 0);
  }
});
await test('AE3', 'no derived floor -> no_floor; floor lookup throws -> floor_error; neither places an order', async () => {
  const a = env({ floor: null }); assert.equal((await a.run()).reason, 'no_floor'); assert.equal(a.places().length, 0);
  const b = env({ floorThrowsOn: 1 }); assert.equal((await b.run()).reason, 'floor_error'); assert.equal(b.places().length, 0);
});
await test('AE4', 'control: price just above the floor, PASS -> one MARKET order, executed', async () => {
  const e = env({ price: 1.01, floor: 1 });
  const r = await e.run();
  assert.equal(r.executed, true);
  assert.deepEqual(e.places().map(c => c[2]), ['market']);
});
await test('AE5', 'paused -> reason paused, nothing read or placed', async () => {
  const e = env({ paused: true });
  const r = await e.run();
  assert.deepEqual({ ...r }, { executed: false, reason: 'paused' });
  assert.equal(e.places().length, 0);
  assert.ok(!e.calls.some(c => c[0] === 'revolutRequest'), 'no venue call at all');
});
await test('AE6', 'dust (sell value < $1) -> reason dust, no order; zero balance -> no_position', async () => {
  const d = env({ qty: 0.4, price: 2 }); assert.equal((await d.run()).reason, 'dust'); assert.equal(d.places().length, 0);
  const d2 = env({ qty: 100, price: 2 }); assert.equal((await d2.run({ sellQty: 0.1 })).reason, 'dust'); assert.equal(d2.places().length, 0);
  const z = env({ qty: 0 }); assert.equal((await z.run()).reason, 'no_position'); assert.equal(z.places().length, 0);
});
await test('AE7', 'opts.chase: every order is a LIMIT, never a market order (filled, unfilled, failed-cancel)', async () => {
  for (const w of [{ fill: 'all' }, { fill: 'none' }, { fill: 'none', cancelOk: false }, { fill: 'all', edge: true }]) {
    const e = env({ price: 2, floor: 1, bid: 2, ...w });
    await e.run({ chase: { peak: 2.2, cid: 'sx-1' } });
    assert.ok(e.places().length >= 1, 'the chase placed at least one order ' + JSON.stringify(w));
    assert.deepEqual([...new Set(e.places().map(c => c[2]))], ['limit'], JSON.stringify(w));
  }
});
await test('AE8', 'order_sent: false when the error comes before any order (price read, floor inside the chase)', async () => {
  const a = env({ priceThrows: true });
  const ra = await a.run();
  assert.equal(ra.reason, 'error'); assert.equal(ra.order_sent, false);
  const b = env({ floorThrowsOn: 2 });   // the 2nd computeDerivedFloor is spikeChase's own, before its first order
  const rb = await b.run({ chase: { peak: 2.2, cid: 'sx' } });
  assert.equal(rb.reason, 'error'); assert.equal(rb.order_sent, false); assert.equal(b.places().length, 0);
});
await test('AE9', 'order_sent: true once an order may have gone out (market throws, EDGE limit throws, chase order throws)', async () => {
  const m = env({ placeThrows: true });
  const rm = await m.run(); assert.equal(rm.reason, 'error'); assert.equal(rm.order_sent, true); assert.equal(m.places().length, 1);
  const l = env({ placeThrows: true, edge: true });
  const rl = await l.run(); assert.equal(rl.order_sent, true); assert.equal(l.places()[0][2], 'limit');
  const c = env({ placeThrows: true });
  const rc = await c.run({ chase: { peak: 2.2, cid: 'sx' } }); assert.equal(rc.reason, 'error'); assert.equal(rc.order_sent, true);
});
report();
