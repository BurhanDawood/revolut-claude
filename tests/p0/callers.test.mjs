// #P0 spec P0 rev 3 §5 - the vectors outside the predicate: V33 (manual_approved), V44 (manual_detected), V34 (inert),
// V35 (ceiling_override write-time rule), V36 (max_sell_pct warning), plus the predicate_check dry run and loop_audit's
// ceiling column. The changed legacy paths are run TWICE - the base version (main) and this branch - against the same
// mocks, and every side effect they attempt is compared: the only allowed difference is the one exec_decisions row.
// Run: node tests/p0/callers.test.mjs
import assert from 'node:assert/strict';
import { readServer, readBase, extractFunction, extractConst, extractTool, topLevelFunctions, looseSandbox, strictSandbox, zStub, runner, plain } from './harness.mjs';

const SRC = readServer();
const BASE = readBase();
const { test, report } = runner('P0 callers, tools and inert proof (tests/p0/callers.test.mjs)');
const NEW_HELPERS = ['CEILING_DEFAULT_PCT'].map(c => extractConst(SRC, c)).join('\n') + '\n' +
  ['effectiveCeilingPct', 'ceilingOverrideErrors', 'recordManualDecision'].map(f => extractFunction(SRC, f)).join('\n');
let _fns = null;   // top-level functions of this branch and of main, parsed once (slow: ~240 functions each)
const fns = () => (_fns = _fns || { now: topLevelFunctions(SRC), was: topLevelFunctions(BASE) });
const isExec = (q) => /INSERT INTO exec_decisions/.test(q);
const quiet = { log() {}, warn() {}, error() {} };
const logger = (calls) => ({ log() {}, warn() {}, error: (...a) => calls.push(['console.error', a.map(String)]) });   // errors become part of the compared trace

// A recording db: every call is logged as ['db', sql, params]; `answer(sql, params)` supplies the rows.
function recDb(calls, answer) {
  let id = 100;
  return { execute(q, p = []) {
    calls.push(['db', q.replace(/\s+/g, ' ').trim(), p]);
    const a = answer ? answer(q, p) : undefined;
    if (a instanceof Error) return Promise.reject(a);
    if (a !== undefined) return Promise.resolve(a);
    if (isExec(q)) return Promise.resolve([{ insertId: 9001, affectedRows: 1 }]);   // own id space: the comparison with main stays aligned
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(q)) return Promise.resolve([{ insertId: ++id, affectedRows: 1 }]);
    return Promise.resolve([[]]);
  } };
}
const rec = (calls, name, ret) => (...a) => { calls.push([name, a]); return typeof ret === 'function' ? ret(...a) : ret; };
// JSON copy with wall-clock timestamps blanked (both runs call new Date() at slightly different instants)
const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? '<now>' : v)));
const withoutExec = (calls) => norm(calls.filter(c => !(c[0] === 'db' && isExec(c[1]))));
// timers are recorded, never scheduled (autoLogTrade arms a 30-minute auto-complete)
const fakeTimer = (calls) => (fn, ms) => { calls.push(['setTimeout', [ms]]); return 0; };
const execRows = (calls) => calls.filter(c => c[0] === 'db' && isExec(c[1]));

// ── V33: executeApprovedRevolut / executeApprovedKraken ──────────────────────────────────────
async function runApproved(src, fnName, t, placeThrows, insertThrows) {
  const calls = [];
  const g = {
    console: logger(calls), db: recDb(calls, (q) => (insertThrows && isExec(q) ? new Error('insert failed (mock)') : undefined)), setTimeout: fakeTimer(calls),
    placeRevolutOrder: rec(calls, 'placeRevolutOrder', () => placeThrows ? Promise.reject(new Error('venue said no')) : Promise.resolve({ data: { venue_order_id: 'V-1', state: 'filled' }, client_order_id: 'C-1' })),
    executeKrakenTrade: rec(calls, 'executeKrakenTrade', () => placeThrows ? Promise.reject(new Error('venue said no')) : Promise.resolve({ txid: ['K-1'] })),
    getCurrentPrice: rec(calls, 'getCurrentPrice', Promise.resolve(0.2)),
    findMatchingIntention: rec(calls, 'findMatchingIntention', Promise.resolve(null)),
    previousBalances: new Map([['CC-USD', 50]]), entryPrices: new Map([['CC-USD', 0.1]]),
    formatTradeQty: String, formatPrice: String,
  };
  const code = (src === SRC ? NEW_HELPERS + '\n' : '') + extractFunction(src, fnName);
  const api = looseSandbox(g, code, [fnName], calls);
  await api[fnName](t);
  return calls;
}
const revT = (o = {}) => ({ symbol: 'CC-USD', side: 'buy', orderType: 'market', baseSize: 100, price: 0.2, valueUsd: 20, source: 'claude_mcp', ...o });
const krkT = (o = {}) => ({ symbol: 'GHIBLI-USD', side: 'sell', orderType: 'market', volume: 1000, price: 0.01, valueUSD: 10, source: 'claude_mcp', ...o });

await test('V33', 'Manual: executeApprovedRevolut (mocked venue) -> one row mode manual, reason manual_approved; behaviour unchanged', async () => {
  assert.ok(BASE, 'base server.js (origin/main) available for the comparison');
  for (const t of [revT(), revT({ side: 'sell' }), revT({ orderType: 'limit', side: 'sell' }), revT({ baseSize: undefined, price: null })]) {
    const now = await runApproved(SRC, 'executeApprovedRevolut', t);
    const was = await runApproved(BASE, 'executeApprovedRevolut', t);
    const rows = execRows(now);
    assert.equal(rows.length, 1, 'one exec_decisions row for ' + JSON.stringify(t));
    assert.match(rows[0][1], /VALUES \('manual', \?, \?, 'manual', \?, \?, \?, \?, 1, \?, 'manual', \?, \?\)/);
    const p = plain(rows[0][2]);
    assert.equal(p[0], 'CC-USD'); assert.equal(p[1], t.side); assert.equal(p[2], 'revolut'); assert.equal(p[6], 'manual_approved'); assert.equal(p[7], 'V-1');
    assert.deepEqual(withoutExec(now), norm(was), 'every other side effect identical to main');
    assert.ok(!now.some(c => c[0] === 'console.error'), 'no error on the approval path: ' + JSON.stringify(now.filter(c => c[0] === 'console.error')));
    const iPlace = now.findIndex(c => c[0] === 'placeRevolutOrder'), iRow = now.findIndex(c => c[0] === 'db' && isExec(c[1]));
    assert.ok(iPlace >= 0 && iRow > iPlace, 'row written only after the order was placed');
  }
  const failed = await runApproved(SRC, 'executeApprovedRevolut', revT(), true);   // order refused -> nothing approved happened -> no row
  assert.equal(execRows(failed).length, 0);
  assert.deepEqual(norm(failed), norm(await runApproved(BASE, 'executeApprovedRevolut', revT(), true)));
});
await test('V33k', 'Manual: executeApprovedKraken (mocked venue) -> one row manual_approved; behaviour unchanged', async () => {
  for (const t of [krkT(), krkT({ side: 'buy' })]) {
    const now = await runApproved(SRC, 'executeApprovedKraken', t), was = await runApproved(BASE, 'executeApprovedKraken', t);
    const rows = execRows(now); assert.equal(rows.length, 1);
    const p = plain(rows[0][2]); assert.deepEqual(p.slice(0, 7), ['GHIBLI-USD', t.side, 'kraken', 0.01, 1000, 10, 'manual_approved']);
    assert.deepEqual(withoutExec(now), norm(was));
  }
  const failed = await runApproved(SRC, 'executeApprovedKraken', krkT(), true); assert.equal(execRows(failed).length, 0);
});
await test('V33x', 'a failing exec_decisions insert does not change the approval path', async () => {
  for (const [fn, t] of [['executeApprovedRevolut', revT()], ['executeApprovedKraken', krkT()]]) {
    const now = await runApproved(SRC, fn, t, false, true), was = await runApproved(BASE, fn, t);
    assert.equal(execRows(now).length, 1, 'the insert was attempted');
    const p0err = now.filter(c => c[0] === 'console.error' && /^\[P0\] manual decision row failed/.test(c[1][0]));
    assert.equal(p0err.length, 1, 'one console.error for the failed audit row');
    assert.deepEqual(withoutExec(now.filter(c => !p0err.includes(c))), norm(was), fn);
  }
});

// ── V44: autoLogTrade ─────────────────────────────────────────────────────────────────────────
async function runAutoLog(src, args, transferIntent) {
  const calls = [];
  const g = {
    console: logger(calls),
    db: recDb(calls, (q) => (/COUNT\(\*\) as total FROM trading_journal/.test(q) ? [[{ total: 7 }]] : (/^\s*INSERT INTO trading_journal/.test(q) ? [{ insertId: 555 }] : undefined))),
    pendingTradeContext: new Map(), alertContextBySymbol: new Map(), trailingStopAlerted: new Map(), setTimeout: fakeTimer(calls), previousBalances: new Map([['CC-USD', 150]]), entryPrices: new Map([['CC-USD', 0.1]]),
    findMatchingIntention: rec(calls, 'findMatchingIntention', (s, kind) => Promise.resolve(transferIntent && kind === 'transfer' ? { id: 9, reasoning: 'moved from Kraken' } : null)),
    disposeTaxLotsHIFO: rec(calls, 'disposeTaxLotsHIFO', Promise.resolve([])),
    revolutRequest: rec(calls, 'revolutRequest', Promise.resolve([{ currency: 'CC', available: '100' }])),
    KRAKEN_MONITORED_COINS: ['GHIBLI-USD'], formatTradeQty: String, formatPrice: String,
  };
  const code = (src === SRC ? NEW_HELPERS + '\n' : '') + extractFunction(src, 'autoLogTrade');
  const api = looseSandbox(g, code, ['autoLogTrade'], calls);
  await api.autoLogTrade(...args);
  return calls;
}
await test('V44', 'manual_detected: autoLogTrade journals an app-side sell -> one row mode manual, reason manual_detected', async () => {
  for (const args of [['CC-USD', 'sell', 0.2, -50, 100], ['CC-USD', 'buy', 0.2, 50, 150]]) {
    const now = await runAutoLog(SRC, args), was = await runAutoLog(BASE, args);
    const rows = execRows(now); assert.equal(rows.length, 1, 'one row for ' + args[1]);
    const p = plain(rows[0][2]);
    assert.deepEqual([p[0], p[1], p[2], p[3], p[4], p[6], p[8]], ['CC-USD', args[1], 'revolut', 0.2, 50, 'manual_detected', 555]);
    assert.match(rows[0][1], /VALUES \('manual'/);
    assert.deepEqual(withoutExec(now), norm(was), 'every other side effect identical to main');
    assert.ok(now.some(c => c[0] === 'sendTelegram') && now.some(c => c[0] === 'checkForRebalancePair'), 'ran to the end');
    assert.ok(!now.some(c => c[0] === 'console.error'), 'no error: ' + JSON.stringify(now.filter(c => c[0] === 'console.error')));
  }
  const tr = await runAutoLog(SRC, ['CC-USD', 'buy', 0.2, 50, 150], true);   // reclassified as a transfer -> not a trade -> no row
  assert.equal(execRows(tr).length, 0);
  assert.deepEqual(norm(tr), norm(await runAutoLog(BASE, ['CC-USD', 'buy', 0.2, 50, 150], true)));
});

// ── V35: set_pump_armed_rule ceiling_override write-time rule ────────────────────────────────
async function runTool(src, toolName, args, g0, answer, extraCode = '') {
  const calls = [], tools = {};
  const g = { console: quiet, db: recDb(calls, answer), z: zStub(), zLoose: () => zStub(), server: { tool: (n, d, s, h) => { tools[n] = h; } },
    sendTelegram: rec(calls, 'sendTelegram', Promise.resolve()), ...g0(calls) };
  const api = looseSandbox(g, extraCode + '\n' + extractTool(src, toolName) + '\nconst __tools = null', ['__tools'], calls);
  void api;
  const out = await tools[toolName](args);
  return { calls, out: JSON.parse(out.content[0].text) };
}
const ruleRow = { symbol: 'CC-USD', active: 1, loop_enabled: 0, armed: 0, arm_pump_pct: 30, arm_window_min: 60, trail_pct: 8, sell_pct: 100, entry_floor: null, ceiling_pct: null, ceiling_override: null };
const spGlobals = () => ({ trailingStops: new Map(), computeDerivedFloor: async () => ({ cost: 0.1, sell_floors: null }), derivedFloorFrom: () => ({ floor: 0.1005 }),
  getCurrentPrice: async () => 0.2, coinSellSlipP90: async () => ({ p90: 1, source: 'mock' }), stopClearanceCheck: () => ({ checked: false, reason: 'mock' }),
  emitEnableWarnings: async () => [] });
const spAnswer = (row) => (q) => (/SELECT armed FROM pump_armed_rules/.test(q) ? [[{ armed: 0 }]] : (/SELECT \* FROM pump_armed_rules WHERE symbol = \? LIMIT 1/.test(q) ? [[row]] : undefined));
const writes = (calls) => calls.filter(c => (c[0] === 'db' && /^(INSERT|UPDATE|DELETE)/i.test(c[1])) || c[0] === 'sendTelegram');
const goodOv = () => ({ value: 15, reason: 'PM #36: tight ceiling while this cycle is young', amount_usd: 60, expires_at: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) });

await test('V35', 'override write-time rule: ceiling_override missing expires_at -> refused, nothing written', async () => {
  const base = { symbol: 'CC-USD', arm_pump_pct: 30, trail_pct: 8 };
  const { expires_at, ...noExp } = goodOv(); void expires_at;
  const bad = [{ ceiling_override: noExp }, { ceiling_override: { ...goodOv(), value: 50 } }, { ceiling_override: { ...goodOv(), reason: 'short' } },
    { ceiling_override: { ...goodOv(), amount_usd: 0 } }, { ceiling_override: { ...goodOv(), expires_at: '2020-01-01' } },
    { ceiling_override: { ...goodOv(), expires_at: new Date(Date.now() + 120 * 86400000).toISOString() } }, { ceiling_pct: 250 }, { ceiling_pct: 4 }];
  for (const extra of bad) {
    const { calls, out } = await runTool(SRC, 'set_pump_armed_rule', { ...base, ...extra }, spGlobals, spAnswer(ruleRow), NEW_HELPERS);
    assert.equal(out.refused, true, JSON.stringify(extra)); assert.equal(out.ok, false);
    assert.deepEqual(writes(calls), [], 'nothing written for ' + JSON.stringify(extra));
  }
  const { out: o1 } = await runTool(SRC, 'set_pump_armed_rule', { ...base, ceiling_override: noExp }, spGlobals, spAnswer(ruleRow), NEW_HELPERS);
  assert.ok(o1.errors.some(e => /expires_at is required/.test(e)));
});
await test('V35+', 'a valid override / ceiling_pct is written; a call without them is unchanged from main', async () => {
  const base = { symbol: 'CC-USD', arm_pump_pct: 30, trail_pct: 8 };
  const { calls, out } = await runTool(SRC, 'set_pump_armed_rule', { ...base, ceiling_pct: 40, ceiling_override: goodOv() }, spGlobals,
    spAnswer({ ...ruleRow, ceiling_pct: 40, ceiling_override: JSON.stringify(goodOv()) }), NEW_HELPERS);
  assert.equal(out.ok, true);
  const up = calls.find(c => c[0] === 'db' && /SET ceiling_pct = COALESCE/.test(c[1]));
  assert.ok(up, 'ceiling UPDATE issued'); assert.equal(up[2][0], 40); assert.deepEqual(Object.keys(JSON.parse(up[2][1])), ['value', 'reason', 'amount_usd', 'expires_at']);
  assert.equal(out.rule.ceiling.pct, 15); assert.match(out.rule.ceiling.source, /^override until /);
  const now = await runTool(SRC, 'set_pump_armed_rule', base, spGlobals, spAnswer(ruleRow), NEW_HELPERS);
  const was = await runTool(BASE, 'set_pump_armed_rule', base, spGlobals, spAnswer(ruleRow));
  assert.deepEqual(plain(now.calls), plain(was.calls), 'same side effects as main when no ceiling param is given');
  const { ceiling, ...rest } = now.out.rule; assert.deepEqual(rest, was.out.rule); assert.deepEqual(plain(ceiling), { pct: 50, source: 'default' });
});

// ── V36: configure_auto_execute max_sell_pct warning ───────────────────────────────────────────
const aeExisting = { enabled: false, max_sell_pct: 100, allowed_triggers: ['trailing_stop'], require_confidence: 'High', cooldown_minutes: 60, hodl_symbols: [], manual_only_symbols: [], sell_floors: {}, per_coin_enabled: {} };
const caAnswer = (q) => {
  if (/config_key = 'ai_auto_execute'/.test(q) && /^\s*SELECT/.test(q)) return [[{ config_value: JSON.stringify(aeExisting) }]];
  if (/SELECT symbol FROM pump_armed_rules WHERE active = 1 AND loop_enabled = 1/.test(q)) return [[{ symbol: 'COTI-USD' }, { symbol: 'JTO-USD' }, { symbol: 'CC-USD' }]];
  if (/SELECT symbol, sell_pct FROM pump_armed_rules/.test(q)) return [[{ symbol: 'COTI-USD', sell_pct: '100.0000' }, { symbol: 'JTO-USD', sell_pct: '100.0000' }, { symbol: 'CC-USD', sell_pct: '20.0000' }]];
  return undefined;
};
await test('V36', 'max_sell_pct warning: configure_auto_execute max_sell_pct 25 with loops at sell_pct 100 -> reply lists them; config written', async () => {
  const { calls, out } = await runTool(SRC, 'manage_trading', { action: 'configure_auto_execute', max_sell_pct: 25 }, () => ({}), caAnswer);
  assert.equal(out.ok, true); assert.equal(out.config.max_sell_pct, 25);
  const w = out.warnings.find(x => /max_sell_pct 25%/.test(x));
  assert.ok(w, 'warning in the reply: ' + JSON.stringify(out.warnings));
  assert.match(w, /COTI \(sell_pct 100%\)/); assert.match(w, /JTO \(sell_pct 100%\)/); assert.doesNotMatch(w, /CC \(/);
  const saved = calls.find(c => c[0] === 'db' && /INSERT INTO system_config/.test(c[1]) && /ai_auto_execute/.test(c[1]));
  assert.ok(saved); assert.equal(JSON.parse(saved[2][0]).max_sell_pct, 25);
  assert.ok(calls.some(c => c[0] === 'sendTelegram' && /COTI \(sell_pct 100%\)/.test(c[1][0])), 'and a Telegram lists the loops');
  // without max_sell_pct: no new query, no new warning, side effects identical to main
  const now = await runTool(SRC, 'manage_trading', { action: 'configure_auto_execute', require_confidence: 'High' }, () => ({}), caAnswer);
  const was = await runTool(BASE, 'manage_trading', { action: 'configure_auto_execute', require_confidence: 'High' }, () => ({}), caAnswer);
  const strip = (c) => plain(c).map(x => (x[0] === 'db' && /INSERT INTO system_config/.test(x[1]) ? [x[0], x[1], [JSON.stringify({ ...JSON.parse(x[2][0]), updated_at: 'T' })]] : x));
  assert.deepEqual(strip(now.calls), strip(was.calls));
});

// ── predicate_check dry run + loop_audit ceiling (§4, §2) ─────────────────────────────────────
const P_FUNCS = ['mayAutoTrade', 'computeDerivedFloor', 'derivedFloorFrom', 'edgeSellCheck', 'coinSellSlipP90', 'isDndCoin', 'getDndMode', 'isAwayActionable', 'krakenAssetToStandard', 'stopClearanceCheck'];
const P_CODE = NEW_HELPERS + '\n' + ['FLOOR_BUFFER_PCT', 'STOP_CLEARANCE_MULT', 'LADDER_DEFAULTS', 'KRAKEN_TO_STANDARD'].map(c => extractConst(SRC, c)).join('\n') + '\n' + P_FUNCS.map(f => extractFunction(SRC, f)).join('\n');
const OV_DAY = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
const liveAnswer = (q) => {
  if (/config_key = 'ai_auto_execute'/.test(q)) return [[{ config_value: JSON.stringify({ enabled: true, allowed_triggers: ['trailing_stop'], manual_only_symbols: [], hodl_symbols: [] }) }]];
  if (/config_key = 'dnd_mode'/.test(q)) return [[{ config_value: '{"enabled":false,"coins":[]}' }]];
  if (/FROM pump_armed_rules WHERE symbol = \? AND active = 1/.test(q)) return [[{ symbol: 'CC-USD', active: 1, loop_enabled: 1, sale_price: null, entry_floor: null }]];
  if (/FROM pump_armed_rules WHERE active = 1 ORDER BY symbol/.test(q)) return [[{ ...ruleRow, loop_enabled: 1 }, { ...ruleRow, symbol: 'JTO-USD', ceiling_override: JSON.stringify({ value: 15, reason: 'x'.repeat(20), amount_usd: 5, expires_at: OV_DAY }) }]];
  if (/FROM entry_prices/.test(q)) return [[{ entry_price: 0.1346 }]];
  return undefined;
};
await test('PC1', 'predicate_check: calls mayAutoTrade(dry_run), writes one dry_run row, places nothing, mutates nothing', async () => {
  const g = (calls) => ({ getCurrentPrice: rec(calls, 'getCurrentPrice', Promise.resolve(0.109)), KRAKEN_MONITORED_COINS: ['GHIBLI-USD'], BOOK_SELL_SLIP_P90: 1.0,
    revolutRequest: rec(calls, 'revolutRequest', Promise.resolve([{ currency: 'CC', available: '100' }])) });
  const { calls, out } = await runTool(SRC, 'manage_auto_rules', { action: 'predicate_check', symbol: 'CC', pc_side: 'sell', pc_path: 'loop_trail' }, g, liveAnswer, P_CODE);
  assert.equal(out.read_only, true); assert.equal(out.intent.symbol, 'CC-USD'); assert.equal(out.intent.price, 0.109);
  assert.equal(out.result.reason, 'floor_blocked'); assert.equal(out.result.check_no, 6); assert.ok(Math.abs(out.result.floor - 0.1346 * 1.005) < 1e-12);   // the §6 CC shape
  assert.deepEqual(out.result.inputs.allowed_triggers, ['trailing_stop']);
  const rows = execRows(calls); assert.equal(rows.length, 1); assert.equal(rows[0][2][0], 'dry_run'); assert.equal(out.result.decision_id, 9001);
  for (const c of calls) {
    if (c[0] === 'db') assert.ok(/^SELECT/i.test(c[1]) || isExec(c[1]), 'only reads + its row: ' + c[1]);
    else assert.ok(['getCurrentPrice', 'revolutRequest'].includes(c[0]), 'unexpected side effect: ' + c[0]);
  }
  const { out: o2 } = await runTool(SRC, 'manage_auto_rules', { action: 'predicate_check', symbol: 'JTO', pc_side: 'buy', pc_path: 'trough' }, g,
    (q) => (/FROM pump_armed_rules WHERE symbol = \? AND active = 1/.test(q) ? [[{ symbol: 'JTO-USD', active: 1, loop_enabled: 1, sale_price: null }]] : liveAnswer(q)), P_CODE);
  assert.equal(o2.result.reason, 'no_cycle'); assert.equal(o2.result.check_no, 2);   // the §6 JTO shape
});
await test('LA1', 'loop_audit shows the ceiling per loop: 50% (default) / 15% (override until ...)', async () => {
  const g = (calls) => ({ getDndMode: async () => ({ enabled: false, coins: [] }), entryPrices: new Map([['CC-USD', 0.1]]), BOOK_SELL_SLIP_P90: 1.0,
    coinSellSlipP90: async () => ({ p90: 1, source: 'mock' }), revolutRequest: rec(calls, 'revolutRequest', Promise.resolve([])) });
  const { out } = await runTool(SRC, 'manage_auto_rules', { action: 'loop_audit' }, g, liveAnswer, P_CODE);
  const by = Object.fromEntries(out.loops.map(l => [l.coin, l.ceiling]));
  assert.equal(by.CC, '50% (default)'); assert.equal(by.JTO, '15% (override until ' + OV_DAY + ')');
});

// ── V34: inert ─────────────────────────────────────────────────────────────────────────────────
await test('V34', 'inert: mayAutoTrade( is called from no order path - its only call site is the read-only predicate_check', async () => {
  const lines = SRC.split('\n'), hits = [];
  lines.forEach((l, i) => { if (l.includes('mayAutoTrade(')) hits.push({ line: i + 1, text: l.trim() }); });
  console.log('       call sites of mayAutoTrade( in server.js:'); for (const h of hits) console.log('         L' + h.line + ': ' + h.text.slice(0, 110));
  assert.equal(hits.length, 2, 'the definition + predicate_check');
  assert.match(hits[0].text, /^async function mayAutoTrade\(intent, opts = \{\}\)/);
  assert.match(hits[1].text, /^const pc = await mayAutoTrade\(intent, \{ mode: 'dry_run' \}\);$/);
  // the predicate_check branch places nothing
  const start = SRC.indexOf("if (action === 'predicate_check') {"), end = SRC.indexOf("if (action === 'loop_audit') {", start);
  const branch = SRC.slice(start, end);
  assert.ok(start > 0 && end > start && branch.includes('mayAutoTrade('));
  assert.doesNotMatch(branch, /placeRevolutOrder|executeKrakenTrade|floorCappedLimitSell|autoExecute\w*Sell|INSERT|UPDATE|DELETE|sendTelegram/);
  // No function that exists on main calls it (every order path predates this branch)
  const { now, was } = fns();
  for (const [name, text] of now) if (was.has(name)) assert.ok(!text.includes('mayAutoTrade(') || name === 'createMcpServer', name + ' calls mayAutoTrade');
});
await test('V34b', 'inert: the only functions changed vs main are the three audit-row sites and the MCP tool builder; edits to existing lines are insertion-only', async () => {
  const { now, was } = fns();
  const changed = [], added = [], removed = [];
  for (const [k, v] of now) { if (!was.has(k)) added.push(k); else if (was.get(k) !== v) changed.push(k); }
  for (const k of was.keys()) if (!now.has(k)) removed.push(k);
  console.log('       changed: ' + changed.join(', ') + ' | added: ' + added.join(', ') + ' | removed: ' + (removed.join(', ') || 'none'));
  assert.deepEqual(changed.sort(), ['autoLogTrade', 'createMcpServer', 'executeApprovedKraken', 'executeApprovedRevolut']);
  assert.deepEqual(added.sort(), ['ceilingOverrideErrors', 'effectiveCeilingPct', 'mayAutoTrade', 'recordManualDecision']);
  assert.deepEqual(removed, []);
  // in the three changed legacy functions the ONLY new statement is one awaited recordManualDecision(...) call
  for (const k of ['autoLogTrade', 'executeApprovedKraken', 'executeApprovedRevolut']) {
    const a = was.get(k).split('\n'), b = now.get(k).split('\n');
    const extra = b.filter(l => !a.includes(l));
    assert.equal(extra.length, 1, k); assert.match(extra[0], /await recordManualDecision\(/);
    assert.equal(b.length, a.length + 1, k);
  }
  // every line of main that was modified at all was only EXTENDED (the old line is a subsequence of a new line)
  const aSet = new Set(SRC.split('\n')), bSet = new Set(BASE.split('\n')), gone = BASE.split('\n').filter(l => !aSet.has(l));
  const isSubseq = (small, big) => { let i = 0; for (const ch of big) if (ch === small[i]) i++; return i === small.length; };
  const newLines = SRC.split('\n').filter(l => !bSet.has(l));
  for (const l of gone) assert.ok(newLines.some(n => isSubseq(l, n)), 'line removed rather than extended: ' + l.slice(0, 120));
  console.log('       lines of main modified (all insertion-only): ' + gone.length);
});

if (report()) process.exit(1);
