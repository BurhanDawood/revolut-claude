// T1 runs the whole suite: node --check server.js, the acorn parse, then every test file in tests/p0, tests/money and tests/static.
// Each file prints PASS / FAIL / SKIP per test; this prints one line per step and a total. Exit 1 if anything failed.
// Nothing here starts server.js or reaches an exchange, a database, Telegram or a model API.
// Run: node tests/run-all.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SERVER } from './lib.mjs';

// tests/p0/callers.test.mjs is SKIPPED: it is the one-off P0 branch-vs-main diff proof and cannot pass on main (tests/FINDINGS.md F1).
const SKIPPED = { 'tests/p0/callers.test.mjs': 'F1 (a one-off P0 branch-vs-main proof, stale on main)' };
const files = (dir) => readdirSync(join(ROOT, dir)).filter(f => f.endsWith('.test.mjs')).sort().map(f => dir + '/' + f);
const steps = [
  ['node --check server.js', ['--check', SERVER]],
  ['acorn parse server.js', ['tests/static/parse.mjs'], { skipCode: 3 }],
  ...['tests/p0', 'tests/money', 'tests/static'].flatMap(files).map(f => [f, [f]]),
];
const out = [];
for (const [name, args, o = {}] of steps) {
  if (SKIPPED[name]) { out.push([name, 'SKIP', 'see tests/FINDINGS.md ' + SKIPPED[name]]); continue; }
  const t = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  const st = r.status === 0 ? 'PASS' : (o.skipCode != null && r.status === o.skipCode ? 'SKIP' : 'FAIL');
  out.push([name, st, st === 'FAIL' ? 'exit ' + r.status : ((Date.now() - t) / 1000).toFixed(1) + ' s']);
}
console.log('\n== T1 suite ==');
for (const [n, st, why] of out) console.log(st.padEnd(5) + ' ' + n + (why ? '  (' + why + ')' : ''));
const failed = out.filter(x => x[1] === 'FAIL').length;
console.log('-- ' + out.filter(x => x[1] === 'PASS').length + '/' + out.length + ' steps passed' + (out.some(x => x[1] === 'SKIP') ? ', ' + out.filter(x => x[1] === 'SKIP').length + ' skipped' : '') + (failed ? ', ' + failed + ' FAILED' : ''));
process.exit(failed ? 1 : 0);
