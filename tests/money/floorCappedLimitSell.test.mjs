// T1 (a) floorCappedLimitSell: the limit price is never below the floor and is rounded UP to the pair's quote step;
// remainder_resting is true only when the cancel did not confirm.
// Run: node tests/money/floorCappedLimitSell.test.mjs
import assert from 'node:assert/strict';
import { readServer, extractFunction, extractConst, strictSandbox, runner, rng, quiet } from '../lib.mjs';

const SRC = readServer();
const CODE = [extractConst(SRC, 'EDGE_LIMIT_WAIT_MS'), extractFunction(SRC, 'priceDecimals'), extractFunction(SRC, 'floorCappedLimitSell')].join('\n');
const { test, report } = runner('T1 money: floorCappedLimitSell (tests/money/floorCappedLimitSell.test.mjs)');

// states: the order states GET /orders/:id returns, in order (the last repeats); cancel: 'ok' | 'fail' | 'throw'
function env({ states = ['filled'], filled = 0, cancel = 'ok', stateAfterCancel } = {}) {
  const calls = [];
  let reads = 0, cancelled = false;
  const revolutRequest = async (method, path, body, q, o) => {
    calls.push([method, path]);
    if (method === 'GET' && path.startsWith('/orders/')) {
      const s = cancelled && stateAfterCancel ? stateAfterCancel : states[Math.min(reads++, states.length - 1)];
      return { data: { state: s, filled_quantity: filled, average_fill_price: filled ? 1.5 : null } };
    }
    if (method === 'DELETE') {
      cancelled = true;
      if (cancel === 'throw') throw new Error('socket hang up');
      return cancel === 'ok' ? { ok: true, status: 204 } : { ok: false, status: 500, body: { error: 'x' } };
    }
    throw new Error('UNMOCKED ' + method + ' ' + path);
  };
  const placeRevolutOrder = async (...a) => { calls.push(['place', ...a]); return { data: { venue_order_id: 'V-1' } }; };
  const db = { execute: async () => [{}] };
  const api = strictSandbox({ revolutRequest, placeRevolutOrder, db, console: quiet, getPairQuoteStep: async () => null }, CODE, ['floorCappedLimitSell']);
  const run = (floor, step, ref) => api.floorCappedLimitSell('CC-USD', 100, floor, ref || floor * 1.01, 'cid-1', { quoteStep: step, sleep: async () => {}, polls: 2 });
  return { run, calls };
}
const isMultiple = (x, step) => { const k = x / step; return Math.abs(k - Math.round(k)) < 1e-6; };

await test('FL1', 'limit is the floor rounded UP to the quote step (a place order at that price, type limit)', async () => {
  for (const [floor, step, want] of [[0.123456, 0.001, 0.124], [0.125, 0.001, 0.125], [1.00001, 0.01, 1.01], [0.30000000001, 0.1, 0.4], [95.2, 0.5, 95.5], [0.00001234, 0.0000001, 0.0000124]]) {
    const e = env();
    const r = await e.run(floor, step);
    assert.equal(r.limit_price, want, 'floor ' + floor + ' step ' + step);
    const place = e.calls.find(c => c[0] === 'place');
    assert.equal(place[3], 'limit', 'a limit order, never market');
    assert.equal(Number(place[5]), want, 'the price sent is the rounded limit');
    assert.equal(r.step, step);
  }
});
await test('FL2', 'property: 2000 random floors x steps -> limit >= floor, a whole multiple of the step, less than one step above', async () => {
  const R = rng(7);
  const steps = [1, 0.5, 0.1, 0.05, 0.01, 0.001, 0.0005, 0.0001, 0.00001, 0.000001, 1e-7, 1e-8];
  for (let i = 0; i < 2000; i++) {
    const step = steps[Math.floor(R() * steps.length)];
    const floor = Number((step * (1 + R() * 5000)).toPrecision(1 + Math.floor(R() * 12)));
    const r = await env().run(floor, step);
    assert.ok(r.limit_price >= floor, 'limit ' + r.limit_price + ' < floor ' + floor + ' (step ' + step + ')');
    assert.ok(isMultiple(r.limit_price, step), 'limit ' + r.limit_price + ' not on step ' + step);
    assert.ok(r.limit_price - floor < step * (1 + 1e-6), 'limit ' + r.limit_price + ' more than a step above floor ' + floor);
  }
});
await test('FL3', 'no quote step known -> still never below the floor (rounded up at 5 significant figures)', async () => {
  const R = rng(11);
  for (let i = 0; i < 1000; i++) {
    const floor = Number((Math.pow(10, -6 + R() * 10)).toPrecision(1 + Math.floor(R() * 12)));
    const r = await env().run(floor, null);
    assert.ok(r.limit_price >= floor, 'limit ' + r.limit_price + ' < floor ' + floor);
    assert.equal(r.step, null);
  }
});
await test('FL4', 'filled at once -> no cancel sent, remainder_resting false', async () => {
  const e = env({ states: ['filled'], filled: 100 });
  const r = await e.run(1.2, 0.01);
  assert.equal(r.remainder_resting, false); assert.equal(r.filled_qty, 100);
  assert.ok(!e.calls.some(c => c[0] === 'DELETE'), 'no cancel for a filled order');
});
await test('FL5', 'unfilled, cancel confirmed (HTTP ok) -> cancelled true, remainder_resting false', async () => {
  const e = env({ states: ['new'], cancel: 'ok', stateAfterCancel: 'cancelled' });
  const r = await e.run(1.2, 0.01);
  assert.equal(r.cancelled, true); assert.equal(r.remainder_resting, false); assert.equal(r.filled_qty, 0);
  const e2 = env({ states: ['new'], cancel: 'ok' });   // the venue still says 'new' after an OK cancel: the cancel confirmed, so not resting
  assert.equal((await e2.run(1.2, 0.01)).remainder_resting, false);
});
await test('FL6', 'unfilled, cancel NOT confirmed (HTTP error / thrown) -> remainder_resting true, cancel_error set', async () => {
  for (const cancel of ['fail', 'throw']) {
    const e = env({ states: ['new'], cancel });
    const r = await e.run(1.2, 0.01);
    assert.equal(r.cancelled, false, cancel); assert.equal(r.remainder_resting, true, cancel); assert.ok(r.cancel_error, cancel);
  }
  const p = env({ states: ['partially_filled'], filled: 40, cancel: 'fail' });   // part-filled + failed cancel: resting, and the fill is reported
  const rp = await p.run(1.2, 0.01);
  assert.equal(rp.remainder_resting, true); assert.equal(rp.filled_qty, 40);
});
await test('FL7', 'cancel failed but the venue itself already cancelled / rejected / filled it -> not resting', async () => {
  for (const s of ['cancelled', 'rejected', 'expired']) {
    const e = env({ states: [s], cancel: 'fail' });
    assert.equal((await e.run(1.2, 0.01)).remainder_resting, false, s);
  }
  const e = env({ states: ['new'], cancel: 'fail', stateAfterCancel: 'filled', filled: 100 });
  assert.equal((await e.run(1.2, 0.01)).remainder_resting, false, 'filled while cancelling');
});
await test('FL8', 'an order with no venue id throws (the caller treats it as sent - never silently "nothing happened")', async () => {
  const api = strictSandbox({ revolutRequest: async () => ({}), placeRevolutOrder: async () => ({ data: {} }), db: { execute: async () => [{}] }, console: quiet }, CODE, ['floorCappedLimitSell']);
  await assert.rejects(api.floorCappedLimitSell('CC-USD', 1, 1, 1, null, { quoteStep: 0.01, sleep: async () => {} }), /no venue order id/);
});
report();
