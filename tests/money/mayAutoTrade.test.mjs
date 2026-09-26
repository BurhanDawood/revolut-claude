// T1 (h) mayAutoTrade: paused, manual_only, hodl and path-not-enabled refuse, with the right reason (and check number).
// The real predicate and its real helpers run; every read (db, Revolut X, Kraken) is a stub over a per-test "world".
// Run: node tests/money/mayAutoTrade.test.mjs
import assert from 'node:assert/strict';
import { readServer, extractFunction, extractConst, strictSandbox, runner } from '../lib.mjs';

const SRC = readServer();
const FUNCS = ['mayAutoTrade', 'effectiveCeilingPct', 'ceilingOverrideErrors', 'recordManualDecision', 'computeDerivedFloor', 'derivedFloorFrom',
  'edgeSellCheck', 'coinSellSlipP90', 'isDndCoin', 'getDndMode', 'isAwayActionable', 'krakenAssetToStandard'];
const CONSTS = ['CEILING_DEFAULT_PCT', 'FLOOR_BUFFER_PCT', 'STOP_CLEARANCE_MULT', 'LADDER_DEFAULTS', 'KRAKEN_TO_STANDARD'];
const CODE = CONSTS.map(c => extractConst(SRC, c)).join('\n') + '\n' + FUNCS.map(f => extractFunction(SRC, f)).join('\n');
const { test, report } = runner('T1 money: mayAutoTrade refusals (tests/money/mayAutoTrade.test.mjs)');
const NOW = Date.parse('2026-09-26T12:00:00Z');

const world = (mut) => {
  const w = {
    cfg: { enabled: true, allowed_triggers: ['trailing_stop', 'pump_alert'], require_confidence: 'High', manual_only_symbols: [], hodl_symbols: [], per_coin_enabled: {} },
    rule: { symbol: 'CC-USD', active: 1, loop_enabled: 1, armed: 1, sell_pct: '100', entry_floor: null, sale_price: null, sale_at: null, buyback_floor_pct: '5', ceiling_pct: null, ceiling_override: null },
    dnd: { enabled: false, coins: [] }, away: { active: false, coins: [] }, trailingTable: { auto_execute: 1 }, standalone: true,
    balances: [{ currency: 'CC', available: '100', reserved: '0' }, { currency: 'USD', available: '500', reserved: '0' }],
  };
  if (mut) mut(w);
  return w;
};
async function call(w, intent) {
  const inserts = [];
  const rows = (r) => Promise.resolve([r]);
  const db = { execute(q, p = []) {
    if (/INSERT INTO exec_decisions/.test(q)) { inserts.push(p); return Promise.resolve([{ insertId: inserts.length }]); }
    if (/config_key = 'ai_auto_execute'/.test(q)) return rows([{ config_value: JSON.stringify(w.cfg) }]);
    if (/config_key = 'dnd_mode'/.test(q)) return rows([{ config_value: JSON.stringify(w.dnd) }]);
    if (/config_key = 'away_mode'/.test(q)) return rows([{ config_value: JSON.stringify(w.away) }]);
    if (/config_key = 'ladder_live_enabled'/.test(q)) return rows([{ config_value: 'false' }]);
    if (/FROM pump_armed_rules WHERE symbol = \? AND active = 1/.test(q)) return rows(w.rule ? [w.rule] : []);
    if (/FROM entry_prices/.test(q)) return rows([{ entry_price: 0.1 }]);
    if (/slip_pct/.test(q)) return rows([]);
    if (/FROM trailing_stops/.test(q)) return rows(w.trailingTable ? [w.trailingTable] : []);
    if (/FROM standalone_trough_trackers/.test(q)) return rows(w.standalone ? [{ 1: 1 }] : []);
    if (/FROM ladder_live/.test(q)) return rows([]);
    if (/FROM pending_orders/.test(q)) return rows([]);
    return Promise.reject(new Error('UNMOCKED SQL: ' + q));
  } };
  const revolutRequest = async (m, p) => { if (p === '/balances') return w.balances; throw new Error('UNMOCKED ' + p); };
  const krakenRequest = async (p) => { throw new Error('UNMOCKED ' + p); };
  const api = strictSandbox({ db, revolutRequest, krakenRequest, console: { log() {}, warn() {}, error() {} } }, CODE, ['mayAutoTrade']);
  const r = await api.mayAutoTrade(intent, { mode: 'dry_run', nowMs: NOW });
  assert.equal(inserts.length, 1, 'one exec_decisions row per call');
  return r;
}
const sell = (o = {}) => ({ symbol: 'CC-USD', side: 'sell', path: 'loop_trail', exchange: 'revolut', price: 0.2, qty: 100, ref: { sell_pct: 100 }, ...o });
const buy = (o = {}) => ({ symbol: 'CC-USD', side: 'buy', path: 'trough_standalone', exchange: 'revolut', price: 0.15, usd: 50, ...o });
const no = (r, reason, check) => { assert.equal(r.ok, false, 'refused'); assert.equal(r.reason, reason); assert.equal(r.check_no, check, 'check_no for ' + reason); };

await test('MA0', 'control: the same world and intents pass when nothing refuses', async () => {
  const r = await call(world(), sell()); assert.equal(r.reason, 'ok'); assert.equal(r.ok, true);
});
await test('MA1', 'paused (enabled false or missing) -> paused, check 1, sells and buys, every path', async () => {
  for (const enabled of [false, undefined, 'true', 1]) {
    for (const i of [sell(), sell({ path: 'manual_trail' }), sell({ path: 'ai_analysis', trigger: 'pump_alert', confidence: 'High' }), buy(), buy({ path: 'trough' })]) {
      no(await call(world(w => { w.cfg.enabled = enabled; }), i), 'paused', 1);
    }
  }
});
await test('MA2', 'manual_only -> manual_only, check 3, on sells AND buys, even with DND on the coin', async () => {
  for (const list of [['CC'], ['CC-USD'], ['cc']]) {
    no(await call(world(w => { w.cfg.manual_only_symbols = list; }), sell()), 'manual_only', 3);
    no(await call(world(w => { w.cfg.manual_only_symbols = list; }), buy()), 'manual_only', 3);
    no(await call(world(w => { w.cfg.manual_only_symbols = list; w.dnd = { enabled: true, coins: ['CC'] }; }), sell()), 'manual_only', 3);
  }
});
await test('MA3', 'hodl -> hodl, check 3, on a sell (DND on the coin overrides it; a buy is not a hodl refusal)', async () => {
  no(await call(world(w => { w.cfg.hodl_symbols = ['CC']; }), sell()), 'hodl', 3);
  no(await call(world(w => { w.cfg.hodl_symbols = ['CC-USD']; }), sell({ path: 'manual_trail' })), 'hodl', 3);
  const dnd = await call(world(w => { w.cfg.hodl_symbols = ['CC']; w.dnd = { enabled: true, coins: ['CC'] }; }), sell());
  assert.notEqual(dnd.reason, 'hodl');
  const b = await call(world(w => { w.cfg.hodl_symbols = ['CC']; }), buy());
  assert.notEqual(b.reason, 'hodl');
});
await test('MA4', 'path not enabled -> path_not_enabled, check 2, for each path opt-in source', async () => {
  no(await call(world(w => { w.rule.loop_enabled = 0; }), sell()), 'path_not_enabled', 2);                        // loop switched off
  no(await call(world(w => { w.rule = null; }), sell()), 'path_not_enabled', 2);                                 // no loop at all
  no(await call(world(w => { w.trailingTable = { auto_execute: 0 }; }), sell({ path: 'manual_trail' })), 'path_not_enabled', 2);
  no(await call(world(w => { w.trailingTable = null; }), sell({ path: 'manual_trail' })), 'path_not_enabled', 2);
  no(await call(world(w => { w.standalone = false; }), buy()), 'path_not_enabled', 2);
  no(await call(world(), sell({ path: 'ai_analysis', trigger: 'pump_alert', confidence: 'High' })), 'path_not_enabled', 2);   // per_coin_enabled empty
  no(await call(world(), sell({ path: 'away_sell', trigger: 'fixed_target' })), 'path_not_enabled', 2);          // away mode off
  no(await call(world(), buy({ path: 'ladder' })), 'path_not_enabled', 2);                                       // ladder switch off
});
await test('MA5', 'order of refusals: paused beats path_not_enabled beats manual_only', async () => {
  no(await call(world(w => { w.cfg.enabled = false; w.rule.loop_enabled = 0; w.cfg.manual_only_symbols = ['CC']; }), sell()), 'paused', 1);
  no(await call(world(w => { w.rule.loop_enabled = 0; w.cfg.manual_only_symbols = ['CC']; }), sell()), 'path_not_enabled', 2);
});
report();
