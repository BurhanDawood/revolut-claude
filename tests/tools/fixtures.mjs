// T2 fixtures for tests/tools: export pages in the exact endpoint format, and synthetic hourly histories. No network.
import { rng } from '../lib.mjs';

export const H = 3600;
export const T0 = Date.UTC(2025, 8, 1) / 1000;   // 2025-09-01 00:00 UTC, a whole hour

// One page as the server sends it (after curl --compressed): data rows then the end line.
export function page(table, rows, { next = null, sha = 'abcdef12', at = '2026-09-26T04:17:05Z', endOverride = {}, noEnd = false } = {}) {
  const lines = rows.map(r => JSON.stringify(r));
  if (!noEnd) lines.push(JSON.stringify({ end: true, table, rows: rows.length, next, server_sha: sha, at, ...endOverride }));
  return lines.join('\n') + '\n';
}
export const hourRow = (s, t, c, o = {}) => ({ s, t, o: c, h: c, l: c, c, n: 12, ...o });
export const dayRow = (s, d, c, o = {}) => ({ s, d, o: c, h: c, l: c, c, src: 'venue', ...o });

// closes: array of numbers (or null = a missing hour) -> hourly rows for one symbol, oldest first
export function series(s, closes, { t0 = T0, wick = () => null } = {}) {
  const out = [];
  closes.forEach((c, i) => { if (c == null) return; const w = wick(i, c); out.push(hourRow(s, t0 + i * H, c, w == null ? {} : { l: w })); });
  return out;
}
export const flat = (n, v) => Array.from({ length: n }, () => v);
// 7 days flat at 1.0, then 2.2 (a clean pump that the A1 rule must catch)
export const pump = (n = 600) => flat(168, 1).concat(flat(n - 168, 2.2));
// 6 days at 1.0, 24 h at 0.4, back to 1.0 (crash-and-recover: 2.5x the 24 h low but not 1.5x the 7-day median)
export const crashRecover = (n = 600) => flat(144, 1).concat(flat(24, 0.4), flat(n - 168, 1));
// a random walk with occasional missing hours, one-hour wicks and a few pumps (deterministic)
export function walk(n, seed) {
  const r = rng(seed), out = [];
  let p = 1;
  for (let i = 0; i < n; i++) {
    const x = r();
    p *= x > 0.995 ? 2.3 : x < 0.004 ? 0.45 : 1 + (r() - 0.5) * 0.06;
    out.push(r() < 0.02 ? null : Number(p.toPrecision(8)));
  }
  return out;
}
export function toMap(rows) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r.s)) m.set(r.s, []); m.get(r.s).push(r); }
  return m;
}
