// T2 tools/data/validate.mjs: the page validator (the same module the export workflow runs) and the shrink guard.
// Run: node tests/tools/validate.test.mjs
import assert from 'node:assert/strict';
import { runner } from '../lib.mjs';
import { validatePage, checkTableOrder, shrinkProblems, readPages } from '../../tools/data/validate.mjs';
import { page, hourRow, dayRow, T0, H } from './fixtures.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { test, report } = runner('T2 tools: page validator + shrink guard (tests/tools/validate.test.mjs)');
const HR = [hourRow('BTC-USD', T0, 60000), hourRow('BTC-USD', T0 + H, 60100), hourRow('WIF-USD', T0, 1.23, { h: 1.3, l: 1.2, c: 1.25 })];
const DR = [dayRow('BTC-USD', '2026-09-24', 60000), dayRow('BTC-USD', '2026-09-25', 61000)];
const throws = (fn, re) => assert.throws(fn, re);

await test('PV1', 'a good page passes (hourly and daily; with and without a next cursor)', async () => {
  const a = validatePage(page('hourly', HR, { next: 'c1' }), 'hourly');
  assert.equal(a.rows.length, 3); assert.equal(a.end.next, 'c1');
  const b = validatePage(page('daily', DR), 'daily');
  assert.equal(b.rows.length, 2); assert.equal(b.end.next, null);
  assert.equal(validatePage(page('hourly', []), 'hourly').rows.length, 0, 'an empty last page is fine');
});
await test('PV2', 'a missing end line fails (truncated page)', async () => {
  throws(() => validatePage(page('hourly', HR, { noEnd: true }), 'hourly'), /no end line/);
  const cut = page('hourly', HR).split('\n').slice(0, 2).join('\n');   // cut mid-page
  throws(() => validatePage(cut, 'hourly'), /no end line/);
  throws(() => validatePage('', 'hourly'), /empty/);
});
await test('PV3', 'bad JSON fails (and names the line)', async () => {
  const p = page('hourly', HR).split('\n'); p[1] = p[1].slice(0, -5);
  throws(() => validatePage(p.join('\n'), 'hourly'), /line 2: not JSON/);
  const blank = page('hourly', HR).replace('\n', '\n\n');   // a blank line in the middle is not JSON either
  throws(() => validatePage(blank, 'hourly'), /not JSON/);
});
await test('PV4', 'a rows-count mismatch fails', async () => {
  throws(() => validatePage(page('hourly', HR, { endOverride: { rows: 4 } }), 'hourly'), /says 4 rows, the page has 3/);
  throws(() => validatePage(page('hourly', HR, { endOverride: { rows: 2 } }), 'hourly'), /says 2 rows/);
});
await test('PV5', 'a wrong field type fails (each field)', async () => {
  const bad = [
    ['hourly', { ...HR[0], t: String(HR[0].t) }, /t must be/], ['hourly', { ...HR[0], t: T0 + 60 }, /whole-hour/],
    ['hourly', { ...HR[0], c: '1.25' }, /c must be a finite number/], ['hourly', { ...HR[0], o: null }, /o must be/],
    ['hourly', { ...HR[0], n: 1.5 }, /n must be/], ['hourly', { ...HR[0], s: 7 }, /s must be/],
    ['daily', { ...DR[0], d: '2026-9-25' }, /d must be/], ['daily', { ...DR[0], h: 'x' }, /h must be/], ['daily', { ...DR[0], src: 1 }, /src must be/],
  ];
  for (const [t, row, re] of bad) throws(() => validatePage(page(t, [row]), t), re);
  throws(() => validatePage(page('hourly', HR, { endOverride: { server_sha: 'XYZ' } }), 'hourly'), /server_sha/);
  throws(() => validatePage(page('hourly', HR, { endOverride: { next: 5 } }), 'hourly'), /next/);
  throws(() => validatePage(page('hourly', HR, { endOverride: { table: 'daily' } }), 'hourly'), /for table "daily"/);
  throws(() => validatePage(page('hourly', HR, { endOverride: { end: 'yes' } }), 'hourly'), /no end line/);
  throws(() => validatePage(page('daily', DR), 'hourly'), /for table "daily"/, 'a daily page is not an hourly page');
});
await test('PV6', 'whole-table order: a symbol repeated across pages or time going backwards fails', async () => {
  checkTableOrder('hourly', HR);
  throws(() => checkTableOrder('hourly', [...HR, HR[0]]), /appears again/);
  throws(() => checkTableOrder('hourly', [HR[1], HR[0]]), /not strictly increasing/);
  throws(() => checkTableOrder('daily', [DR[0], DR[0]]), /not strictly increasing/);
});
await test('PV7', 'readPages: pages chain (next on all but the last), a missing last page fails', async () => {
  const d = mkdtempSync(join(tmpdir(), 't2-pages-'));
  try {
    writeFileSync(join(d, 'hourly-0001.ndjson'), page('hourly', HR.slice(0, 2), { next: 'c1' }));
    writeFileSync(join(d, 'hourly-0002.ndjson'), page('hourly', HR.slice(2)));
    writeFileSync(join(d, 'daily-0001.ndjson'), page('daily', DR));
    const r = readPages(d);
    assert.equal(r.tables.hourly.length, 3); assert.equal(r.tables.daily.length, 2); assert.equal(r.serverSha, 'abcdef12');
    writeFileSync(join(d, 'hourly-0002.ndjson'), page('hourly', HR.slice(2), { next: 'c2' }));
    throws(() => readPages(d), /has a next cursor/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
await test('PV8', 'mixed server_sha (a redeploy mid-export) fails the build, within a table or across the two tables', async () => {
  const d = mkdtempSync(join(tmpdir(), 't2-pages-'));
  try {
    writeFileSync(join(d, 'hourly-0001.ndjson'), page('hourly', HR.slice(0, 2), { next: 'c1' }));
    writeFileSync(join(d, 'hourly-0002.ndjson'), page('hourly', HR.slice(2), { sha: '99999999' }));
    writeFileSync(join(d, 'daily-0001.ndjson'), page('daily', DR));
    throws(() => readPages(d), /more than one server version \(server_sha abcdef12, 99999999\)[\s\S]*re-run the workflow/);
    writeFileSync(join(d, 'hourly-0002.ndjson'), page('hourly', HR.slice(2)));
    assert.equal(readPages(d).serverSha, 'abcdef12', 'control: one sha passes');
    writeFileSync(join(d, 'daily-0001.ndjson'), page('daily', DR, { sha: '99999999' }));
    throws(() => readPages(d), /more than one server version/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

const prev = { tables: { hourly: { rows: 100000 }, daily: { rows: 20000 } } };
await test('SG1', 'shrink guard: 9% fewer rows passes (either table), 10% exactly passes', async () => {
  assert.deepEqual(shrinkProblems(prev, { hourly: 91000, daily: 20000 }), []);
  assert.deepEqual(shrinkProblems(prev, { hourly: 100000, daily: 18200 }), []);
  assert.deepEqual(shrinkProblems(prev, { hourly: 90000, daily: 18000 }), [], 'exactly 10% is not MORE than 10%');
  assert.deepEqual(shrinkProblems(prev, { hourly: 150000, daily: 25000 }), [], 'growth is fine');
  assert.deepEqual(shrinkProblems(null, { hourly: 1, daily: 1 }), [], 'first export: nothing to compare with');
});
await test('SG2', 'shrink guard: 11% fewer rows fails (either table)', async () => {
  assert.equal(shrinkProblems(prev, { hourly: 89000, daily: 20000 }).length, 1);
  assert.match(shrinkProblems(prev, { hourly: 89000, daily: 20000 })[0], /^hourly: 89000 rows vs 100000/);
  assert.match(shrinkProblems(prev, { hourly: 100000, daily: 17800 })[0], /^daily:/);
  assert.equal(shrinkProblems(prev, { hourly: 89999, daily: 0 }).length, 2);
});

report();
