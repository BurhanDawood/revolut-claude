// #P0 runs every Phase 0 check: node --check server.js, then each test file. Exit code 0 only if all pass.
// Run: node tests/p0/run-all.mjs
import { spawnSync } from 'node:child_process';
import { ROOT, SERVER } from './harness.mjs';

const steps = [
  ['node --check server.js', [process.execPath, ['--check', SERVER]]],
  ['tests/p0/predicate.test.mjs', [process.execPath, ['tests/p0/predicate.test.mjs']]],
  ['tests/p0/callers.test.mjs', [process.execPath, ['tests/p0/callers.test.mjs']]],
];
let failed = 0;
for (const [name, [cmd, args]] of steps) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  console.log('>> ' + name + ': ' + (r.status === 0 ? 'OK' : 'FAILED (exit ' + r.status + ')'));
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
