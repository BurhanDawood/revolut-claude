// T2 tools/replay/spike-replay.mjs: the offline driver runs the LIVE spikeReplay (extracted from server.js by name) on exported
// hourly data. Parity: its output deep-equals what the extracted spikeReplayCoin gives, per coin and aggregated. A 2.2x pump
// triggers; a crash-and-recover does not. A query the stub does not answer fails loudly, naming it.
// Run: node tests/tools/replay.test.mjs
import assert from 'node:assert/strict';
import { runner, readServer, extractFunction, extractConst, strictSandbox, plain } from '../lib.mjs';
import { runSpikeReplay, makeStubDb, extractSpikeCode } from '../../tools/replay/spike-replay.mjs';
import { series, pump, crashRecover, walk, flat, toMap } from './fixtures.mjs';

const { test, report } = runner('T2 tools: offline spike replay (tests/tools/replay.test.mjs)');
const SRC = readServer();
// the oracle: spikeReplayCoin + spikeMedian straight from server.js, in their own sandbox (no db at all)
const O = strictSandbox({}, [extractConst(SRC, 'SPIKE_DEFAULTS'), extractFunction(SRC, 'spikeMedian'), extractFunction(SRC, 'spikeReplayCoin')].join('\n'),
  ['spikeReplayCoin', 'spikeMedian', 'SPIKE_DEFAULTS']);
const coinRows = (rows) => rows.map(r => ({ t: r.t, h: r.h, l: r.l, c: r.c }));

// synthetic dataset: a pump, a crash-and-recover, three random walks (missing hours, wicks), and a coin under 500 hours (left out)
const DATA = toMap([
  ...series('AAA-USD', walk(1400, 7), { wick: (i, c) => (i % 97 === 5 ? c * 0.3 : null) }),
  ...series('CRASH-USD', crashRecover(700)),
  ...series('PUMP-USD', pump(900)),
  ...series('SHORT-USD', pump(499)),
  ...series('ZED-USD', walk(2000, 11)),
  ...series('bbb-USD', walk(800, 3)),
]);

// what spikeReplay should say, assembled from per-coin spikeReplayCoin results (the aggregation steps mirror the server's output shape)
function expected(data) {
  const syms = [...data.keys()].filter(s => data.get(s).length >= 500).sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()));
  const all = [], perCoin = []; let naive = 0, naiveOnly = 0, hours = 0;
  for (const s of syms) {
    const res = plain(O.spikeReplayCoin(coinRows(data.get(s)), O.SPIKE_DEFAULTS));
    hours += data.get(s).length; naive += res.naive_n; naiveOnly += res.naive_only_n;
    const coin = s.replace(/-USD$/, '');
    for (const e of res.a1) all.push({ coin, at: new Date(e.t * 1000).toISOString().slice(0, 16), ...e });
    if (res.naive_n || res.a1.length) perCoin.push({ coin, naive: res.naive_n, a1: res.a1.length });
  }
  const avg = (k) => { const v = all.map(e => e[k]).filter(x => x != null); return v.length ? { n: v.length, avg_pct: Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)), median_pct: Number(O.spikeMedian(v).toFixed(1)) } : { n: 0 }; };
  return { coins: syms.length, hours, naive_triggers: naive, a1_triggers: all.length, naive_only: naiveOnly,
    peak_21d: avg('peak_21d_pct'), hold_7d: avg('hold_7d_pct'), hold_21d: avg('hold_21d_pct'), trail_exit: avg('trail_exit_pct'),
    trail_half_plus_hold_21d: avg('trail_half_plus_hold_21d_pct'), half_at_trigger_21d: avg('half_at_trigger_21d_pct'),
    per_coin: perCoin.slice(0, 60), events: all.slice(-60), all };
}

const { out, writes } = await runSpikeReplay(DATA);
const exp = expected(DATA);

await test('RP1', 'parity, aggregated: coins, hours, naive / A1 / naive-only counts and every outcome equal the extracted spikeReplayCoin', async () => {
  assert.equal(out.coins, 5, 'SHORT-USD (499 hours) is left out, as HAVING n >= 500 does on the server');
  for (const k of ['coins', 'hours', 'naive_triggers', 'a1_triggers', 'naive_only']) assert.equal(out[k], exp[k], k);
  for (const k of ['peak_21d', 'hold_7d', 'hold_21d', 'trail_exit', 'trail_half_plus_hold_21d', 'half_at_trigger_21d']) assert.deepEqual(out.outcomes[k], exp[k], k);
  assert.ok(exp.a1_triggers >= 3 && exp.naive_triggers > exp.a1_triggers, 'the fixture exercises both rules (' + exp.a1_triggers + ' A1, ' + exp.naive_triggers + ' naive)');
  assert.equal(out.version, Number(extractConst(SRC, 'SPIKE_REPLAY_VERSION').match(/= (\d+)/)[1])); assert.equal(out.rule.trail_pct, 15);
});
await test('RP2', 'parity, per coin: per_coin and every event deep-equal spikeReplayCoin run on that coin alone', async () => {
  assert.deepEqual(out.per_coin, exp.per_coin);
  assert.deepEqual(out.events, exp.events);
  for (const s of ['AAA-USD', 'PUMP-USD', 'ZED-USD']) {
    const coin = s.replace(/-USD$/, ''), one = plain(O.spikeReplayCoin(coinRows(DATA.get(s)), O.SPIKE_DEFAULTS));
    assert.deepEqual(exp.all.filter(e => e.coin === coin).map(({ coin: _c, at: _a, ...e }) => e), one.a1, s);
  }
});
await test('RP3', 'a 2.2x pump after 7 flat days at 1.0 is a triggered A1 event; a crash-and-recover is not', async () => {
  const pc = Object.fromEntries(out.per_coin.map(p => [p.coin, p]));
  assert.equal(pc.PUMP.a1, 1);
  const ev = out.events.find(e => e.coin === 'PUMP');
  assert.equal(ev.px, 2.2); assert.equal(ev.low24, 1); assert.equal(ev.med7, 1);
  assert.equal(ev.hold_21d_pct, 0, 'held flat at 2.2 after the trigger');
  assert.ok(pc.CRASH && pc.CRASH.naive >= 1, 'the naive rule does fire on the recovery');
  assert.equal(pc.CRASH.a1, 0, 'the A1 rule does not');
  assert.equal(out.events.filter(e => e.coin === 'CRASH').length, 0);
  const alone = await runSpikeReplay(toMap(series('CRASH-USD', crashRecover(700))));
  assert.equal(alone.out.a1_triggers, 0);
  const pumpOnly = await runSpikeReplay(toMap(series('PUMP-USD', pump(600))));
  assert.equal(pumpOnly.out.a1_triggers, 1);
});
await test('RP4', 'the stub answers spike_exit with the defaults (or a --cfg override) and swallows the writes', async () => {
  assert.ok(writes.some(w => /^INSERT INTO system_config/.test(w)), 'the spike_replay write reached the stub and was swallowed');
  const hi = await runSpikeReplay(DATA, { spikeExit: { trigger_pct: 1000 } });   // 11x: nothing triggers
  assert.equal(hi.out.a1_triggers, 0);
  assert.equal(hi.out.naive_triggers, out.naive_triggers, 'the naive rule does not read the config trigger');
});
await test('RP5', 'a query the stub does not answer fails loudly and names the query', async () => {
  const { db, unknown } = makeStubDb(new Map());
  await assert.rejects(db.execute('SELECT * FROM holdings'), /stub db does not answer this query.*SELECT \* FROM holdings/);
  assert.deepEqual(unknown, ['SELECT * FROM holdings']);
  // the live code gains a query it swallows (as spikeReplay's own .catch would): the driver still fails, naming it
  const src = SRC.replace(/^async function spikeReplay\(force = false\) \{/m, "$&\n  await db.execute('SELECT balance FROM wallets').catch(() => {});");
  assert.notEqual(src, SRC, 'the test could patch its local copy');
  await assert.rejects(runSpikeReplay(DATA, { src }), /does not answer[\s\S]*SELECT balance FROM wallets/);
  // ... or a helper the sandbox does not have: a ReferenceError naming it
  const src2 = SRC.replace(/^async function spikeReplay\(force = false\) \{/m, '$&\n  await someNewHelper();');
  await assert.rejects(runSpikeReplay(DATA, { src: src2 }), /someNewHelper is not defined/);
});
await test('RP6', 'extracted by name from server.js: the driver runs the live spikeReplay text, not a copy', async () => {
  const code = extractSpikeCode(SRC);
  for (const f of ['spikeReplay', 'spikeReplayCoin', 'spikeCfg', 'spikeMedian', 'spikeRef']) assert.ok(code.includes(extractFunction(SRC, f)), f);
  assert.ok(code.includes(extractConst(SRC, 'SPIKE_REPLAY_VERSION')));
});

report();
