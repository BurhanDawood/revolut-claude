// T2 price export: the page validator, the whole-table checks and the shrink guard. ONE module, used by both
// .github/workflows/export-prices.yml (through the CLI at the bottom) and tests/tools, so the two cannot drift apart.
// Plain Node, no dependencies. Nothing here reaches the network.
//
// Contract (GET {EXPORT_URL}/export/prices?table=hourly|daily[&after=<cursor>]): NDJSON, at most 50,000 rows per page, ordered by
// symbol then time; the LAST line of every page is {"end":true,"table":..,"rows":..,"next":<cursor>|null,"server_sha":..,"at":..}.
//
// CLI (what the workflow runs):
//   node tools/data/validate.mjs page <hourly|daily> <file>      -> validates one page; prints the next cursor ('' when done)
//   node tools/data/validate.mjs build <pagesDir> <outDir> [--prev MANIFEST.json] [--run-id N] [--allow-shrink]
//        -> re-validates every page, checks the whole table, applies the shrink guard, writes <outDir>/{hourly,daily}.ndjson.gz
//           and MANIFEST.json. Exit 1 (and nothing written) on any failure.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TABLES = { hourly: 'price_intraday_hourly', daily: 'price_daily_ohlc' };
export const MAX_ROWS_PER_PAGE = 50000;
export const MAX_SHRINK = 0.10;               // a table may lose at most 10 % of its rows vs the MANIFEST already published
export const MAX_FILE_BYTES = 95 * 1024 * 1024; // GitHub refuses files over 100 MB

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isInt = (x) => Number.isInteger(x);
const isStr = (x) => typeof x === 'string' && x.length > 0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// One data row: returns null when it is well-formed, else what is wrong.
export function rowProblem(table, r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if ('end' in r) return 'an end line before the last line';
  if (!isStr(r.s)) return 's must be a non-empty string';
  for (const k of ['o', 'h', 'l', 'c']) if (!isNum(r[k])) return k + ' must be a finite number';
  if (table === 'hourly') {
    if (!isInt(r.t) || r.t <= 0 || r.t % 3600 !== 0) return 't must be a whole-hour unix time in seconds';
    if (!isInt(r.n) || r.n < 0) return 'n must be an integer >= 0';
  } else {
    if (typeof r.d !== 'string' || !DATE.test(r.d) || Number.isNaN(Date.parse(r.d + 'T00:00:00Z'))) return 'd must be a YYYY-MM-DD date';
    if (!isStr(r.src)) return 'src must be a non-empty string';
  }
  return null;
}

// Validates one page (the raw, already-decompressed NDJSON text). Throws an Error naming the line on anything wrong.
// Returns { rows: [...data rows], end: {...the end line} }.
export function validatePage(text, table) {
  if (!TABLES[table]) throw new Error('unknown table: ' + table);
  if (typeof text !== 'string' || !text.length) throw new Error(table + ' page: empty body');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();   // one trailing newline is fine
  if (!lines.length) throw new Error(table + ' page: empty body');
  const parsed = lines.map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(table + ' page line ' + (i + 1) + ': not JSON (' + e.message + ')'); }
  });
  const end = parsed[parsed.length - 1];
  if (!end || typeof end !== 'object' || end.end !== true) throw new Error(table + ' page: no end line (truncated page)');
  if (end.table !== table) throw new Error(table + ' page: end line is for table ' + JSON.stringify(end.table));
  if (!isInt(end.rows) || end.rows < 0) throw new Error(table + ' page: end.rows must be an integer >= 0');
  if (!(end.next === null || isStr(end.next))) throw new Error(table + ' page: end.next must be a non-empty string or null');
  if (typeof end.server_sha !== 'string' || !/^[0-9a-f]{8}$/.test(end.server_sha)) throw new Error(table + ' page: end.server_sha must be 8 hex characters');
  if (typeof end.at !== 'string' || Number.isNaN(Date.parse(end.at))) throw new Error(table + ' page: end.at must be an ISO time');
  const rows = parsed.slice(0, -1);
  if (rows.length !== end.rows) throw new Error(table + ' page: end line says ' + end.rows + ' rows, the page has ' + rows.length);
  if (rows.length > MAX_ROWS_PER_PAGE) throw new Error(table + ' page: ' + rows.length + ' rows is over the ' + MAX_ROWS_PER_PAGE + ' limit');
  if (end.next !== null && rows.length === 0) throw new Error(table + ' page: no rows but a next cursor (would loop)');
  rows.forEach((r, i) => { const p = rowProblem(table, r); if (p) throw new Error(table + ' page line ' + (i + 1) + ': ' + p); });
  return { rows, end };
}

// Whole table (all pages, in order): each symbol is one contiguous run, strictly increasing in time (no duplicate, no reorder,
// no symbol coming back after another started). Collation-independent: the server's symbol order is not re-checked.
export function checkTableOrder(table, rows) {
  const key = table === 'hourly' ? 't' : 'd';
  const done = new Set();
  let cur = null, last = null;
  rows.forEach((r, i) => {
    if (r.s !== cur) {
      if (done.has(r.s)) throw new Error(table + ': symbol ' + r.s + ' appears again at row ' + (i + 1) + ' (pages overlap or are out of order)');
      if (cur !== null) done.add(cur);
      cur = r.s; last = null;
    } else if (!(r[key] > last)) throw new Error(table + ': ' + r.s + ' is not strictly increasing in time at row ' + (i + 1) + ' (' + last + ' then ' + r[key] + ')');
    last = r[key];
  });
}

// Shrink guard. prev: the MANIFEST already on data-prices (or null the first time). counts: { hourly: n, daily: n }.
// A table with MORE than 10 % fewer rows than before fails (10 % exactly passes). Returns [] when fine, else the problems.
export function shrinkProblems(prev, counts, maxShrink = MAX_SHRINK) {
  const out = [];
  if (!prev) return out;
  for (const t of Object.keys(TABLES)) {
    const was = prev.tables && prev.tables[t] ? Number(prev.tables[t].rows) : null;
    if (!(was > 0)) continue;
    const now = counts[t] || 0;
    // integer arithmetic: (was - now) / was > maxShrink, without float rounding at the boundary
    if ((was - now) * 1e6 > Math.round(maxShrink * 1e6) * was) out.push(t + ': ' + now + ' rows vs ' + was + ' published (' + (((was - now) / was) * 100).toFixed(1) + '% fewer, the limit is ' + maxShrink * 100 + '%)');
  }
  return out;
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const iso = (t) => new Date(t * 1000).toISOString();

// Builds the gzip files and the MANIFEST from validated rows. Pure: returns { files: {name: Buffer}, manifest } and writes nothing.
export function buildOutput(tables, { serverSha, runId = null, exportedAt = new Date().toISOString() } = {}) {
  const files = {}, manifest = { format: 1, exported_at: exportedAt, server_sha: serverSha || null, workflow_run_id: runId == null ? null : String(runId), tables: {} };
  for (const t of Object.keys(TABLES)) {
    const rows = tables[t] || [];
    const buf = gzipSync(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8'), { level: 9 });
    const name = t + '.ndjson.gz';
    files[name] = buf;
    const times = rows.map(r => (t === 'hourly' ? r.t : r.d));
    const first = times.length ? times.reduce((a, b) => (b < a ? b : a)) : null, last = times.length ? times.reduce((a, b) => (b > a ? b : a)) : null;
    manifest.tables[t] = { file: name, source_table: TABLES[t], rows: rows.length, symbols: new Set(rows.map(r => r.s)).size,
      first: first == null ? null : t === 'hourly' ? iso(first) : first, last: last == null ? null : t === 'hourly' ? iso(last) : last,
      ...(t === 'hourly' ? { first_t: first, last_t: last } : {}), bytes: buf.length, sha256: sha256(buf) };
  }
  return { files, manifest };
}

// Reads a pages directory written by the workflow (<table>-0001.ndjson, ...), validates everything and returns what buildOutput needs.
// Every page of the run (both tables) must carry the same server_sha: pages from two server versions are never mixed.
export function readPages(pagesDir) {
  const names = readdirSync(pagesDir).filter(f => /^(hourly|daily)-\d{4}\.ndjson$/.test(f)).sort();
  const tables = { hourly: [], daily: [] }, shas = new Set();
  let serverSha = null;
  for (const t of Object.keys(TABLES)) {
    const pages = names.filter(f => f.startsWith(t + '-'));
    if (!pages.length) throw new Error(t + ': no pages');
    pages.forEach((f, i) => {
      const { rows, end } = validatePage(readFileSync(join(pagesDir, f), 'utf8'), t);
      if ((end.next === null) !== (i === pages.length - 1)) throw new Error(t + ': ' + f + (end.next === null ? ' says done but more pages follow' : ' is the last page but has a next cursor (export incomplete)'));
      for (const r of rows) tables[t].push(r);
      shas.add(end.server_sha); serverSha = end.server_sha;
    });
    if (!tables[t].length) throw new Error(t + ': the export has no rows');
    if (shas.size > 1) throw new Error('the pages come from more than one server version (server_sha ' + [...shas].join(', ') + '): the server was redeployed during the export. Nothing published; re-run the workflow.');
    checkTableOrder(t, tables[t]);
  }
  return { tables, serverSha };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'page') {
    const [table, file] = rest;
    const { end } = validatePage(readFileSync(file, 'utf8'), table);
    process.stdout.write(end.next === null ? '' : end.next);
    process.stderr.write(table + ' page ok: ' + end.rows + ' rows, server ' + end.server_sha + (end.next === null ? ', last page' : '') + '\n');
    return;
  }
  if (cmd === 'build') {
    const [pagesDir, outDir] = rest;
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
    const prevFile = opt('--prev');
    let prev = null;
    if (prevFile && existsSync(prevFile)) {
      try { prev = JSON.parse(readFileSync(prevFile, 'utf8')); } catch (e) { throw new Error('the published MANIFEST is not valid JSON (' + e.message + '); refusing to overwrite blind'); }
    }
    const { tables, serverSha } = readPages(pagesDir);
    const counts = { hourly: tables.hourly.length, daily: tables.daily.length };
    const shrink = shrinkProblems(prev, counts);
    if (shrink.length) {
      if (rest.includes('--allow-shrink')) console.log('::warning title=Shrink guard overridden::' + shrink.join('; '));
      else throw new Error('shrink guard: ' + shrink.join('; ') + '. Nothing published. (A deliberate shrink: run the workflow by hand with allow_shrink.)');
    }
    const { files, manifest } = buildOutput(tables, { serverSha, runId: opt('--run-id') });
    for (const [n, b] of Object.entries(files)) if (b.length > MAX_FILE_BYTES) throw new Error(n + ' is ' + b.length + ' bytes, over the ' + MAX_FILE_BYTES + ' limit GitHub accepts');
    mkdirSync(outDir, { recursive: true });
    for (const [n, b] of Object.entries(files)) writeFileSync(join(outDir, n), b);
    writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  throw new Error('usage: validate.mjs page <hourly|daily> <file> | build <pagesDir> <outDir> [--prev FILE] [--run-id N] [--allow-shrink]');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // a page failure is retried by the workflow, so it is plain text; a build failure is final and becomes an error annotation
  try { cli(process.argv.slice(2)); } catch (e) { console.error((process.argv[2] === 'build' ? '::error title=Price export::' : '') + e.message); process.exit(1); }
}
