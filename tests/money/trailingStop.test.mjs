// T1 (c) updateTrailingStop: a trail's peak never goes down, and the stop moves only up.
// T1 (d) setTrailingStop / restoreTrailingStop: autoExecute is three-valued (null keeps it); source is kept unless a new one is given.
// Run: node tests/money/trailingStop.test.mjs
import assert from 'node:assert/strict';
import { readServer, extractFunction, strictSandbox, runner, recDb, quiet, rng, plain } from '../lib.mjs';

const SRC = readServer();
const FNS = ['setTrailingStop', 'removeTrailingStop', 'restoreTrailingStop', 'updateTrailingStop'];
const CODE = FNS.map(f => extractFunction(SRC, f)).join('\n');
const { test, report } = runner('T1 money: trailing stops (tests/money/trailingStop.test.mjs)');

function env({ held = 1000, acknowledged = [], kraken = [] } = {}) {
  const calls = [];
  const trailingStops = new Map();
  const g = {
    console: quiet, db: recDb(calls), trailingStops, trailingStopAlerted: new Map(), trailingStopReminderCount: new Map(),
    alertState: { acknowledged: new Set(acknowledged) }, ignoredCoins: new Set(), KRAKEN_MONITORED_COINS: kraken, fmtPriceShort: String,
    revolutRequest: async (m, p) => { if (p === '/balances') return [{ currency: 'CC', available: String(held), reserved: '0' }]; throw new Error('UNMOCKED ' + p); },
  };
  const api = strictSandbox(g, CODE, FNS);
  return { api, calls, trailingStops };
}
const upsertParams = (calls) => calls.filter(c => c[0] === 'db' && /^INSERT INTO trailing_stops/.test(c[1])).map(c => plain(c[2]));

await test('TS1', 'updateTrailingStop: property over 200 random walks -> peak never decreases, stop never decreases', async () => {
  const R = rng(5);
  for (let w = 0; w < 200; w++) {
    const e = env({ held: 1e9 });
    const trail = 1 + R() * 40;
    let px = 0.001 + R() * 100;
    await e.api.setTrailingStop('CC-USD', trail, px, null, true, 100, 'revolut', 'loop');
    let prev = { ...e.trailingStops.get('CC-USD') };
    for (let i = 0; i < 60; i++) {
      px = Math.max(1e-9, px * (1 + (R() - 0.5) * 0.3));
      const r = await e.api.updateTrailingStop('CC-USD', px);
      const ts = e.trailingStops.get('CC-USD');
      if (!ts) break;   // a breach on a flat position removes it - not the case here (held is large)
      assert.ok(ts.peakPrice >= prev.peakPrice, 'peak went down: ' + prev.peakPrice + ' -> ' + ts.peakPrice);
      assert.ok(ts.stopPrice >= prev.stopPrice - 1e-15, 'stop went down: ' + prev.stopPrice + ' -> ' + ts.stopPrice);
      assert.equal(r.triggered, px <= ts.stopPrice, 'triggered iff price <= stop');
      prev = { ...ts };
    }
  }
});
await test('TS2', 'updateTrailingStop: a new peak writes peak and stop = peak x (1 - trail); a lower price writes nothing', async () => {
  const e = env();
  await e.api.setTrailingStop('CC-USD', 10, 1.0, null, true);
  const before = e.calls.length;
  await e.api.updateTrailingStop('CC-USD', 0.95);
  assert.equal(e.calls.length, before, 'no db write on a lower price');
  assert.equal(e.trailingStops.get('CC-USD').peakPrice, 1.0);
  await e.api.updateTrailingStop('CC-USD', 2.0);
  const ts = e.trailingStops.get('CC-USD');
  assert.equal(ts.peakPrice, 2.0); assert.ok(Math.abs(ts.stopPrice - 1.8) < 1e-12);
  const upd = e.calls.filter(c => c[0] === 'db' && /^UPDATE trailing_stops SET peak_price/.test(c[1]));
  assert.equal(upd.length, 1); assert.deepEqual(plain(upd[0][2]), [2.0, ts.stopPrice, 'CC-USD']);
});
await test('TS3', 'updateTrailingStop: a breach on a flat (dust) position clears the trail instead of triggering', async () => {
  const e = env({ held: 0.1 });
  await e.api.setTrailingStop('CC-USD', 10, 1.0, null, true);
  const r = await e.api.updateTrailingStop('CC-USD', 0.5);
  assert.equal(r.triggered, false); assert.equal(r.suppressed, 'flat_position');
  assert.equal(e.trailingStops.has('CC-USD'), false);
});
await test('TS4', 'setTrailingStop: autoExecute null/undefined keeps the existing value, true/false set it', async () => {
  const e = env();
  const s = (ae) => e.api.setTrailingStop('CC-USD', 10, 1, null, ae);
  await s(true);  assert.equal(e.trailingStops.get('CC-USD').autoExecute, true);
  await s(null);  assert.equal(e.trailingStops.get('CC-USD').autoExecute, true, 'null keeps true');
  await s(undefined); assert.equal(e.trailingStops.get('CC-USD').autoExecute, true, 'undefined keeps true');
  await s(false); assert.equal(e.trailingStops.get('CC-USD').autoExecute, false, 'false is honoured (lowering works)');
  await s(null);  assert.equal(e.trailingStops.get('CC-USD').autoExecute, false, 'null keeps false');
  const e2 = env();
  const r = await e2.api.setTrailingStop('NEW-USD', 10, 1, null, null);
  assert.equal(r.autoExecute, false, 'no existing trail + null -> off');
  const p = upsertParams(e.calls).map(x => x[5]);
  assert.deepEqual(p, [1, 1, 1, 0, 0], 'auto_execute written to the DB each time');
});
await test('TS5', 'setTrailingStop: source is kept unless a new one is given; sellPct / exchange kept when not given', async () => {
  const e = env();
  await e.api.setTrailingStop('CC-USD', 15, 1, null, true, 100, 'revolut', 'spike');
  await e.api.setTrailingStop('CC-USD', 10, 2);   // a re-anchor passes nothing
  let ts = e.trailingStops.get('CC-USD');
  assert.equal(ts.source, 'spike'); assert.equal(ts.sellPct, 100); assert.equal(ts.exchange, 'revolut'); assert.equal(ts.autoExecute, true);
  await e.api.setTrailingStop('CC-USD', 10, 2, null, null, null, null, 'loop');
  assert.equal(e.trailingStops.get('CC-USD').source, 'loop', 'a new source replaces it');
  const last = upsertParams(e.calls).pop();
  assert.equal(last[8], 'loop', 'source written to the DB');
  await e.api.setTrailingStop('CC-USD', 10, 2);
  assert.equal(e.trailingStops.get('CC-USD').source, 'loop');
});
await test('TS6', 'restoreTrailingStop: puts the trail back EXACTLY (peak, stop, autoExecute, source) - no re-anchor', async () => {
  const e = env();
  const saved = { trailPct: 12, peakPrice: 3.3, stopPrice: 2.904, entryPrice: 1.1, autoExecute: true, sellPct: 50, exchange: 'kraken', source: 'spike' };
  await e.api.restoreTrailingStop('CC-USD', saved);
  assert.deepEqual(plain(e.trailingStops.get('CC-USD')), saved);
  assert.deepEqual(upsertParams(e.calls)[0], ['CC-USD', 12, 3.3, 2.904, 1.1, 1, 50, 'kraken', 'spike']);
  const e2 = env();
  await e2.api.restoreTrailingStop('CC-USD', { trailPct: 5, peakPrice: 1, stopPrice: 0.95, entryPrice: null, autoExecute: false });
  assert.deepEqual(upsertParams(e2.calls)[0], ['CC-USD', 5, 1, 0.95, null, 0, 25, 'revolut', null], 'defaults for missing sellPct / exchange / source');
});
report();
