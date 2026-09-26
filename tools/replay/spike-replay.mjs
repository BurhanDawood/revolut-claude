// T2: the #B23 spike replay (Fable's Q3), offline, on the exported hourly price history.
// It runs the LIVE code: spikeReplay and everything it calls are extracted from server.js BY NAME (tests/lib.mjs) and run in a
// strict vm sandbox. Nothing is rewritten. The sandbox gets a stub db that answers spikeReplay's SELECTs from the exported
// hourly data, returns the defaults for system_config spike_exit / spike_replay, and swallows every write; specNote is a no-op.
// Anything the extracted code asks for that the stub does not answer (a new query, a new helper) fails loudly and is named.
//
// Run:  node tools/replay/spike-replay.mjs [--dir <data/prices>] [--json] [--cfg '{"trail_pct":20}']
//   --dir   where MANIFEST.json and hourly.ndjson.gz are (default: $PRICES_DIR, ../data-prices/data/prices, ./data/prices)
//   --json  print the full object spikeReplay returns (the same object the server stores in system_config spike_replay)
//   --cfg   a spike_exit override, as the server would read it from system_config (default: none, i.e. SPIKE_DEFAULTS)
import { fileURLToPath } from 'node:url';
import { readServer, extractFunction, extractConst, strictSandbox } from '../../tests/lib.mjs';
import { loadPrices, findPricesDir } from '../data/load.mjs';

export const CONSTS = ['SPIKE_DEFAULTS', 'SPIKE_REPLAY_VERSION'];
export const FUNCS = ['spikeCfg', 'spikeMedian', 'spikeRef', 'spikeReplayCoin', 'spikeReplay'];

// The live code, extracted by name. src: server.js text (default: this checkout's).
export function extractSpikeCode(src = readServer()) {
  return [...CONSTS.map(c => extractConst(src, c)), ...FUNCS.map(f => extractFunction(src, f))].join('\n');
}

const norm = (q) => String(q).replace(/\s+/g, ' ').trim();
const Q_CONFIG = /^SELECT config_value FROM system_config WHERE config_key = '(\w+)'$/;
const Q_SYMBOLS = /^SELECT symbol, COUNT\(\*\) AS n FROM price_intraday_hourly GROUP BY symbol HAVING n >= (\d+) ORDER BY symbol$/;
const Q_HOURS = 'SELECT UNIX_TIMESTAMP(hour_bucket) AS t, high_px AS h, low_px AS l, close_px AS c FROM price_intraday_hourly WHERE symbol = ? ORDER BY hour_bucket';
const Q_SPEC = /^SELECT id FROM spec_threads WHERE title LIKE 'B23%' ORDER BY id LIMIT 1$/;
const WRITE = /^(INSERT|UPDATE|DELETE|REPLACE)\b/i;

// hourly: Map symbol -> [{t, h, l, c, ...}] oldest first. spikeExit: the spike_exit config object (null = not set, the default).
// Returns { db, unknown, writes }: unknown[] collects every query the stub could not answer (it also throws for it).
export function makeStubDb(hourly, { spikeExit = null } = {}) {
  const unknown = [], writes = [];
  // MySQL's ORDER BY symbol (case-insensitive collation): upper-case first, raw as the tie-break
  const ordered = [...hourly.keys()].sort((a, b) => { const A = a.toUpperCase(), B = b.toUpperCase(); return A < B ? -1 : A > B ? 1 : a < b ? -1 : a > b ? 1 : 0; });
  const answer = (sql, p) => {
    let m;
    if ((m = Q_CONFIG.exec(sql))) {
      if (m[1] === 'spike_replay') return [[]];   // no stored replay: always run
      if (m[1] === 'spike_exit') return [spikeExit ? [{ config_value: JSON.stringify(spikeExit) }] : []];
    }
    if ((m = Q_SYMBOLS.exec(sql))) return [ordered.filter(s => hourly.get(s).length >= Number(m[1])).map(s => ({ symbol: s, n: hourly.get(s).length }))];
    if (sql === Q_HOURS) {
      if (p.length !== 1 || !hourly.has(p[0])) throw new Error('stub db: no hourly data for ' + JSON.stringify(p));
      return [hourly.get(p[0]).map(r => ({ t: r.t, h: r.h, l: r.l, c: r.c }))];
    }
    if (Q_SPEC.test(sql)) return [[{ id: 0 }]];   // lets the specNote step run (specNote is a no-op)
    if (WRITE.test(sql)) { writes.push(sql.slice(0, 80)); return [{ affectedRows: 1, insertId: 0 }]; }
    return undefined;
  };
  const db = {
    execute(q, p = []) {
      const sql = norm(q);
      let a;
      try { a = answer(sql, p); } catch (e) { unknown.push(sql + ' ' + JSON.stringify(p) + ': ' + e.message); return Promise.reject(e); }
      if (a === undefined) {
        unknown.push(sql);
        return Promise.reject(new Error('stub db does not answer this query (tools/replay/spike-replay.mjs makeStubDb): ' + sql));
      }
      return Promise.resolve(a);
    },
  };
  return { db, unknown, writes };
}

// Runs the extracted spikeReplay on `hourly` (Map symbol -> rows oldest first). Throws, naming the cause, if the live code needed
// anything the stubs do not provide (a missing global is a ReferenceError in the strict sandbox; an unanswered query is recorded
// even where spikeReplay itself swallows the error; any console.error from it counts too).
export async function runSpikeReplay(hourly, { src, spikeExit = null, log = () => {} } = {}) {
  const { db, unknown, writes } = makeStubDb(hourly, { spikeExit });
  const errors = [];
  const g = {
    db,
    specNote: async () => {},
    setImmediate,
    console: { log, warn: log, error: (...a) => errors.push(a.map(String).join(' ')) },
  };
  const api = strictSandbox(g, extractSpikeCode(src), ['spikeReplay', 'spikeReplayCoin', 'spikeMedian', 'SPIKE_DEFAULTS', 'SPIKE_REPLAY_VERSION']);
  const out = await api.spikeReplay(true);
  if (unknown.length) throw new Error('the live spikeReplay asked for something the stub db does not answer:\n  ' + unknown.join('\n  '));
  if (errors.length) throw new Error('the live spikeReplay reported an error:\n  ' + errors.join('\n  '));
  return { out: JSON.parse(JSON.stringify(out)), writes, api };
}

export function summary(out) {
  const f = (o) => (o && o.n ? 'n ' + o.n + ', avg ' + o.avg_pct + '%, median ' + o.median_pct + '%' : 'n 0');
  return [
    'spike replay v' + out.version + ' (live server.js code, offline data)',
    'coins ' + out.coins + ', hours ' + out.hours,
    'rule: ' + out.rule.trigger + '; trail ' + out.rule.trail_pct + '%',
    'naive triggers ' + out.naive_triggers + ', A1 triggers ' + out.a1_triggers + ', naive with no A1 within 24 h ' + out.naive_only,
    'outcomes after an A1 trigger:',
    ...Object.entries(out.outcomes).map(([k, v]) => '  ' + k.padEnd(26) + f(v) + (v.note ? '  ' + v.note : '')),
  ].join('\n');
}

async function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const dir = findPricesDir(opt('--dir'));
  const spikeExit = opt('--cfg') ? JSON.parse(opt('--cfg')) : null;
  const { hourly, manifest } = loadPrices(dir, { tables: ['hourly'] });
  console.error('data: ' + dir + ' (exported ' + manifest.exported_at + ', server ' + manifest.server_sha + ', ' + manifest.tables.hourly.rows + ' hourly rows, ' + hourly.size + ' symbols)');
  const { out, writes } = await runSpikeReplay(hourly, { spikeExit, log: (...a) => console.error(...a) });
  console.error('writes swallowed: ' + writes.length);
  console.log(argv.includes('--json') ? JSON.stringify(out, null, 2) : summary(out));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(e => { console.error('spike-replay FAILED: ' + e.message); process.exit(1); });
}
