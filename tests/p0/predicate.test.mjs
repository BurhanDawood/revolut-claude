// #P0 spec P0 rev 3 §5 - the predicate vectors (V1-V32, V37-V43, V45) against the REAL mayAutoTrade and its REAL helpers
// (computeDerivedFloor, edgeSellCheck, isDndCoin, isAwayActionable, effectiveCeilingPct...) extracted from server.js,
// with every read mocked: db.execute (SQL router over a per-test "world"), revolutRequest, krakenRequest.
// Run: node tests/p0/predicate.test.mjs
import assert from 'node:assert/strict';
import { readServer, extractFunction, extractConst, strictSandbox, runner, plain } from './harness.mjs';

const SRC = readServer();
const FUNCS = ['mayAutoTrade', 'effectiveCeilingPct', 'ceilingOverrideErrors', 'recordManualDecision', 'computeDerivedFloor', 'derivedFloorFrom',
  'edgeSellCheck', 'coinSellSlipP90', 'isDndCoin', 'getDndMode', 'isAwayActionable', 'krakenAssetToStandard'];
const CONSTS = ['CEILING_DEFAULT_PCT', 'FLOOR_BUFFER_PCT', 'STOP_CLEARANCE_MULT', 'LADDER_DEFAULTS', 'KRAKEN_TO_STANDARD'];
const CODE = CONSTS.map(c => extractConst(SRC, c)).join('\n') + '\n' + FUNCS.map(f => extractFunction(SRC, f)).join('\n');

const NOW = Date.parse('2026-09-24T12:00:00Z');
const H = 3600000, D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const FLOOR = 0.10 * (1 + 0.5 / 100);   // derivedFloorFrom: cost 0.10 + 0.5%

// Forbidden in-memory state (spec §3.3) exists in the sandbox, populated to say "YES" (HONEY / #390 / F3 / F6 shapes),
// behind tripwires: any read by the predicate is recorded and fails the vector.
const FORBIDDEN = ['alertState', 'ignoredCoins', 'alertContextBySymbol', 'targetReminderCount', 'trailingStopReminderCount', 'analysisRateLimit',
  '_watchdog', '_pauseHeld', 'troughTrackers', 'standaloneTroughTrackers', 'trailingStops', 'entryPrices', 'priceTargets', 'pendingUndo',
  'pendingRevolutTrade', 'pendingKrakenTrade', 'fastScanLastPrice', 'lastKnown'];
function tripwires(touched) {
  const real = {
    alertState: { acknowledged: new Set(['CC-USD', 'CC']) },
    trailingStops: new Map([['CC-USD', { autoExecute: true, peakPrice: 1, stopPrice: 0.9 }]]),
    entryPrices: new Map([['CC-USD', 999]]),
  };
  const g = {};
  for (const n of FORBIDDEN) {
    const target = real[n] || new Map();
    g[n] = new Proxy(target, { get(t, k) { touched.push(n + '.' + String(k)); const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
  }
  return g;
}

function baseWorld() {
  return {
    cfg: { enabled: true, allowed_triggers: ['trailing_stop'], require_confidence: 'High', manual_only_symbols: [], hodl_symbols: [], per_coin_enabled: {} },
    rule: { symbol: 'CC-USD', active: 1, loop_enabled: 1, armed: 1, sell_pct: '100.0000', entry_floor: null, sale_price: null, sale_at: null,
      uncovered_since: null, abandon_hours: null, uncovered_abandon_hours: null, buyback_floor_pct: '5.0000', ceiling_pct: null, ceiling_override: null },
    cost: 0.10,                          // entry_prices -> floor = 0.1005
    sellFloors: null,
    slips: [],                           // < 10 enriched sells -> book p90 1.0 -> EDGE below 3%
    dnd: { enabled: false, coins: [] },
    away: { active: false, coins: [] },
    trailingTable: null,                 // { auto_execute }
    standalone: false,
    ladderSwitch: 'false', ladder: null, // { active, cfg, state }
    pendingOpen: false,
    balances: [{ currency: 'CC', available: '100', reserved: '0' }, { currency: 'USD', available: '500', reserved: '0' }],
    kraken: null,
  };
}

function makeEnv(world) {
  const sql = [], inserts = [], errors = [], touched = [];
  let nextId = 1;
  const rows = (r) => Promise.resolve([r]);
  const db = {
    execute(q, params = []) {
      sql.push(q);
      if (/INSERT INTO exec_decisions/.test(q)) {
        if (world.insertThrows) return Promise.reject(new Error('insert failed (mock)'));
        const id = nextId++; inserts.push({ id, q, params }); return Promise.resolve([{ insertId: id }]);
      }
      if (/config_key = 'ai_auto_execute'/.test(q)) {
        if (world.cfgThrows) return Promise.reject(new Error('db down (mock)'));
        if (world.cfgRaw !== undefined) return rows([{ config_value: world.cfgRaw }]);
        const c = world.sellFloors ? { ...world.cfg, sell_floors: world.sellFloors } : world.cfg;
        return rows(c ? [{ config_value: JSON.stringify(c) }] : []);
      }
      if (/config_key = 'dnd_mode'/.test(q)) return rows([{ config_value: JSON.stringify(world.dnd) }]);
      if (/config_key = 'away_mode'/.test(q)) return rows([{ config_value: JSON.stringify(world.away) }]);
      if (/config_key = 'ladder_live_enabled'/.test(q)) return rows([{ config_value: world.ladderSwitch }]);
      if (/FROM pump_armed_rules WHERE symbol = \? AND active = 1/.test(q)) return rows(world.rule && Number(world.rule.active) === 1 ? [world.rule] : []);
      if (/FROM entry_prices/.test(q)) return rows(world.cost != null ? [{ entry_price: world.cost }] : []);
      if (/FROM trading_journal/.test(q) && /slip_pct/.test(q)) return rows(world.slips.map(s => ({ slip_pct: s })));
      if (/FROM trailing_stops/.test(q)) return rows(world.trailingTable ? [world.trailingTable] : []);
      if (/FROM standalone_trough_trackers/.test(q)) return rows(world.standalone ? [{ 1: 1 }] : []);
      if (/FROM ladder_live/.test(q)) return rows(world.ladder ? [{ active: world.ladder.active, cfg: JSON.stringify(world.ladder.cfg || {}), state: world.ladder.state ? JSON.stringify(world.ladder.state) : null }] : []);
      if (/FROM pending_orders/.test(q)) return rows(world.pendingOpen ? [{ 1: 1 }] : []);
      return Promise.reject(new Error('UNMOCKED SQL: ' + q));
    },
  };
  const revolutRequest = async (method, path) => {
    if (method === 'GET' && path === '/balances') { if (world.balancesThrow) throw new Error('venue down (mock)'); return world.balances; }
    throw new Error('UNMOCKED revolutRequest ' + method + ' ' + path);
  };
  const krakenRequest = async (path) => {
    if (path === '/0/private/Balance') { if (world.krakenThrow) throw new Error('kraken down (mock)'); return world.kraken; }
    throw new Error('UNMOCKED krakenRequest ' + path);
  };
  const console_ = { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) };
  const api = strictSandbox({ db, revolutRequest, krakenRequest, console: console_, ...tripwires(touched) }, CODE, FUNCS);
  return { api, sql, inserts, errors, touched };
}

// One call = one world + one intent. Returns the result plus what the call did.
async function call(world, intent, opts = { mode: 'dry_run', nowMs: NOW }) {
  const env = makeEnv(world);
  const r = await env.api.mayAutoTrade(intent, opts);
  return { r, ...env };
}
const sell = (o = {}) => ({ symbol: 'CC-USD', side: 'sell', path: 'loop_trail', exchange: 'revolut', price: 0.2, qty: 100, ref: { sell_pct: 100 }, ...o });
const buy = (o = {}) => ({ symbol: 'CC-USD', side: 'buy', path: 'trough', exchange: 'revolut', price: 0.15, usd: 50, ...o });
function troughWorld(mut) {
  const w = baseWorld();
  w.rule.sale_price = '0.2000000000'; w.rule.sale_at = iso(NOW - 24 * H); w.rule.sale_proceeds_usd = 60;
  if (mut) mut(w);
  return w;
}
function ladderWorld(mut) {
  const w = baseWorld();
  w.rule.loop_enabled = 0;   // the ladder took the coin over from its single-mode loop
  w.ladderSwitch = 'true';
  w.ladder = { active: 1, cfg: { retention_floor_pct: 50 }, state: { phase: 'watch', qty: 100, retention_base: 100, reserved: 20, sold_qty: 100, last_sale_at: NOW - H } };
  if (mut) mut(w);
  return w;
}
// every call must leave exactly one exec_decisions row and never touch forbidden in-memory state
function common(c, mode = 'dry_run') {
  assert.equal(c.inserts.length, 1, 'exactly one exec_decisions row');
  assert.equal(c.inserts[0].params[0], mode, 'row mode');
  assert.deepEqual(c.touched, [], 'forbidden in-memory state was read: ' + c.touched.join(', '));
  assert.equal(c.r.decision_id, c.inserts[0].id);
}
const expectNo = (c, reason, checkNo) => { assert.equal(c.r.ok, false, 'ok'); assert.equal(c.r.reason, reason, 'reason'); if (checkNo !== undefined) assert.equal(c.r.check_no, checkNo, 'check_no'); };
const expectOk = (c) => { assert.equal(c.r.reason, 'ok', 'reason (inputs: ' + JSON.stringify(c.r.inputs) + ')'); assert.equal(c.r.ok, true); assert.equal(c.r.check_no, null); };

const { test, report } = runner('P0 predicate vectors (tests/p0/predicate.test.mjs)');
const all = [];   // every call, for V31
const T = (id, name, fn) => test(id, name, async () => { await fn(async (w, i, o) => { const c = await call(w, i, o); all.push({ id, c, mode: (o && o.mode) || 'dry_run' }); return c; }); });

await T('V1', 'HONEY (#397): loop_trail sell, loop_enabled 1, alertState.acknowledged has the symbol -> ok', async (run) => {
  const c = await run(baseWorld(), sell());
  expectOk(c); common(c);
  assert.equal(c.r.size_cap, 100); assert.equal(c.r.floor, FLOOR); assert.equal(c.r.edge, false);
});
await T('V2', '#390: loop_enabled 0, Map trail autoExecute true -> path_not_enabled, check 2', async (run) => {
  const w = baseWorld(); w.rule.loop_enabled = 0;
  const c = await run(w, sell()); expectNo(c, 'path_not_enabled', 2); common(c);
});
await T('V3', 'pm #50 / breaker: trough buy, loop_enabled 0 -> path_not_enabled', async (run) => {
  const c = await run(troughWorld(w => { w.rule.loop_enabled = 0; }), buy()); expectNo(c, 'path_not_enabled', 2); common(c);
});
await T('V4', 'F1: enabled false -> paused, check 1, on every path', async (run) => {
  const intents = [sell(), sell({ path: 'manual_trail' }), sell({ path: 'away_sell', trigger: 'fixed_target' }), sell({ path: 'ladder', trigger: 'trailing_stop' }),
    sell({ path: 'ai_analysis', trigger: 'pump_alert', confidence: 'High' }), buy(), buy({ path: 'trough_standalone' }), buy({ path: 'ladder' }),
    buy({ path: 'away_buy', confidence: 'High' }), buy({ path: 'ai_analysis', confidence: 'High' })];
  const paths = new Set();
  for (const i of intents) { const w = baseWorld(); w.cfg.enabled = false; const c = await run(w, i); expectNo(c, 'paused', 1); common(c); paths.add(i.path); }
  assert.equal(paths.size, 8, 'all eight paths covered');
});
await T('V5', 'F6 orphan: loop_trail, armed 0, loop_enabled 0, Map trail auto -> path_not_enabled', async (run) => {
  const w = baseWorld(); w.rule.armed = 0; w.rule.loop_enabled = 0;
  const c = await run(w, sell()); expectNo(c, 'path_not_enabled', 2); common(c);
});
await T('V6', 'F3: manual_trail, table auto_execute 0, Map true -> path_not_enabled', async (run) => {
  const w = baseWorld(); w.trailingTable = { auto_execute: 0 };
  const c = await run(w, sell({ path: 'manual_trail' })); expectNo(c, 'path_not_enabled', 2); common(c);
  const w2 = baseWorld(); w2.trailingTable = { auto_execute: 1 };   // control: the TABLE says yes -> passes check 2
  const c2 = await run(w2, sell({ path: 'manual_trail' })); expectOk(c2); common(c2);
});
await T('V7', 'coin rails empty, DND off -> passes check 3', async (run) => {
  const c = await run(baseWorld(), sell()); expectOk(c); assert.equal(c.r.inputs.manual_only, false); assert.equal(c.r.inputs.hodl, false); common(c);
});
await T('V8', 'manual_only + DND active -> manual_only', async (run) => {
  const w = baseWorld(); w.cfg.manual_only_symbols = ['CC']; w.dnd = { enabled: true, coins: ['CC'] };
  const c = await run(w, sell()); expectNo(c, 'manual_only', 3); common(c);
});
await T('V9', 'hodl + DND active -> passes check 3', async (run) => {
  const w = baseWorld(); w.cfg.hodl_symbols = ['CC']; w.dnd = { enabled: true, coins: ['CC'] };
  const c = await run(w, sell()); expectOk(c); assert.equal(c.r.inputs.hodl, true); assert.equal(c.r.inputs.dnd, true); common(c);
  const w2 = baseWorld(); w2.cfg.hodl_symbols = ['CC-USD'];   // control: hodl WITHOUT DnD blocks the sell
  const c2 = await run(w2, sell()); expectNo(c2, 'hodl', 3); common(c2);
});
await T('V10', 'trigger: loop_trail sell, allowed_triggers [] -> trigger_not_allowed (universal)', async (run) => {
  const w = baseWorld(); w.cfg.allowed_triggers = [];
  const c = await run(w, sell()); expectNo(c, 'trigger_not_allowed', 4); assert.equal(c.r.inputs.trigger, 'trailing_stop'); common(c);
  const w2 = baseWorld(); w2.trailingTable = { auto_execute: 1 }; w2.cfg.allowed_triggers = [];
  const c2 = await run(w2, sell({ path: 'manual_trail' })); expectNo(c2, 'trigger_not_allowed', 4); common(c2);
});
await T('V11', 'confidence: away_buy Medium vs High -> confidence_too_low', async (run) => {
  const w = baseWorld(); w.away = { active: true, coins: ['CC'], max_session_buy_usd: 200, session_bought_usd: 0 };
  const c = await run(w, buy({ path: 'away_buy', confidence: 'Medium' })); expectNo(c, 'confidence_too_low', 5); assert.equal(c.r.inputs.require_confidence, 'High'); common(c);
});
await T('V12', 'floor: price <= floor -> floor_blocked; no entry_prices row -> no_floor; floor returned', async (run) => {
  const c = await run(baseWorld(), sell({ price: FLOOR })); expectNo(c, 'floor_blocked', 6); assert.equal(c.r.floor, FLOOR); assert.equal(c.r.inputs.floor.cost, 0.1); common(c);
  const c1 = await run(baseWorld(), sell({ price: 0.09 })); expectNo(c1, 'floor_blocked', 6); common(c1);
  const w = baseWorld(); w.cost = null;
  const c2 = await run(w, sell()); expectNo(c2, 'no_floor', 6); assert.ok('floor' in c2.r); assert.equal(c2.r.floor, null); common(c2);
});
await T('V13', 'EDGE: clearance < 3 x p90 -> ok true, edge true', async (run) => {
  const c = await run(baseWorld(), sell({ price: FLOOR * 1.01 }));
  expectOk(c); assert.equal(c.r.edge, true); assert.equal(c.r.inputs.edge.edge, true); assert.equal(c.r.inputs.edge.required_pct, 3); common(c);
});
await T('V14', 'reserved coin: available 0, reserved 100 -> no_position', async (run) => {
  const w = baseWorld(); w.balances = [{ currency: 'CC', available: '0', reserved: '100' }, { currency: 'USD', available: '500' }];
  const c = await run(w, sell()); expectNo(c, 'no_position', 8); assert.equal(c.r.inputs.available, 0); common(c);
});
await T('V15', 'dust: available x price = 0.5 -> dust', async (run) => {
  const w = baseWorld(); w.cost = 0.05; w.balances = [{ currency: 'CC', available: '5', reserved: '0' }];
  const c = await run(w, sell({ price: 0.1, qty: 5 })); expectNo(c, 'dust', 8); common(c);
});
await T('V16', 'cash: buy $50, cash $3 -> insufficient_cash', async (run) => {
  const w = troughWorld(w => { w.balances = [{ currency: 'CC', available: '100' }, { currency: 'USD', available: '3' }]; });
  const c = await run(w, buy({ usd: 50 })); expectNo(c, 'insufficient_cash', 9); assert.equal(c.r.inputs.cash, 3); common(c);
});
await T('V17', 'above avg sale: trough buy at sale_price x 1.05 -> above_avg_sale', async (run) => {
  const c = await run(troughWorld(), buy({ price: 0.2 * 1.05 })); expectNo(c, 'above_avg_sale', 10); assert.equal(c.r.inputs.avg_sale, 0.2); common(c);
});
await T('V18', 'ceiling default: ceiling_pct NULL, no override, price = sale x 1.51 -> above_ceiling, pct 50', async (run) => {
  const c = await run(troughWorld(), buy({ price: 0.2 * 1.51 })); expectNo(c, 'above_ceiling', 10);
  assert.deepEqual(plain(c.r.inputs.ceiling), { pct: 50, source: 'default' }); common(c);
});
const ov = (days) => ({ value: 15, reason: 'PM #36 tight ceiling while the cycle is young', amount_usd: 60, expires_at: iso(NOW + days * D) });
await T('V19', 'ceiling override live: {15, expires +7d}, price = sale x 1.16 -> above_ceiling, pct 15', async (run) => {
  const c = await run(troughWorld(w => { w.rule.ceiling_override = JSON.stringify(ov(7)); }), buy({ price: 0.2 * 1.16 }));
  expectNo(c, 'above_ceiling', 10); assert.equal(c.r.inputs.ceiling.pct, 15); assert.match(c.r.inputs.ceiling.source, /^override until /); common(c);
});
await T('V20', 'ceiling override expired (-1d): sale x 1.16 passes the ceiling; pct 50, source default', async (run) => {
  const c = await run(troughWorld(w => { w.rule.ceiling_override = JSON.stringify(ov(-1)); }), buy({ price: 0.2 * 1.16 }));
  assert.notEqual(c.r.reason, 'above_ceiling'); assert.deepEqual(plain(c.r.inputs.ceiling), { pct: 50, source: 'default' });
  // (a) still applies: 1.16 x the sale is above the average sale (see the PR note on (c)-before-(a))
  expectNo(c, 'above_avg_sale', 10); common(c);
});
await T('V21', 'abandoned: sale_at now - 337 h -> abandoned', async (run) => {
  const c = await run(troughWorld(w => { w.rule.sale_at = iso(NOW - 337 * H); }), buy()); expectNo(c, 'abandoned', 10); common(c);
  const c2 = await run(troughWorld(w => { w.rule.sale_at = iso(NOW - 335 * H); }), buy()); expectOk(c2); common(c2);   // control: inside 336 h
});
await T('V22', 'abandoned (cash): uncovered_since now - 49 h -> abandoned', async (run) => {
  const c = await run(troughWorld(w => { w.rule.uncovered_since = iso(NOW - 49 * H); }), buy()); expectNo(c, 'abandoned', 10); common(c);
  const c2 = await run(troughWorld(w => { w.rule.uncovered_since = iso(NOW - 47 * H); }), buy()); expectOk(c2); common(c2);
});
await T('V23', 'retention (ladder): state.qty 100, base 100, pct 50, intent qty 60 -> ok, size_cap 50', async (run) => {
  const c = await run(ladderWorld(), sell({ path: 'ladder', trigger: 'trailing_stop', qty: 60, ref: {} }));
  expectOk(c); assert.equal(c.r.size_cap, 50); assert.deepEqual(plain(c.r.inputs.retention), { base: 100, pct: 50, sellable: 50 }); common(c);
});
await T('V24', 'retention exhausted: state.qty 50, base 100, pct 50 -> retention_floor', async (run) => {
  const c = await run(ladderWorld(w => { w.ladder.state.qty = 50; }), sell({ path: 'ladder', trigger: 'trailing_stop', qty: 60, ref: {} }));
  expectNo(c, 'retention_floor', 11); common(c);
});
await T('V25', 'retention not on single mode: loop_trail sell, sell_pct 100 -> size_cap = full available, no retention input', async (run) => {
  const c = await run(baseWorld(), sell({ qty: undefined, ref: { sell_pct: 100 } }));
  expectOk(c); assert.equal(c.r.size_cap, 100); assert.equal(c.r.inputs.retention, null); common(c);
});
await T('V26', 'open order: unfilled pending_orders row -> open_order', async (run) => {
  const w = baseWorld(); w.pendingOpen = true;
  const c = await run(w, sell()); expectNo(c, 'open_order', 12); assert.equal(c.r.inputs.open_order, true); common(c);
  assert.ok(c.sql.some(q => /status NOT IN \('filled','cancelled','rejected','replaced'\)/.test(q)));
});
await T('V27', 'max_sell_pct cap: cfg 25, ref.sell_pct 100, available 100 -> ok, size_cap 25', async (run) => {
  const w = baseWorld(); w.cfg.max_sell_pct = 25;
  const c = await run(w, sell()); expectOk(c); assert.equal(c.r.size_cap, 25); assert.equal(c.r.inputs.cap_pct, 25); common(c);
});
await T('V28', 'config unreadable: db.execute throws on system_config -> NO (config_unreadable per rev-3 P0-c, not "paused")', async (run) => {
  const w = baseWorld(); w.cfgThrows = true;
  const c = await run(w, sell()); expectNo(c, 'config_unreadable', 1); assert.notEqual(c.r.reason, 'paused'); common(c);
});
await T('V29', 'balances unreadable: /balances throws -> balances_unreadable, ok false', async (run) => {
  const w = baseWorld(); w.balancesThrow = true;
  const c = await run(w, sell()); expectNo(c, 'balances_unreadable', 8); common(c);
  const c2 = await run(troughWorld(w2 => { w2.balancesThrow = true; }), buy()); expectNo(c2, 'balances_unreadable', 9); common(c2);
  const w3 = baseWorld(); w3.balances = { message: 'Signature verification rejected' };   // an error envelope is not a balance list
  const c3 = await run(w3, sell()); expectNo(c3, 'balances_unreadable', 8); common(c3);
});
await T('V30', 'forbidden inputs (static): no FORBIDDEN name in mayAutoTrade / effectiveCeilingPct source', async () => {
  const env = makeEnv(baseWorld());
  const re = new RegExp('\\b(' + FORBIDDEN.join('|') + ')\\b');
  const text = env.api.mayAutoTrade.toString() + env.api.effectiveCeilingPct.toString();
  assert.ok(!re.test(text), 'found: ' + (text.match(re) || [])[0]);
  assert.ok(text.length > 1000, 'the real source was checked');
  // and dynamically: every forbidden name is a tripwire in every vector (common() asserts none was touched)
});
await T('V32', 'log failure is not a trade failure: INSERT throws -> result unchanged, decision_id null', async () => {
  const ok = await call(baseWorld(), sell());
  const w = baseWorld(); w.insertThrows = true;
  const bad = await call(w, sell());
  assert.equal(bad.r.decision_id, null);
  const strip = (r) => { const x = plain(r); delete x.decision_id; return x; };
  assert.deepEqual(strip(bad.r), strip(ok.r));
  assert.equal(bad.errors.length, 1, 'exactly one console.error'); assert.match(bad.errors[0], /exec_decisions insert failed/);
  const w2 = troughWorld(x => { x.insertThrows = true; x.rule.loop_enabled = 0; });   // a NO is unchanged too
  const bad2 = await call(w2, buy()); expectNo(bad2, 'path_not_enabled', 2); assert.equal(bad2.r.decision_id, null);
});
await T('V37', 'no live cycle: trough buy, sale_price NULL -> no_cycle, check 2', async (run) => {
  const c = await run(baseWorld(), buy()); expectNo(c, 'no_cycle', 2); common(c);
});
await T('V38', 'trough buy passes check 4: live cfg [trailing_stop], no trigger -> check 4 not evaluated, inputs.trigger null', async (run) => {
  const c = await run(troughWorld(), buy()); expectOk(c); assert.equal(c.r.inputs.trigger, null); assert.deepEqual(plain(c.r.inputs.allowed_triggers), ['trailing_stop']); common(c);
  const c2 = await run(troughWorld(w => { w.cfg.allowed_triggers = []; }), buy()); expectOk(c2); common(c2);   // not evaluated: even [] cannot stop a buy
});
await T('V39', 'ladder buy passes check 4: same cfg -> as V38', async (run) => {
  const c = await run(ladderWorld(), buy({ path: 'ladder', usd: 10 })); expectOk(c); assert.equal(c.r.inputs.trigger, null); assert.equal(c.r.inputs.avg_sale, 0.2); common(c);
  const c2 = await run(ladderWorld(w => { w.cfg.allowed_triggers = []; }), buy({ path: 'ladder', usd: 10 })); expectOk(c2); common(c2);
});
await T('V40', 'away_buy passes check 4: confidence High -> reaches check 9', async (run) => {
  const w = baseWorld(); w.away = { active: true, coins: ['CC'], max_session_buy_usd: 200, session_bought_usd: 0 };
  w.balances = [{ currency: 'USD', available: '3' }];
  const c = await run(w, buy({ path: 'away_buy', confidence: 'High', usd: 50 })); expectNo(c, 'insufficient_cash', 9); assert.equal(c.r.inputs.trigger, null); common(c);
  const w2 = baseWorld(); w2.away = { active: true, coins: ['CC'], max_session_buy_usd: 200, session_bought_usd: 180 };   // and on to check 13's session cap
  const c2 = await run(w2, buy({ path: 'away_buy', confidence: 'High', usd: 50 })); expectOk(c2); assert.equal(c2.r.size_cap, 20); common(c2);
});
await T('V41', 'sell with no trigger on a non-trail path: away_sell, trigger undefined -> invalid_intent, check 0', async (run) => {
  const w = baseWorld(); w.away = { active: true, coins: ['CC'] };
  const c = await run(w, sell({ path: 'away_sell' })); expectNo(c, 'invalid_intent', 0); common(c);
  assert.ok(!c.sql.some(q => /ai_auto_execute/.test(q)), 'check 0 fails before any read');
});
await T('V42', 'config unreadable is not "paused": system_config throws -> config_unreadable, ok false, inputs.enabled null', async (run) => {
  const w = baseWorld(); w.cfgThrows = true;
  const c = await run(w, buy({ path: 'trough' })); expectNo(c, 'config_unreadable', 1); assert.equal(c.r.inputs.enabled, null); common(c);
  const w2 = baseWorld(); w2.cfgRaw = '{not json';
  const c2 = await run(w2, sell()); expectNo(c2, 'config_unreadable', 1); assert.equal(c2.r.inputs.enabled, null); common(c2);
});
await T('V43', 'manual_only on a buy (P0-d decided, pm #49): list has coin, trough buy -> manual_only', async (run) => {
  const c = await run(troughWorld(w => { w.cfg.manual_only_symbols = ['CC']; }), buy()); expectNo(c, 'manual_only', 3); common(c);
});
await T('V45', 'stale abandoned window: sale_at now - 337 h, sale_price still set (cron not yet run) -> abandoned', async (run) => {
  const c = await run(troughWorld(w => { w.rule.sale_at = iso(NOW - 337 * H); }), buy());
  expectNo(c, 'abandoned', 10); assert.notEqual(c.r.reason, 'no_cycle'); assert.equal(c.r.inputs.avg_sale, 0.2); common(c);
});
await T('V31', 'every call logs: exactly one exec_decisions row with the right mode (all vectors above + each mode)', async () => {
  for (const x of all) { assert.equal(x.c.inserts.length, 1, x.id); assert.equal(x.c.inserts[0].params[0], x.mode, x.id); }
  for (const mode of ['dry_run', 'shadow', 'enforce']) {
    const c = await call(baseWorld(), sell(), { mode, nowMs: NOW });
    common(c, mode); expectOk(c);
    const p = c.inserts[0].params;
    assert.deepEqual(plain(p.slice(0, 6)), [mode, 'CC-USD', 'sell', 'loop_trail', 'trailing_stop', 'revolut']);
    assert.equal(p[9], 1); assert.equal(p[10], 'ok'); assert.equal(typeof JSON.parse(p[15]), 'object');
  }
  const d = await call(baseWorld(), sell(), {});   // no mode -> dry_run
  common(d, 'dry_run');
  assert.ok(all.length >= 40, 'calls counted: ' + all.length);
});

// Extra coverage (not spec vectors): the reads each path makes, the Kraken balance read, the decision row fields.
await T('X1', 'path opt-in sources: trough_standalone table row, ladder switch + row, away, ai_analysis per_coin_enabled', async (run) => {
  const w = baseWorld(); const c = await run(w, buy({ path: 'trough_standalone' })); expectNo(c, 'path_not_enabled', 2); common(c);
  w.standalone = true; const c2 = await run(w, buy({ path: 'trough_standalone' })); expectOk(c2); common(c2);
  const l = ladderWorld(x => { x.ladderSwitch = 'false'; }); const c3 = await run(l, sell({ path: 'ladder', trigger: 'trailing_stop' })); expectNo(c3, 'path_not_enabled', 2); common(c3);
  const l2 = ladderWorld(x => { x.ladder.active = 0; }); const c4 = await run(l2, sell({ path: 'ladder', trigger: 'trailing_stop' })); expectNo(c4, 'path_not_enabled', 2); common(c4);
  const a = baseWorld(); const c5 = await run(a, sell({ path: 'away_sell', trigger: 'fixed_target' })); expectNo(c5, 'path_not_enabled', 2); common(c5);
  a.away = { active: true, coins: ['CC'] }; a.cfg.allowed_triggers = ['trailing_stop'];
  const c6 = await run(a, sell({ path: 'away_sell', trigger: 'fixed_target' })); expectNo(c6, 'trigger_not_allowed', 4); common(c6);   // §6: Away fixed_target is trigger_not_allowed on the live cfg
  const ai = baseWorld(); const c7 = await run(ai, sell({ path: 'ai_analysis', trigger: 'pump_alert', confidence: 'High' })); expectNo(c7, 'path_not_enabled', 2); common(c7);
  ai.cfg.per_coin_enabled = { CC: true }; ai.cfg.allowed_triggers = ['trailing_stop', 'pump_alert'];
  const c8 = await run(ai, sell({ path: 'ai_analysis', trigger: 'pump_alert', confidence: 'High' })); expectOk(c8); common(c8);
  const d = baseWorld(); d.rule.loop_enabled = 0; d.dnd = { enabled: true, coins: ['CC'] };
  const c9 = await run(d, sell()); expectOk(c9); assert.equal(c9.r.inputs.dnd, true); common(c9);   // DnD opts a loop in (check 2)
});
await T('X2', 'check 0: malformed intents -> invalid_intent (and still one row where the table can hold it)', async (run) => {
  for (const i of [sell({ symbol: 'CC' }), sell({ exchange: 'binance' }), sell({ price: 0 }), sell({ price: 'x' }), sell({ path: 'nope' }),
    buy({ path: 'loop_trail' }), sell({ path: 'trough' }), sell({ trigger: 'moon' }), buy({ usd: -5 }), buy({ path: 'away_buy', confidence: 'Very' })]) {
    const c = await run(baseWorld(), i); expectNo(c, 'invalid_intent', 0); common(c);
  }
  const c = await call(baseWorld(), null); expectNo(c, 'invalid_intent', 0);
});
await T('X3', 'Kraken: Balance read for position and cash; failure -> balances_unreadable', async (run) => {
  const w = baseWorld(); w.kraken = { CC: '100', ZUSD: '40' };
  const c = await run(w, sell({ exchange: 'kraken' })); expectOk(c); assert.equal(c.r.inputs.available, 100); common(c);
  const t = troughWorld(x => { x.kraken = { ZUSD: '40' }; }); const c2 = await run(t, buy({ exchange: 'kraken', usd: 50 })); expectNo(c2, 'insufficient_cash', 9); assert.equal(c2.r.inputs.cash, 40); common(c2);
  const k = baseWorld(); k.krakenThrow = true; const c3 = await run(k, sell({ exchange: 'kraken' })); expectNo(c3, 'balances_unreadable', 8); common(c3);
});
await T('X4', 'rebuy floor (b): entry_floor 0.18, buyback_floor_pct 5 -> below 0.171 is below_rebuy_floor', async (run) => {
  const c = await run(troughWorld(w => { w.rule.entry_floor = '0.18'; }), buy({ price: 0.17 })); expectNo(c, 'below_rebuy_floor', 10); assert.ok(Math.abs(c.r.inputs.rebuy_floor - 0.171) < 1e-12); common(c);
  const c2 = await run(troughWorld(w => { w.rule.entry_floor = '0.18'; }), buy({ price: 0.172 })); expectOk(c2); common(c2);
});
await T('X5', 'the predicate never mutates: every SQL it ran is a SELECT except its one exec_decisions INSERT', async () => {
  for (const x of all) for (const q of x.c.sql) assert.ok(/^\s*SELECT/i.test(q) || /^INSERT INTO exec_decisions/.test(q), x.id + ': ' + q);
});
await T('X6', 'effectiveCeilingPct / ceilingOverrideErrors', async () => {
  const { api } = makeEnv(baseWorld());
  assert.deepEqual(plain(api.effectiveCeilingPct({ ceiling_pct: null }, NOW)), { pct: 50, source: 'default' });
  assert.deepEqual(plain(api.effectiveCeilingPct({ ceiling_pct: '30.00' }, NOW)), { pct: 30, source: 'stored' });
  assert.deepEqual(plain(api.effectiveCeilingPct(null, NOW)), { pct: 50, source: 'default' });
  assert.equal(api.effectiveCeilingPct({ ceiling_override: '{bad' }, NOW).pct, 50);
  assert.deepEqual(plain(api.ceilingOverrideErrors(ov(7), NOW)), []);
  assert.ok(api.ceilingOverrideErrors({ ...ov(7), expires_at: undefined }, NOW).some(e => /expires_at is required/.test(e)));
  assert.ok(api.ceilingOverrideErrors({ ...ov(7), value: 50 }, NOW).length);
  assert.ok(api.ceilingOverrideErrors({ ...ov(7), value: 0 }, NOW).length);
  assert.ok(api.ceilingOverrideErrors({ ...ov(7), amount_usd: 0 }, NOW).length);
  assert.ok(api.ceilingOverrideErrors({ ...ov(91) }, NOW).length);
  assert.ok(api.ceilingOverrideErrors({ ...ov(-1) }, NOW).length);
  assert.ok(api.ceilingOverrideErrors({ ...ov(7), reason: 'too short' }, NOW).length);
  assert.ok(api.ceilingOverrideErrors({ ...ov(7), expires_at: 'next week' }, NOW).length);
});

if (report()) process.exit(1);
