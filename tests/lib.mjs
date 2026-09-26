// T1 shared test helpers. Re-uses the P0 harness (functions are extracted from server.js BY NAME and run in vm sandboxes
// with stubbed I/O); adds a runner that knows SKIP (a test parked on a tests/FINDINGS.md entry) and a few stub builders.
// Nothing here imports or starts server.js, and nothing reaches a real exchange, database, Telegram or model API.
export { ROOT, SERVER, readServer, extractFunction, extractConst, strictSandbox, looseSandbox, plain } from './p0/harness.mjs';

// runner(title) -> { test, skip, report }. report() prints one PASS / FAIL / SKIP line per test and sets exit code 1 on a FAIL.
export function runner(title) {
  const results = [];
  const test = async (id, name, fn) => {
    try { await fn(); results.push({ id, name, st: 'PASS' }); }
    catch (e) { results.push({ id, name, st: 'FAIL', err: e && (e.stack || e.message) }); }
  };
  // skip(id, name, finding, fn): the test is kept in the file (so it can be re-enabled) but not run; `finding` names the FINDINGS.md entry
  const skip = async (id, name, finding) => { results.push({ id, name, st: 'SKIP', err: 'see tests/FINDINGS.md ' + finding }); };
  const report = () => {
    console.log('\n== ' + title + ' ==');
    for (const r of results) {
      console.log(r.id.padEnd(6) + ' ' + r.st + '  ' + r.name);
      if (r.st !== 'PASS') console.log('       ' + String(r.err).split('\n').slice(0, 8).join('\n       '));
    }
    const n = (s) => results.filter(r => r.st === s).length;
    console.log('-- ' + n('PASS') + '/' + results.length + ' passed' + (n('SKIP') ? ', ' + n('SKIP') + ' skipped' : '') + (n('FAIL') ? ', ' + n('FAIL') + ' FAILED' : ''));
    if (n('FAIL')) process.exitCode = 1;
  };
  return { test, skip, report };
}

// A recording db: calls[] gets ['db', sql, params]; answer(sql, params) returns rows ([rows]) / an Error / undefined (default).
export function recDb(calls, answer) {
  let id = 100;
  return { execute(q, p = []) {
    const sql = q.replace(/\s+/g, ' ').trim();
    calls.push(['db', sql, p]);
    const a = answer ? answer(sql, p) : undefined;
    if (a instanceof Error) return Promise.reject(a);
    if (a !== undefined) return Promise.resolve(a);
    if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) return Promise.resolve([{ insertId: ++id, affectedRows: 1 }]);
    return Promise.resolve([[]]);
  } };
}
export const quiet = { log() {}, warn() {}, error() {} };
// timers fire at once (a sleep resolves immediately; nothing is left scheduled that would keep the process alive)
export const instantTimeout = (fn) => { fn(); return 0; };
// deterministic PRNG for the property tests (same sequence on every run)
export function rng(seed = 42) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
