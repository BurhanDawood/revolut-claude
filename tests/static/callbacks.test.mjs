// T1 (3) Telegram buttons: every callback_data the code builds ('a:<id>:<n>:<type>') must match the webhook router's cbMatch
// regexes (taken from server.js itself), and every type code used must be routed (a money-button branch or CB_TYPES).
// Static: server.js is read as text; buildAlertKeyboard / specKeyboard are run in a sandbox to produce the real strings.
// Run: node tests/static/callbacks.test.mjs
import assert from 'node:assert/strict';
import { readServer, extractFunction, strictSandbox, runner } from '../lib.mjs';

const SRC = readServer();
const { test, report } = runner('T1 static: Telegram callback_data vs the router (tests/static/callbacks.test.mjs)');

// ── the router ───────────────────────────────────────────────────────────────────────────────
const rStart = SRC.indexOf('const cbMatch = cbData.match(');
const rEnd = SRC.indexOf('const cbCtx = alertContextBySymbol.get(cbCoin)', rStart);
const ROUTER = rStart > 0 && rEnd > rStart ? SRC.slice(rStart, rEnd) : '';
const CB_REGEXES = [...ROUTER.slice(0, Math.max(0, ROUTER.indexOf('if (!cbMatch)'))).matchAll(/\.match\(\/(.+?)\/([gimsuy]*)\)/g)].map(m => new RegExp(m[1], m[2]));
const cbMatch = (d) => { for (const re of CB_REGEXES) { const m = d.match(re); if (m) return m; } return null; };
const MONEY_TYPES = new Set([...(ROUTER.match(/if \(cbMoneyType === [\s\S]*?\) \{/) || [''])[0].matchAll(/cbMoneyType === '([a-z]+)'/g)].map(m => m[1]));
const TJ = /cbIsTradeJournal = cbMoneyType === '([a-z]+)'/.exec(ROUTER);
if (TJ) MONEY_TYPES.add(TJ[1]);
const CB_TYPES_SRC = (ROUTER.match(/const CB_TYPES = (\{[^}]*\})/) || [])[1];
const ALERT_TYPES = new Set(CB_TYPES_SRC ? Object.keys(Function('return ' + CB_TYPES_SRC)()) : []);
const routed = (t) => MONEY_TYPES.has(t) || ALERT_TYPES.has(t);

// ── the builders ─────────────────────────────────────────────────────────────────────────────
const { buildAlertKeyboard, specKeyboard } = strictSandbox({ console }, extractFunction(SRC, 'buildAlertKeyboard') + '\n' + extractFunction(SRC, 'specKeyboard'), ['buildAlertKeyboard', 'specKeyboard']);
const datas = (kb) => (kb ? kb.inline_keyboard.flat().map(b => b.callback_data) : []);
const lineOf = (i) => SRC.slice(0, i).split('\n').length;
// sample ids for the <id> part: a coin symbol and a database id (both shapes are real)
const IDS = ['btc', 'honey', '1000sats', '4242', '987654321'];

// 1. buildAlertKeyboard(<id>, <labels>, '<type>') call sites. Labels: a literal array -> its length; a known variable -> its max length.
const LABEL_VARS = { 'top.map(o => o.label)': 7, labels: 4 };   // tj: opts.slice(0, 7); hs: the hold-step label arrays (4 each)
const bakCalls = [...SRC.matchAll(/buildAlertKeyboard\(([^,]+),\s*(\[[^\]]*\]|[^,]+?),\s*'([a-z]+)'\)/g)].map(m => ({ line: lineOf(m.index), id: m[1].trim(), labels: m[2].trim(), type: m[3] }));
// 2. inline literals: callback_data: 'a:' + <id> + ':<n>:<type>'   and the variable-choice helper   'a:' + <id> + ':' + n + ':<type>'
const litSites = [...SRC.matchAll(/callback_data:\s*'a:'\s*\+\s*([^+]+?)\s*\+\s*':([0-9]+):([a-z]+)'/g)].map(m => ({ line: lineOf(m.index), id: m[1], n: Number(m[2]), type: m[3] }));
const varSites = [...SRC.matchAll(/callback_data:\s*'a:'\s*\+\s*([^+]+?)\s*\+\s*':'\s*\+\s*(\w+)\s*\+\s*':([a-z]+)'/g)].map(m => ({ line: lineOf(m.index), id: m[1], n: m[2], type: m[3] }));
// 3. whole literals: callback_data: 'a:all:3:sx'
const fullSites = [...SRC.matchAll(/callback_data:\s*'(a:[^']*)'\s*[,}]/g)].map(m => ({ line: lineOf(m.index), data: m[1] }));
const builderSite = /callback_data: 'a:' \+ c \+ ':' \+ \(i \+ 1\)/.test(SRC);

await test('CB0', 'the router and every callback_data site were found (a new, unrecognised builder fails here)', async () => {
  assert.ok(ROUTER, 'router block (cbMatch ... alertContextBySymbol.get(cbCoin)) found');
  assert.ok(CB_REGEXES.length >= 1, 'cbMatch regex(es) found'); assert.ok(MONEY_TYPES.size > 5, 'money-button types found'); assert.ok(ALERT_TYPES.size > 5, 'CB_TYPES found');
  assert.ok(builderSite, 'buildAlertKeyboard builds a:<coin>:<n>[:<type>]');
  const total = (SRC.match(/callback_data\s*:/g) || []).length;
  const known = litSites.length + varSites.length + fullSites.length + 1;
  assert.equal(total, known, 'every "callback_data:" in server.js is one of the recognised shapes (' + litSites.length + ' inline, ' + varSites.length + ' helper, ' +
    fullSites.length + ' whole-literal, 1 buildAlertKeyboard); found ' + total);
  assert.ok(bakCalls.length >= 20, 'buildAlertKeyboard call sites: ' + bakCalls.length);
  const all = (SRC.match(/buildAlertKeyboard\(/g) || []).length - 1;   // minus the definition
  assert.equal(bakCalls.length, all, 'every buildAlertKeyboard call has a literal type code');
});
await test('CB1', 'every buildAlertKeyboard button matches cbMatch, and its type is routed', async () => {
  const bad = [];
  for (const c of bakCalls) {
    const n = c.labels.startsWith('[') ? Function('return ' + c.labels)().length : LABEL_VARS[c.labels];
    if (!n) { bad.push('line ' + c.line + ': labels ' + c.labels + ' of unknown length (add it to LABEL_VARS)'); continue; }
    for (const id of IDS) {
      if (c.type === 'tj' && !/^\d+$/.test(id)) continue;   // a Trade Detected button always carries a journal id
      for (const d of datas(buildAlertKeyboard(id, Array.from({ length: n }, (_, i) => 'L' + i), c.type))) {
        const m = cbMatch(d);
        if (!m) bad.push('line ' + c.line + ': ' + d + ' does not match cbMatch');
        else if ((m[3] || '').toLowerCase() !== c.type) bad.push('line ' + c.line + ': ' + d + ' parsed as type ' + m[3]);
      }
    }
    if (!routed(c.type)) bad.push('line ' + c.line + ": type '" + c.type + "' is not routed");
  }
  assert.deepEqual(bad, []);
});
await test('CB2', 'every inline a:<id>:<n>:<type> button matches cbMatch, and its type is routed', async () => {
  const bad = [];
  for (const s of litSites) {
    for (const id of IDS) { const d = 'a:' + id + ':' + s.n + ':' + s.type; if (!cbMatch(d)) bad.push('line ' + s.line + ': ' + d); }
    if (!routed(s.type)) bad.push('line ' + s.line + ": type '" + s.type + "' is not routed");
  }
  assert.ok(litSites.length >= 8, 'inline sites found: ' + litSites.length);
  assert.deepEqual(bad, []);
});
await test('CB2b', 'every whole-literal button (e.g. a:all:3:sx) matches cbMatch, and its type is routed', async () => {
  const bad = [];
  for (const f of fullSites) { const m = cbMatch(f.data); if (!m) bad.push('line ' + f.line + ': ' + f.data); else if (!routed((m[3] || '').toLowerCase())) bad.push('line ' + f.line + ": type '" + m[3] + "' is not routed"); }
  assert.deepEqual(bad, []);
});
await test('CB3', 'the spec-desk helper (variable choice): every button specKeyboard draws, for every status, matches and is routed', async () => {
  assert.deepEqual(varSites.map(s => s.type), ['sk'], 'the only variable-choice builder is specKeyboard (sk)');
  const bad = [];
  for (const status of ['inbox', 'drafting', 'review', 'ready', 'accepted', 'shipped', 'rejected', 'parked'])
    for (const id of [1, 42, 123456]) for (const d of datas(specKeyboard({ id, status }))) {
      const m = cbMatch(d);
      if (!m) bad.push(status + ': ' + d); else if (!routed(m[3])) bad.push(status + ': ' + m[3] + ' not routed');
    }
  assert.deepEqual(bad, []);
});
await test('CB4', 'router sanity: no type is routed two ways; choices 6-7 only for a numeric tj; within the 64-byte cap', async () => {
  const both = [...MONEY_TYPES].filter(t => ALERT_TYPES.has(t));
  assert.deepEqual(both, [], 'types routed two ways: ' + both.join(', '));
  assert.ok(cbMatch('a:4242:7:tj'), 'a 7-choice Trade Detected button is accepted');
  assert.equal(cbMatch('a:btc:7:tj'), null, 'choices 6-7 are for numeric tj only');
  assert.equal(cbMatch('a:4242:6:db'), null, 'choices 6-7 never reach a money button');
  assert.ok(Buffer.byteLength('a:' + '9'.repeat(12) + ':5:abc') <= 64, 'within Telegram\'s 64-byte cap');
});
report();
console.log('   (found: ' + CB_REGEXES.length + ' cbMatch regexes, money types [' + [...MONEY_TYPES].join(' ') + '], alert types [' + [...ALERT_TYPES].join(' ') + '], ' +
  bakCalls.length + ' buildAlertKeyboard calls, ' + litSites.length + ' inline sites, ' + fullSites.length + ' whole-literal sites, ' + varSites.length + ' helper site)');
