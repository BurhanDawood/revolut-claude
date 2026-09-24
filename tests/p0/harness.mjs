// #P0 test harness: plain Node, no dependencies. Pieces of server.js are extracted BY NAME (never by line number) and
// evaluated in a vm sandbox with mocked I/O (db.execute, revolutRequest, krakenRequest, Telegram, order placement).
// server.js itself is never imported or started: nothing here touches a real API or a real database.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = join(ROOT, 'server.js');
export const readServer = () => readFileSync(SERVER, 'utf8');
// The base version (main at the verified sha) for behaviour-unchanged comparisons. Null if git cannot provide it.
export function readBase() {
  for (const ref of ['origin/main', 'main']) {
    try { return execFileSync('git', ['show', ref + ':server.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (e) { /* next */ }
  }
  return null;
}

// (import.meta is module-only syntax; it is neutralised for the parse check alone)
const compiles = (code) => { try { new vm.Script(code.replace(/import\.meta/g, 'IMPORT_META')); return true; } catch (e) { return false; } };
// The shortest prefix starting at `start` and ending just after one of `ends` that parses as a whole script.
function takeParsable(src, start, endRe) {
  endRe.lastIndex = start;
  let m;
  while ((m = endRe.exec(src))) {
    const code = src.slice(start, m.index + m[0].length);
    if (compiles(code)) return code;
  }
  throw new Error('no parsable block from offset ' + start);
}
// A top-level function: the shortest prefix that parses as ONE function expression. Fast path: closing braces at column 0.
export function extractFunction(src, name) {
  const re = new RegExp('^(?:async )?function ' + name + '\\(', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  return functionAt(src, m.index);
}
export function functionAt(src, start) {
  const one = (code) => compiles('(' + code + '\n)');
  for (const [re, tries] of [[/\n\}/g, 3], [/\}/g, Infinity]]) {
    re.lastIndex = start;
    let m, n = 0;
    while (n++ < tries && (m = re.exec(src))) { const code = src.slice(start, m.index + m[0].length); if (one(code)) return code; }
  }
  throw new Error('no parsable function at offset ' + start);
}
// every top-level function declaration: name -> source text
export function topLevelFunctions(src) {
  const out = new Map(), re = /^(?:async )?function (\w+)\(/gm;
  let m;
  while ((m = re.exec(src))) out.set(m[1], functionAt(src, m.index));
  return out;
}
export function extractConst(src, name) {
  const re = new RegExp('^const ' + name + '\\b', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('const not found: ' + name);
  return takeParsable(src, m.index, /;/g);
}
export function extractTool(src, toolName) {
  const i = src.indexOf("server.tool('" + toolName + "',");
  if (i < 0) throw new Error('tool not found: ' + toolName);
  return takeParsable(src, i, /\n {2}\);/g);
}

// ── Sandboxes ──────────────────────────────────────────────────────────────────────────────
// strict: only what the test provides exists (an unmocked dependency is a ReferenceError).
export function strictSandbox(globals, code, exportNames) {
  const ctx = vm.createContext({ ...globals });
  return vm.runInContext(code + '\n;({' + exportNames.join(', ') + '})', ctx);
}
// loose: any identifier the test does not provide becomes a recording async stub, so big legacy functions can run and
// every side effect they attempt is captured in order (calls[] = [name, args]).
export function looseSandbox(globals, code, exportNames, calls) {
  const base = { ...globals };
  const p = new Proxy(base, {
    has() { return true; },
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (k in globalThis) return globalThis[k];
      const stub = (...a) => { calls.push([String(k), a]); return Promise.resolve(undefined); };
      t[k] = stub;
      return stub;
    },
  });
  const ctx = vm.createContext(p);
  return vm.runInContext(code + '\n;({' + exportNames.join(', ') + '})', ctx);
}
// zod stand-in: every property / call returns itself, so schemas build without zod installed.
export function zStub() {
  const f = function () { return chain; };
  const chain = new Proxy(f, { get: (t, k) => (k === 'then' ? undefined : chain), apply: () => chain });
  return chain;
}

// ── Tiny runner ────────────────────────────────────────────────────────────────────────────
export function runner(title) {
  const results = [];
  const test = async (id, name, fn) => {
    try { await fn(); results.push({ id, name, ok: true }); }
    catch (e) { results.push({ id, name, ok: false, err: e && (e.stack || e.message) }); }
  };
  const report = () => {
    console.log('\n== ' + title + ' ==');
    for (const r of results) {
      console.log(r.id.padEnd(6) + ' ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name);
      if (!r.ok) console.log('       ' + String(r.err).split('\n').slice(0, 6).join('\n       '));
    }
    const failed = results.filter(r => !r.ok).length;
    console.log('-- ' + (results.length - failed) + '/' + results.length + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
    if (failed) process.exitCode = 1;
    return failed;
  };
  return { test, report };
}
// plain JSON copy (sandbox objects come from another realm)
export const plain = (x) => JSON.parse(JSON.stringify(x));
