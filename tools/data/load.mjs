// T2: loads the exported price history (data/prices on the data-prices branch) into per-symbol arrays, oldest first.
// Every file's sha256 is checked against data/prices/MANIFEST.json first; a mismatch (or a row count that disagrees) is refused.
// Plain Node, no dependencies, no network.
//
//   import { loadPrices, findPricesDir } from './tools/data/load.mjs';
//   const { manifest, hourly, daily } = loadPrices(findPricesDir());
//   hourly.get('WIF-USD') -> [{ t, o, h, l, c, n }, ...]   (t = hour start, unix seconds UTC)
//   daily.get('BTC-USD')  -> [{ d, o, h, l, c, src }, ...] (d = London date)
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, TABLES } from './validate.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Where the data is: an explicit dir, else $PRICES_DIR, else the worktree tools/README.md sets up (../data-prices next to the
// repo), else data/prices inside this checkout (when data-prices itself is checked out).
export function findPricesDir(dir = null) {
  const tries = [dir, process.env.PRICES_DIR, join(REPO, '..', 'data-prices', 'data', 'prices'), join(REPO, 'data', 'prices')].filter(Boolean);
  for (const d of tries) if (existsSync(join(d, 'MANIFEST.json'))) return resolve(d);
  throw new Error('no price data found (looked for MANIFEST.json in: ' + tries.join(', ') + '). See tools/README.md step 1.');
}

export function readManifest(dir) {
  const m = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8'));
  if (!m || !m.tables) throw new Error('MANIFEST.json has no tables');
  return m;
}

// One table's rows as they are in the file (server order), after the sha256 and row-count checks.
export function readTable(dir, table, manifest = readManifest(dir)) {
  const meta = manifest.tables[table];
  if (!TABLES[table] || !meta) throw new Error('MANIFEST.json has no ' + table + ' table');
  const buf = readFileSync(join(dir, meta.file || table + '.ndjson.gz'));
  const got = sha256(buf);
  if (got !== meta.sha256) throw new Error('sha256 mismatch for ' + (meta.file || table) + ': MANIFEST says ' + meta.sha256 + ', the file is ' + got + '. Refusing to load it.');
  const text = gunzipSync(buf).toString('utf8');
  const rows = text.split('\n').filter(l => l.length).map(l => JSON.parse(l));
  if (rows.length !== meta.rows) throw new Error(table + ': MANIFEST says ' + meta.rows + ' rows, the file has ' + rows.length);
  return rows;
}

// Per-symbol arrays, oldest first. tables: which to load (default both).
export function loadPrices(dir = findPricesDir(), { tables = ['hourly', 'daily'] } = {}) {
  const manifest = readManifest(dir), out = { dir, manifest };
  for (const t of tables) {
    const key = t === 'hourly' ? 't' : 'd', by = new Map();
    for (const r of readTable(dir, t, manifest)) { let a = by.get(r.s); if (!a) by.set(r.s, (a = [])); a.push(r); }
    for (const a of by.values()) a.sort((x, y) => (x[key] < y[key] ? -1 : x[key] > y[key] ? 1 : 0));
    out[t] = by;
  }
  return out;
}
