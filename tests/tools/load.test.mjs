// T2 tools/data/load.mjs: pages -> build (the workflow's step) -> load. The loader refuses a file whose sha256 differs from the MANIFEST.
// Run: node tests/tools/load.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { runner } from '../lib.mjs';
import { buildOutput } from '../../tools/data/validate.mjs';
import { loadPrices, findPricesDir } from '../../tools/data/load.mjs';
import { series, dayRow, T0, H } from './fixtures.mjs';

const { test, report } = runner('T2 tools: loader (tests/tools/load.test.mjs)');
const hourly = [...series('ADA-USD', [0.5, 0.6, 0.7]), ...series('BTC-USD', [60000, null, 60200])];
const daily = [dayRow('BTC-USD', '2026-09-24', 60000), dayRow('BTC-USD', '2026-09-25', 61000), dayRow('ETH-USD', '2026-09-25', 2500)];
function write(dir) {
  const { files, manifest } = buildOutput({ hourly, daily }, { serverSha: 'abcdef12', runId: 42, exportedAt: '2026-09-26T04:18:00.000Z' });
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
const withDir = async (fn) => { const d = mkdtempSync(join(tmpdir(), 't2-load-')); try { await fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

await test('LD1', 'MANIFEST: rows, symbols, first/last time, sha256, server_sha, run id', async () => withDir((d) => {
  const m = write(d);
  assert.equal(m.server_sha, 'abcdef12'); assert.equal(m.workflow_run_id, '42'); assert.equal(m.exported_at, '2026-09-26T04:18:00.000Z');
  assert.deepEqual({ rows: m.tables.hourly.rows, symbols: m.tables.hourly.symbols, first: m.tables.hourly.first, last_t: m.tables.hourly.last_t },
    { rows: 5, symbols: 2, first: new Date(T0 * 1000).toISOString(), last_t: T0 + 2 * H });
  assert.deepEqual([m.tables.daily.rows, m.tables.daily.symbols, m.tables.daily.first, m.tables.daily.last], [3, 2, '2026-09-24', '2026-09-25']);
  assert.match(m.tables.hourly.sha256, /^[0-9a-f]{64}$/);
}));
await test('LD2', 'loads per-symbol arrays, oldest first (both tables)', async () => withDir((d) => {
  write(d);
  const p = loadPrices(d);
  assert.deepEqual([...p.hourly.keys()], ['ADA-USD', 'BTC-USD']);
  assert.deepEqual(p.hourly.get('BTC-USD').map(r => r.c), [60000, 60200]);
  assert.deepEqual(p.daily.get('BTC-USD').map(r => r.d), ['2026-09-24', '2026-09-25']);
  assert.equal(findPricesDir(d), d);
}));
await test('LD3', 'refuses a sha256 mismatch (file changed after the MANIFEST was written)', async () => withDir((d) => {
  write(d);
  const other = gzipSync(Buffer.from(JSON.stringify({ s: 'BTC-USD', t: T0, o: 1, h: 1, l: 1, c: 1, n: 1 }) + '\n'));
  writeFileSync(join(d, 'hourly.ndjson.gz'), other);
  assert.throws(() => loadPrices(d), /sha256 mismatch for hourly\.ndjson\.gz/);
  assert.throws(() => loadPrices(d, { tables: ['hourly'] }), /Refusing to load/);
  assert.equal(loadPrices(d, { tables: ['daily'] }).daily.size, 2, 'the untouched table still loads on its own');
}));
await test('LD4', 'refuses a MANIFEST whose sha256 was edited, and a row count that disagrees', async () => withDir((d) => {
  const m = write(d);
  const bad = JSON.parse(readFileSync(join(d, 'MANIFEST.json'), 'utf8'));
  bad.tables.daily.sha256 = '0'.repeat(64);
  writeFileSync(join(d, 'MANIFEST.json'), JSON.stringify(bad));
  assert.throws(() => loadPrices(d), /sha256 mismatch for daily/);
  bad.tables.daily.sha256 = m.tables.daily.sha256; bad.tables.daily.rows = 4;
  writeFileSync(join(d, 'MANIFEST.json'), JSON.stringify(bad));
  assert.throws(() => loadPrices(d), /MANIFEST says 4 rows, the file has 3/);
}));

report();
