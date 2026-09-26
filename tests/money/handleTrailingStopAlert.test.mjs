// T1 (i) handleTrailingStopAlert #K1: a venue refusal (4xx / nothing sent) restores the trail EXACTLY; an ambiguous error after
// sending leaves the trail cleared. The real handler, removeTrailingStop / restoreTrailingStop / setTrailingStop and the #K1
// helpers run; the sell functions are stubs that return the result shapes autoExecuteSell / autoExecuteKrakenSell produce.
// Run: node tests/money/handleTrailingStopAlert.test.mjs
import assert from 'node:assert/strict';
import { readServer, extractFunction, extractConst, looseSandbox, runner, recDb, quiet, plain } from '../lib.mjs';

const SRC = readServer();
const CODE = ['VENUE_DEFINITIVE_KRAKEN', 'VENUE_BACKOFF_CAP_MIN', '_venueBackoff', '_presendRetry'].map(c => extractConst(SRC, c)).join('\n') + '\n' +
  ['isDefinitiveVenueRejection', 'isVenueRefusal', 'venueBackoffUntil', 'venueBackoffHit', 'venueBackoffClear',
   'setTrailingStop', 'removeTrailingStop', 'restoreTrailingStop', 'handleTrailingStopAlert'].map(f => extractFunction(SRC, f)).join('\n');
const { test, report } = runner('T1 money: handleTrailingStopAlert #K1 (tests/money/handleTrailingStopAlert.test.mjs)');

const TS = (o = {}) => ({ trailPct: 10, peakPrice: 2.0, stopPrice: 1.8, entryPrice: 1.0, autoExecute: true, sellPct: 50, exchange: 'revolut', source: 'loop', ...o });
// result: what the (stubbed) sell function returns
async function fire(result, tsOver = {}) {
  const calls = [];
  const ts = TS(tsOver), sym = 'CC-USD';
  const trailingStops = new Map([[sym, { ...ts }]]);
  const sellStub = (name) => async (...a) => { calls.push([name, a]); if (result instanceof Error) throw result; return result; };
  const g = {
    console: quiet, trailingStops, trailingStopAlerted: new Map(), trailingStopReminderCount: new Map(), analysisRateLimit: new Map(),
    alertState: { acknowledged: new Set() }, fmtPriceShort: String,
    db: recDb(calls, (q) => (/config_key = 'ai_auto_execute'/.test(q) ? [[{ config_value: JSON.stringify({ enabled: true, hodl_symbols: [], manual_only_symbols: [] }) }]] : undefined)),
    autoExecuteSell: sellStub('autoExecuteSell'), autoExecuteKrakenSell: sellStub('autoExecuteKrakenSell'),
    spikeSaleContext: async () => null, spikeAfterSale: async () => {},
    sendTelegram: async (m) => { calls.push(['sendTelegram', [m]]); },
  };
  const api = looseSandbox(g, CODE, ['handleTrailingStopAlert', 'venueBackoffUntil'], calls);
  await api.handleTrailingStopAlert(sym, 1.7, trailingStops.get(sym), ts.exchange);
  const sold = calls.filter(c => c[0] === 'autoExecuteSell' || c[0] === 'autoExecuteKrakenSell');
  const dbw = calls.filter(c => c[0] === 'db' && /^(INSERT INTO trailing_stops|DELETE FROM trailing_stops)/.test(c[1]));
  return { ts, after: trailingStops.get(sym), calls, sold, dbw, api };
}
const err = (o) => ({ executed: false, reason: 'error', message: 'venue error', ...o });
function assertRestored(f, why) {
  assert.equal(f.sold.length, 1, 'one sale attempted');
  assert.deepEqual(plain(f.after), f.ts, 'trail restored EXACTLY (peak, stop, flags, source): ' + why);
  assert.ok(/^DELETE/.test(f.dbw[0][1]), 'cleared first (#F4)');
  const ins = f.dbw[f.dbw.length - 1];
  assert.ok(/^INSERT INTO trailing_stops/.test(ins[1]), 'then written back to the DB');
  assert.deepEqual(plain(ins[2]), ['CC-USD', 10, 2.0, 1.8, 1.0, 1, 50, f.ts.exchange, 'loop'], 'DB row = the saved trail');
}
function assertCleared(f, why) {
  assert.equal(f.sold.length, 1, 'one sale attempted');
  assert.equal(f.after, undefined, 'trail stays cleared in memory: ' + why);
  assert.equal(f.dbw.length, 1, 'only the DELETE - nothing written back'); assert.ok(/^DELETE/.test(f.dbw[0][1]));
}

await test('HT1', 'Revolut X 4xx refusal (order request sent, venue said 400/401/403/422) -> trail restored exactly', async () => {
  for (const st of [400, 401, 403, 404, 409, 422]) assertRestored(await fire(err({ order_sent: true, venue_status: st })), 'HTTP ' + st);
});
await test('HT2', 'error before any order was sent (order_sent false) -> trail restored exactly', async () => {
  assertRestored(await fire(err({ order_sent: false, venue_status: null })), 'pre-send');
  assertRestored(await fire(err({ order_sent: false, message: 'EGeneral:Internal error' }), { exchange: 'kraken' }), 'kraken pre-send');
});
await test('HT3', 'definitive refusals (Revolut 429, Kraken lockout / nonce / rate limit) -> restored, and the venue backs off', async () => {
  const r = await fire(err({ order_sent: true, venue_status: 429 }));
  assertRestored(r, '429'); assert.ok(r.api.venueBackoffUntil('revolut') > Date.now(), 'Revolut X back-off started');
  for (const m of ['EAPI:Invalid nonce', 'EGeneral:Temporary lockout', 'EAPI:Rate limit exceeded']) {
    const k = await fire(err({ order_sent: true, message: m }), { exchange: 'kraken' });
    assertRestored(k, m); assert.ok(k.api.venueBackoffUntil('kraken') > Date.now());
  }
});
await test('HT4', 'ambiguous error AFTER sending (timeout / reset / 5xx / no status) -> trail stays cleared (no double sale)', async () => {
  for (const o of [{ venue_status: null, message: 'ETIMEDOUT' }, { venue_status: 500 }, { venue_status: 502 }, { venue_status: 503 }, { message: 'socket hang up' }]) {
    const f = await fire(err({ order_sent: true, ...o }));
    assertCleared(f, JSON.stringify(o));
    assert.ok(f.calls.some(c => c[0] === 'sendTelegram' && /may have reached/.test(c[1][0])), 'Bryan is told the order may have gone');
  }
  assertCleared(await fire(err({ order_sent: true, message: 'EService:Unavailable' }), { exchange: 'kraken' }), 'kraken ambiguous');
  assertCleared(await fire(err({ order_sent: true, venue_status: 400, message: 'EOrder:Unknown' }), { exchange: 'kraken' }), 'a Kraken 4xx is not a refusal by status (only its listed codes)');
});
await test('HT5', 'controls: executed -> cleared (single use); paused -> restored exactly; floor-blocked -> re-anchored at the breach price', async () => {
  assertCleared(await fire({ executed: true, qty: 1, price: 1.7 }), 'executed');
  assertRestored(await fire({ executed: false, reason: 'paused' }), 'paused');
  const fb = await fire({ executed: false, reason: 'floor_blocked', floor: 1.75 });
  assert.equal(fb.after.peakPrice, 1.7); assert.equal(fb.after.autoExecute, true); assert.equal(fb.after.source, 'loop'); assert.equal(fb.after.sellPct, 50);
});
// End to end: the REAL autoExecuteSell and placeRevolutOrder under the handler; only revolutRequest (the HTTP layer) is a stub.
const E2E = CODE + '\n' + ['autoExecuteSell', 'placeRevolutOrder'].map(f => extractFunction(SRC, f)).join('\n');
async function fireE2E(post) {
  const calls = [];
  const ts = TS(), sym = 'CC-USD';
  const trailingStops = new Map([[sym, { ...ts }]]);
  const g = {
    console: quiet, trailingStops, trailingStopAlerted: new Map(), trailingStopReminderCount: new Map(), analysisRateLimit: new Map(),
    alertState: { acknowledged: new Set() }, fmtPriceShort: String, priceTargets: new Map(), pendingUndo: new Map(), setTimeout: () => 0,
    randomUUID: () => 'uuid-1', isAutoExecPaused: async () => false, getCurrentPrice: async () => 1.7,
    computeDerivedFloor: async () => ({ floor: 1.0, source: 'test' }), edgeSellCheck: async () => ({ edge: false }),
    db: recDb(calls, (q) => (/config_key = 'ai_auto_execute'/.test(q) ? [[{ config_value: JSON.stringify({ enabled: true }) }]] : undefined)),
    spikeSaleContext: async () => null,
    revolutRequest: async (method, path, body, sp, o) => {
      calls.push(['revolutRequest', [method, path]]);
      if (method === 'GET' && path === '/balances') return [{ currency: 'CC', available: '100', reserved: '0' }];
      if (method === 'POST' && path === '/orders') return post();
      throw new Error('UNMOCKED ' + method + ' ' + path);
    },
    sendTelegram: async (m) => { calls.push(['sendTelegram', [m]]); },
  };
  const api = looseSandbox(g, E2E, ['handleTrailingStopAlert'], calls);
  await api.handleTrailingStopAlert(sym, 1.7, trailingStops.get(sym), 'revolut');
  const posts = calls.filter(c => c[0] === 'revolutRequest' && c[1][0] === 'POST');
  return { ts, after: trailingStops.get(sym), posts, calls };
}
await test('HT6', 'end to end (real autoExecuteSell + placeRevolutOrder): HTTP 4xx from POST /orders -> trail restored exactly', async () => {
  for (const st of [400, 403, 422, 429]) {
    const f = await fireE2E(() => ({ status: st, ok: false, body: { message: 'refused (mock ' + st + ')' } }));
    assert.equal(f.posts.length, 1, 'one order request'); assert.deepEqual(plain(f.after), f.ts, 'HTTP ' + st);
  }
});
await test('HT7', 'end to end: timeout / connection reset / 5xx after the POST -> trail stays cleared', async () => {
  for (const post of [() => { throw new Error('ETIMEDOUT'); }, () => { throw new Error('ECONNRESET'); }, () => ({ status: 502, ok: false, body: { raw: '<html>' } }), () => ({ status: 500, ok: false, body: {} })]) {
    const f = await fireE2E(post);
    assert.equal(f.posts.length, 1); assert.equal(f.after, undefined, String(post));
  }
});
await test('HT8', 'end to end control: POST /orders accepted -> sold once, trail cleared (single use)', async () => {
  const f = await fireE2E(() => ({ status: 200, ok: true, body: { data: { venue_order_id: 'V-1', state: 'filled' } } }));
  assert.equal(f.posts.length, 1); assert.equal(f.after, undefined);
});
report();
