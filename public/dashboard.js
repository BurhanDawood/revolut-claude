// dashboard.js v3.1.0 — matched to dashboard.html

var DASHBOARD_VERSION = '3.2.0';   // #352 dashboard audit (Dev-343)
var csMap = {};
var ledgerCache = null;
console.log('Dashboard v' + DASHBOARD_VERSION);

window.onerror = function(msg, src, line) {
  var b = document.getElementById('error-banner');
  if (b) { b.textContent = 'JS Error line '+line+': '+msg; b.style.display = 'block'; }
};

// ── Helpers ───────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function fmtUSD(n) {
  n = parseFloat(n);
  if (isNaN(n)) return '—';
  var abs = Math.abs(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  return (n < 0 ? '-$' : '$') + abs;
}

function fmtPct(n) {
  n = parseFloat(n);
  if (isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtQty(n, dp) {
  n = parseFloat(n);
  dp = dp || 4;
  if (isNaN(n)) return '—';
  if (n >= 1000000000) return (n/1000000000).toFixed(2) + 'B';
  if (n >= 1000000) return (n/1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n/1000).toFixed(2) + 'K';
  if (n < 0.000001) return n.toFixed(10);
  if (n < 0.0001) return n.toFixed(8);
  if (n < 0.01) return n.toFixed(6);
  return n.toFixed(dp);
}

function fmtPrice(n) {
  n = parseFloat(n);
  if (isNaN(n) || n === 0) return '$0';
  if (n < 0.000001) return '$' + n.toFixed(10);
  if (n < 0.0001) return '$' + n.toFixed(8);
  if (n < 0.01) return '$' + n.toFixed(6);
  if (n < 1) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

function setText(id, val, color) {
  var el = $(id);
  if (!el) return;
  el.textContent = (val !== undefined && val !== null) ? val : '—';
  if (color) el.style.color = color;
}

function showEl(id) { var el = $(id); if (el) el.style.display = ''; }
function hideEl(id) { var el = $(id); if (el) el.style.display = 'none'; }

function showToast(msg, isError) {
  var t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast ' + (isError ? 'error' : 'success') + ' show';
  setTimeout(function() { t.className = 'toast'; }, 3000);
}

// #352: a failed load used to return null silently and leave panels on 'Loading...' forever. Now it says so - at most
// one notice every 10 seconds, so a burst of failures (for example the server restarting) shows once, not twenty times.
var _lastLoadWarn = 0;
function fetchData(url) {
  return fetch(url).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).catch(function(e) {
    console.error('Fetch error ' + url + ':', e.message);
    var now = Date.now();
    if (now - _lastLoadWarn > 10000) {
      _lastLoadWarn = now;
      showToast('Some data did not load (' + e.message + ') - it will retry on the next refresh', true);
    }
    return null;
  });
}

// ── Tab switching ─────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(p) { p.classList.remove('active'); });
  var pane = $('tab-' + name);
  if (pane) pane.classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    if (b.getAttribute('onclick') && b.getAttribute('onclick').indexOf("'" + name + "'") > -1) {
      b.classList.add('active');
    }
  });
  if (name === 'activity') loadActivity('all');
  if (name === 'journal') { loadJournalEntries(); loadJournalStats(); }
  if (name === 'scorecards') loadScorecards();
  if (name === 'concentration') loadConcentration();
  if (name === 'rotations') loadRotations();
}

// ── Portfolio ─────────────────────────────────────────────────────

function loadPortfolio() {
  fetchData('/portfolio/summary').then(function(data) {
    if (!data) { setText('portfolio-value', 'Error'); return; }

    var revCrypto = parseFloat(data.total_value_usd || 0);
    var cashObj = data.cash_available || {};
    var revCashUSD = parseFloat(cashObj.revolut_usd || data.cash_usd || 0);
    var revCashUSDT = parseFloat(cashObj.revolut_usdt || data.cash_usdt || 0);
    var revCash = revCashUSD + revCashUSDT;
    var krakenCrypto = parseFloat(data.kraken_total_usd || 0);
    var krakenCash = parseFloat(cashObj.kraken_usd || 0);

    var tangemVal = 0, tangemXRP = 0, tangemPrice = 0, tangemEntry = 2.65;
    if (data.tangem) {
      tangemVal = parseFloat(data.tangem.valueUSD || 0);
      tangemXRP = parseFloat(data.tangem.balance || 0);
      tangemPrice = tangemXRP > 0 ? tangemVal / tangemXRP : 0;
      tangemEntry = parseFloat(data.tangem.entryPrice || 2.65);
    }
    var tangemUSD = parseFloat(data.tangem_value_usd || 0);
    if (tangemUSD) tangemVal = tangemUSD;
    if (!tangemVal && tangemXRP === 0) { tangemXRP = 1008.43; tangemPrice = 1.2175; tangemVal = tangemXRP * tangemPrice; }

    var totalCrypto = revCrypto + krakenCrypto + tangemVal;
    var totalCash = revCash + krakenCash;
    var grandTotal = totalCrypto + totalCash;

    setText('portfolio-value', fmtUSD(grandTotal));
    showEl('portfolio-totals');
    setText('revolut-crypto-subtotal', fmtUSD(revCrypto));
    setText('revolut-cash-subtotal', fmtUSD(revCash));
    setText('kraken-crypto-subtotal', fmtUSD(krakenCrypto));
    setText('kraken-cash-subtotal', fmtUSD(krakenCash));
    setText('tangem-subtotal', fmtUSD(tangemVal));
    setText('portfolio-crypto-sum', fmtUSD(totalCrypto));
    setText('portfolio-cash-sum', fmtUSD(totalCash));
    setText('portfolio-total-sum', fmtUSD(grandTotal));

    showEl('capital-bar');
    var inv = parseFloat(data.invested || 0);
    var plUsd = parseFloat(data.pl_usd || 0);
    var plPct = parseFloat(data.pl_pct || 0);
    var breakEven = (inv > 0 && grandTotal > 0) ? ((inv - grandTotal) / grandTotal * 100) : 0;
    setText('cap-invested', fmtUSD(inv));
    setText('cap-current', fmtUSD(grandTotal));
    setText('cap-pnl',
      (plUsd >= 0 ? '+' : '\u2212') + fmtUSD(Math.abs(plUsd)) + ' (' + fmtPct(plPct) + ')',   // #495 the sign and thousands (was "$15807.84")
      plUsd >= 0 ? '#00ff88' : '#ff4444');
    setText('cap-breakeven', '+' + breakEven.toFixed(1) + '% needed', '#ffaa00');

    var positions = data.positions || [];   // #528 the P&L summary bar (tracked / in profit / in loss / unrealised) is removed

    hideEl('tangem-loading'); showEl('tangem-content');
    setText('tangem-value-usd', fmtUSD(tangemVal));
    setText('tangem-xrp-qty', fmtQty(tangemXRP, 2) + ' XRP');
    setText('tangem-address', 'r4E3rtCa4FT4HxTQV2iw3yQHRTrAHMYS3v');
    if (tangemEntry > 0 && tangemPrice > 0) {
      var tPlUsd = tangemXRP * (tangemPrice - tangemEntry);
      var tPlPct = ((tangemPrice - tangemEntry) / tangemEntry * 100);
      setText('tangem-pnl-usd', (tPlUsd >= 0 ? '+' : '\u2212') + fmtUSD(Math.abs(tPlUsd)) /* #496 sign + thousands (was $1154.54 in red) */, tPlUsd >= 0 ? '#00ff88' : '#ff4444');
      setText('tangem-pnl-pct', fmtPct(tPlPct), tPlPct >= 0 ? '#00ff88' : '#ff4444');
      setText('tangem-entry-line', 'Entry: $' + tangemEntry.toFixed(4));
    }

    loadCoins();   // #516 the one coin list (was the #57 S4 card grid)
    setText('last-updated', 'Updated ' + new Date().toLocaleTimeString('en-GB'));
  });
}

// ── #57 S4: asset cards ───────────────────────────────────────────

var META_ROWS = { DEAD_BAGS: 1, EXITED: 1 };
var WATCH_ROLES = { watch_entry: 1, radar: 1 };

function esc(x) {
  return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function roleBadge(role) {
  if (!role) return '';
  var colors = { anchor:'#ffd700', swing:'#4488ff', hodl:'#aa44ff', lotto:'#ff8800', dead_bag:'#777777', watch_entry:'#00bbcc', radar:'#888888' };
  var c = colors[role] || '#888888';
  return ' <span class="rx-role" style="font-size:9px;padding:1px 6px;border-radius:8px;background:' + c + '22;color:' + c + ';border:1px solid ' + c + '55">' + esc(role.replace('_', ' ')) + '</span>';
}

function posPL(pos) {
  if (!pos) return null;
  var ep = parseFloat(pos.entry_price || 0), cp = parseFloat(pos.current_price || 0);
  return ep > 0 ? ((cp - ep) / ep * 100) : null;
}

function sectionHeader(label, n) {
  return '<div class="rx-sech" style="color:#666;font-size:11px;font-weight:bold;letter-spacing:1px;margin:14px 0 8px;text-transform:uppercase">' + label + ' <span style="color:#444">(' + n + ')</span></div>';
}

function renderHoldingsGrid(positions) {
  var holdEl = $('holdings-list');
  if (!holdEl) return;
  var posMap = {};
  for (var i = 0; i < positions.length; i++) posMap[positions[i].currency] = positions[i];

  var btc = null, featured = [], watching = [], deadbags = [];
  for (var sym in csMap) {
    if (!csMap.hasOwnProperty(sym) || META_ROWS[sym]) continue;
    var cs = csMap[sym];
    var e = { sym: sym, cs: cs, pos: posMap[sym] || null };
    if (sym === 'BTC') btc = e;
    else if (WATCH_ROLES[cs.role]) watching.push(e);
    else featured.push(e);
  }
  for (var j = 0; j < positions.length; j++) {
    var p = positions[j];
    if (csMap[p.currency] || META_ROWS[p.currency]) continue;
    deadbags.push({ sym: p.currency, cs: null, pos: p });
  }

  var byVal = function(a, b) { return parseFloat((b.pos && b.pos.value_usd) || 0) - parseFloat((a.pos && a.pos.value_usd) || 0); };
  featured.sort(byVal); deadbags.sort(byVal); watching.sort(byVal);

  var html = '';

  if (btc) {
    var bp = btc.pos ? fmtPrice(btc.pos.current_price) : '';
    html += '<div onclick="rxOpenCoin(\'BTC\')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:8px 12px;margin-bottom:10px;background:#15171c;border:1px solid #333;border-radius:4px">'
      + '<span style="color:#9aa0aa;font-weight:bold;font-size:12px">\u{1F4E1} BTC \u00B7 MACRO RADAR</span>'
      + '<span style="color:#aaa;font-size:12px">' + bp + ' \u25BE</span></div>'
      + '<div id="card-detail-BTC" style="display:none;margin:-6px 0 12px;padding:0 12px 10px"></div>';
  }

  html += sectionHeader('Holdings', featured.length + (deadbags.length ? 1 : 0));
  for (var f = 0; f < featured.length; f++) html += makeCard(featured[f], false);

  if (deadbags.length) {
    var dbVal = 0;
    for (var d = 0; d < deadbags.length; d++) dbVal += parseFloat((deadbags[d].pos && deadbags[d].pos.value_usd) || 0);
    html += '<div onclick="toggleDeadbags()" style="cursor:pointer;display:flex;justify-content:space-between;padding:10px 12px;margin-bottom:8px;background:#161616;border-left:3px solid #555;border-radius:4px">'
      + '<span style="color:#999;font-weight:bold">\u{1F480} Dead bags (' + deadbags.length + ')</span>'
      + '<span style="color:#999">$' + dbVal.toFixed(2) + ' \u25BE</span></div>'
      + '<div id="deadbags-list" style="display:none">';
    for (var dd = 0; dd < deadbags.length; dd++) html += makeCard(deadbags[dd], false);
    html += '</div>';
  }

  html += sectionHeader('Watching for entry', watching.length);
  if (!watching.length) html += '<div class="empty-state">None</div>';
  for (var w = 0; w < watching.length; w++) html += makeCard(watching[w], true);

  holdEl.innerHTML = html || '<div class="empty-state">No positions</div>';
}

function makeCard(e, isWatch) {
  var sym = e.sym, cs = e.cs, pos = e.pos;
  var val = parseFloat((pos && pos.value_usd) || 0);
  var pl = posPL(pos);
  var plc = (pl == null) ? '#555555' : (pl >= 0 ? '#00ff88' : '#ff4444');
  var border = isWatch ? '#00bbcc' : plc;
  var overnight = parseFloat((pos && pos.change_from_baseline_pct) || 0);

  var right;
  if (isWatch) {
    right = (val >= 0.01)
      ? '<span class="rx-sub" style="color:#888;font-size:11px">dust $' + val.toFixed(2) + '</span>'
      : '<span class="rx-sub" style="color:#00bbcc;font-size:11px">watching</span>';
  } else {
    right = '<span style="color:white;font-weight:bold">$' + val.toFixed(2) + '</span>'
      + (pl != null ? '<br><span class="rx-sub" style="color:' + plc + ';font-size:11px">' + fmtPct(pl) + '</span>' : '');
  }
  if (overnight !== 0) {
    right += '<br><span class="rx-sub" style="font-size:9px;color:' + (overnight >= 0 ? '#00ff88' : '#ff4444') + '">' + (overnight >= 0 ? '+' : '') + overnight.toFixed(1) + '% o/n</span>';
  }

  return '<div class="rx-coin" style="border-left:3px solid ' + border + ';margin-bottom:8px;background:#1a1a1a;border-radius:4px">'   // #505 classes: phone sizes in dashboard.html
    + '<div class="rx-coin-head" onclick="rxOpenCoin(\'' + sym + '\')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:flex-start;padding:10px 12px">'
    + '<span class="rx-coin-sym" style="color:white;font-weight:bold">' + esc(sym) + (cs ? roleBadge(cs.role) : '') + '</span>'
    + '<div class="rx-coin-val" style="text-align:right">' + right + ' <span style="color:#666">\u203A</span></div>'
    + '</div>'
    + '<div class="rx-cd" id="card-detail-' + sym + '" style="display:none;padding:0 12px 12px;border-top:1px solid #2a2a2a"></div>'
    + '</div>';
}

// ── #516 the one coin list ────────────────────────────────────────
// Bryan 30 Sep 09:17-09:23: one list like Revolut's home screen (logo, name, amount and price, value, 24 h change); a tap opens the
// coin's card; the watchlist shows its top three (closest to a buy level first) with the rest folded; dust and sold coins folded.
var rxCoinsBusy = false, rxCoinsData = null;
function rxAttr(x) { return esc(x).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
var rxCoinFolds = (function () { try { return JSON.parse(localStorage.getItem('rx_coin_folds') || '{}') || {}; } catch (e) { return {}; } })();
function rxCoinPx(v) {
  if (v == null || !isFinite(v) || v <= 0) return '–';
  var a = Math.abs(v), d = a >= 1000 ? 2 : a >= 1 ? 4 : Math.min(10, Math.max(4, 3 - Math.floor(Math.log10(a))));
  return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: a >= 1000 ? 2 : Math.min(d, 2), maximumFractionDigits: d });
}
function rxCoinQty(v) {
  if (v == null || !isFinite(v)) return '';
  var a = Math.abs(v);
  return a >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 0 : a >= 1 ? 2 : 6 });
}
function rxCoinMoney(v, signed) {
  if (v == null || !isFinite(v)) return '–';
  var s = '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return signed ? (v >= 0 ? '+' : '−') + s : (v < 0 ? '−' : '') + s;
}
function rxCoinChg(p) {
  if (p == null || !isFinite(p)) return '<span class="cl-mu">–</span>';
  return '<span class="' + (p >= 0 ? 'cl-up' : 'cl-dn') + '">' + (p >= 0 ? '▲ ' : '▼ ') + Math.abs(p).toFixed(2) + '%</span>';
}
function rxCoinIcon(c) {
  var h = 0; for (var i = 0; i < c.coin.length; i++) h = (h * 31 + c.coin.charCodeAt(i)) % 360;
  var letter = '<span style="width:100%;height:100%;display:grid;place-items:center;background:hsl(' + h + ',45%,32%)">' + esc(c.coin.charAt(0)) + '</span>';
  var alt = [c.icon || 'https://assets.coincap.io/assets/icons/' + String(c.coin || '').toLowerCase() + '@2x.png'].filter(function (u) { return u && !rxIcDead[u]; });   // #527 the server's logo, matched by name; #534 while the server has none, CoinCap's by ticker, then the letter
  if (!alt.length) return '<span class="cl-ic">' + letter + '</span>';
  return '<span class="cl-ic"><img alt="" loading="lazy" referrerpolicy="no-referrer" src="' + rxAttr(alt[0]) + '" data-alt="' + rxAttr(alt.slice(1).join('|')) + '" data-l="' + rxAttr(letter) + '" onerror="rxIcNext(this)"></span>';
}
var rxIcDead = {};   // #518 logo addresses that failed on this page, so the minute refresh does not ask again
function rxIcNext(im) {   // #517 the next logo source, and the coin's letter when none has one
  rxIcDead[im.getAttribute('src')] = 1;
  var rest = (im.getAttribute('data-alt') || '').split('|').filter(Boolean);
  if (rest.length) { im.setAttribute('data-alt', rest.slice(1).join('|')); im.src = rest[0]; } else im.outerHTML = im.getAttribute('data-l');
}
function rxCoinRow(c, kind) {
  var chips = [];
  if (c.alerts) chips.push('<span class="cl-chip">🔔 ' + c.alerts + '</span>');
  if (c.loop) chips.push('<span class="cl-chip' + (c.loop.armed ? ' on' : '') + '">🔁 ' + (c.loop.armed ? 'armed' : c.loop.sold ? 'buy-back' : c.loop.enabled ? 'loop' : 'loop off') + '</span>');
  if (c.trail) chips.push('<span class="cl-chip' + (c.trail.auto ? ' warn' : '') + '">🎯 trail ' + c.trail.pct + '%</span>');
  (c.venues || []).forEach(function (v) { if (v !== 'Revolut X') chips.push('<span class="cl-chip">' + esc(v) + '</span>'); });
  if (c.muted) chips.push('<span class="cl-chip">🔇 muted</span>');
  if (c.buylist && kind !== 'buy') chips.push('<span class="cl-chip on">\u2B50 buy list</span>');   // #521
  var name = c.name || c.coin, sub, right;
  if (kind === 'watch' || kind === 'buy') {
    sub = esc(c.coin) + ' · ' + rxCoinPx(c.price) + (c.buy_at ? ' · buy ' + rxCoinPx(c.buy_at) + ' (' + c.buy_gap_pct.toFixed(1) + '% away)' : c.role ? ' · ' + esc(c.role.replace('_', ' ')) : '');
    right = '<b>' + rxCoinPx(c.price) + '</b>' + rxCoinChg(c.change24h);
  } else if (kind === 'sold') {
    sub = esc(c.coin) + ' · none held';
    right = '<b class="' + (c.lifetime >= 0 ? 'cl-up' : 'cl-dn') + '">' + rxCoinMoney(c.lifetime, true) + '</b><span class="cl-mu">lifetime</span>';
  } else {
    sub = rxCoinQty(c.qty) + ' ' + esc(c.coin) + ' · ' + rxCoinPx(c.price);
    right = '<b>' + rxCoinMoney(c.value) + '</b>' + rxCoinChg(c.change24h);
  }
  return '<button type="button" class="cl-row" onclick="rxOpenCoin(\'' + esc(c.coin) + '\')">' + rxCoinIcon(c) +
    '<span class="cl-nm"><b>' + esc(name) + '</b><span class="cl-sub">' + sub + '</span>' + (chips.length ? '<span class="cl-chips">' + chips.join('') + '</span>' : '') + '</span>' +
    '<span class="cl-vl">' + right + '</span></button>';
}
function rxCoinFold(key, label, list, kind, showFirst, totalTxt) {
  if (!list.length) return '';
  var open = !!rxCoinFolds[key], h = '';
  var head = list.slice(0, showFirst), rest = list.slice(showFirst);
  head.forEach(function (c) { h += rxCoinRow(c, kind); });
  if (rest.length) {
    h += '<div class="cl-fold" id="cl-fold-' + key + '"' + (open ? '' : ' hidden') + '>' + rest.map(function (c) { return rxCoinRow(c, kind); }).join('') + '</div>' +
      '<button type="button" class="cl-more" onclick="rxCoinToggle(\'' + key + '\', this)" data-closed="' + rxAttr(label) + '"><span>' + (open ? 'Show less ▴' : esc(label)) + '</span><span class="cl-mu">' + (totalTxt || '') + '</span></button>';
  }
  return h;
}
function rxCoinToggle(key, b) {
  var f = $('cl-fold-' + key); if (!f) return;
  f.hidden = !f.hidden; rxCoinFolds[key] = !f.hidden;
  try { localStorage.setItem('rx_coin_folds', JSON.stringify(rxCoinFolds)); } catch (e) {}
  b.firstChild.textContent = f.hidden ? b.getAttribute('data-closed') : 'Show less ▴';
}
function rxCoinsRender(d) {
  var el = $('holdings-list'); if (!el) return;
  var all = (d && d.coins) || [];
  var hold = all.filter(function (c) { return c.section === 'hold'; });
  var watch = all.filter(function (c) { return c.section === 'watch'; }).sort(function (a, b) {
    var x = a.buy_gap_pct, y = b.buy_gap_pct;
    if (x != null && y != null) return x - y;
    if (x != null) return -1; if (y != null) return 1;
    return (a.name || a.coin).localeCompare(b.name || b.coin);
  });
  var buy = all.filter(function (c) { return c.buylist; }).sort(function (a, b) {   // #521 every buy-list coin, held or not, nearest a buy level first
    var x = a.buy_gap_pct, y = b.buy_gap_pct;
    if (x != null && y != null) return x - y;
    if (x != null) return -1; if (y != null) return 1;
    return (a.name || a.coin).localeCompare(b.name || b.coin);
  });
  var dust = all.filter(function (c) { return c.section === 'dust'; });
  var sold = all.filter(function (c) { return c.section === 'sold'; }).sort(function (a, b) { return Math.abs(b.lifetime || 0) - Math.abs(a.lifetime || 0); });
  var sum = function (l) { return l.reduce(function (s, c) { return s + (c.value || 0); }, 0); };
  var h = '';
  h += '<div class="cl-sec"><span>Holdings (' + hold.length + ')</span><span>' + rxCoinMoney(sum(hold)) + '</span></div>';
  h += hold.length ? hold.map(function (c) { return rxCoinRow(c, 'hold'); }).join('') : '<div class="empty-state">No holdings</div>';
  // #524 the Buy list group always shows, with an "Add a coin" box at its foot (the same save as the coin-card star)
  h += '<div class="cl-sec"><span>\u2B50 Buy list (' + buy.length + ')</span></div>' + buy.map(function (c) { return rxCoinRow(c, 'buy'); }).join('') +
    '<form class="bl-add" onsubmit="return rxBuyAdd(this)"><input name="c" maxlength="15" placeholder="Add a coin, e.g. VVV" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Coin to add to the buy list"><button type="submit">Add</button><span class="bl-msg" role="status">' + esc(rxBlMsg) + '</span></form>';
  if (watch.length) h += '<div class="cl-sec"><span>Watchlist (' + watch.length + ')</span></div>' + rxCoinFold('watch', 'Show all ' + watch.length + ' ▾', watch, 'watch', 3);
  if (dust.length) h += '<div class="cl-sec"><span>Dust (' + dust.length + ')</span></div>' + rxCoinFold('dust', 'Show ' + dust.length + (dust.length === 1 ? ' coin' : ' coins') + ' under $' + (d.dust_usd || 1) + ' ▾', dust, 'dust', 0, rxCoinMoney(sum(dust)));
  if (sold.length) h += '<div class="cl-sec"><span>Sold (' + sold.length + ')</span></div>' + rxCoinFold('sold', 'Show ' + sold.length + (sold.length === 1 ? ' coin' : ' coins') + ' you no longer hold ▾', sold, 'sold', 0);
  el.innerHTML = h;
  var L = d && d.ledger, le = $('coins-ledger');
  if (le) {
    var col = function (v) { return v == null ? '' : v < 0 ? 'cl-dn' : 'cl-up'; };
    le.innerHTML = L ? 'Lifetime P&amp;L <b class="' + col(L.lifetime) + '">' + rxCoinMoney(L.lifetime, true) + '</b> · realised <b class="' + col(L.realized) + '">' + rxCoinMoney(L.realized, true) + '</b> · unrealised <b class="' + col(L.unrealized) + '">' + rxCoinMoney(L.unrealized, true) + '</b>' +
      (L.partial ? '<br><span class="cl-mu">' + L.partial + ' older sells have no P&amp;L recorded, so realised is partial</span>' : '') : '';
  }
}
// #518 Top movers: your holdings and watchlist (not dust or sold) by 24 h change; eight tiles; the chosen side is remembered.
var rxMvSide = (function () { try { return localStorage.getItem('rx_movers') === 'down' ? 'down' : 'up'; } catch (e) { return 'up'; } })();
function rxMoversRender(d) {
  var g = $('mv-grid'); if (!g) return;
  [].forEach.call(document.querySelectorAll('#movers-card .mv-seg button'), function (b) { var on = b.getAttribute('data-mv') === rxMvSide; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  var mine = ((d && d.coins) || []).filter(function (c) { return (c.section === 'hold' || c.section === 'watch' || c.section === 'buy') && c.change24h != null && isFinite(c.change24h); });
  var up = rxMvSide === 'up';
  var list = mine.filter(function (c) { return up ? c.change24h > 0 : c.change24h < 0; }).sort(function (a, b) { return up ? b.change24h - a.change24h : a.change24h - b.change24h; }).slice(0, 8);
  g.innerHTML = list.length ? list.map(function (c) {
    return '<button type="button" class="mv" onclick="rxOpenCoin(\'' + esc(c.coin) + '\')">' + rxCoinIcon(c) + '<b>' + esc(c.coin) + '</b>' + rxCoinChg(c.change24h) + '</button>';
  }).join('') : '<div class="mv-empty">' + (mine.length ? 'None of your coins is ' + (up ? 'up' : 'down') + ' over 24 h.' : 'No 24 h changes yet.') + '</div>';
}
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('#movers-card .mv-seg button'); if (!b) return;
  rxMvSide = b.getAttribute('data-mv') === 'down' ? 'down' : 'up';
  try { localStorage.setItem('rx_movers', rxMvSide); } catch (e2) {}
  rxMoversRender(rxCoinsData);
});
// #524 add a coin to the buy list by its ticker (POST /api/coins/buylist, the #521 route)
var rxBlMsg = '';   // kept across the list refresh, cleared after 6 s
function rxBuyAdd(f) {
  var inp = f.querySelector('input'), msg = f.querySelector('.bl-msg'), btn = f.querySelector('button');
  var c = String(inp.value || '').toUpperCase().replace(/[-\/]?USDT?$/, '').replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{1,15}$/.test(c)) { msg.textContent = 'Type a ticker, e.g. VVV'; return false; }
  btn.disabled = true; msg.textContent = 'Adding ' + c + '\u2026';
  fetch('/api/coins/buylist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coin: c, on: true }), cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('the server answered ' + r.status)); return j; }); })
    .then(function () { inp.value = ''; rxBlMsg = c + ' added to the buy list'; msg.textContent = rxBlMsg; setTimeout(function () { rxBlMsg = ''; }, 6000); rxCoinsBusy = false; loadCoins(); })
    .catch(function (e) { msg.textContent = 'Not added: ' + e.message; })
    .then(function () { btn.disabled = false; });
  return false;
}
function loadCoins() {
  if (rxCoinsBusy) return; rxCoinsBusy = true;
  fetchData('/api/coins').then(function (d) {
    rxCoinsBusy = false;
    if (!d || d.error) { if (!rxCoinsData) { var el = $('holdings-list'); if (el) el.innerHTML = '<div class="empty-state">' + esc((d && d.error) || 'Coins unavailable') + '</div>'; } return; }
    rxCoinsData = d; rxCoinsRender(d); rxMoversRender(d);   // #518
  }, function () { rxCoinsBusy = false; });
}

// #505 (Bryan 29 Sep 00:10: coin cards "actually readable. That's tiny"): a plan reads as paragraphs, a leading label in
// capitals ("EXITED 16 Aug:", "ACTION:") in bold, and a long plan (over 900 characters) shows its opening with the rest one
// tap away. The text itself is unchanged and always escaped.
function rxPlanLine(line) {
  var m = /^([^:\n]{3,70}):(\s|$)/.exec(line);
  if (m) {
    var letters = m[1].replace(/[^A-Za-z]/g, ''), up = m[1].replace(/[^A-Z]/g, '');
    if (letters.length >= 3 && up.length / letters.length >= 0.6) return '<b class="cd-lbl">' + esc(m[1]) + ':</b>' + esc(line.slice(m[1].length + 1));
  }
  return esc(line);
}
function rxPlanHtml(md, sym) {
  var paras = String(md || '').replace(/\r/g, '').split(/\n[ \t]*\n/).map(function (p) { return p.replace(/^\s+|\s+$/g, ''); }).filter(Boolean);
  var id = String(sym || '').replace(/[^A-Za-z0-9_]/g, ''), cut = paras.length, shown = 0;
  if (paras.join('').length > 900 && paras.length > 1) { cut = 0; while (cut < paras.length && (cut === 0 || shown < 450)) { shown += paras[cut].length; cut++; } }
  var P = function (p) { return '<div class="cd-p">' + p.split('\n').map(rxPlanLine).join('\n') + '</div>'; };
  var h = paras.slice(0, cut).map(P).join('');
  if (cut < paras.length) {
    var n = paras.length - cut;
    h += '<div class="cd-more" id="cd-more-' + id + '" hidden>' + paras.slice(cut).map(P).join('') + '</div>'
      + '<button type="button" class="cd-morebtn" data-more="Read the full plan (' + n + ' more) \u25BE" onclick="rxPlanMore(\'' + id + '\', this)">Read the full plan (' + n + ' more) \u25BE</button>';
  }
  return h;
}
function rxPlanMore(id, b) {
  var m = $('cd-more-' + id); if (!m) return;
  m.hidden = !m.hidden; b.textContent = m.hidden ? b.getAttribute('data-more') : 'Show less \u25B4';
}

function toggleDeadbags() {
  var el = $('deadbags-list');
  if (el) el.style.display = (el.style.display === 'none') ? 'block' : 'none';
}

function toggleCard(sym) {
  var el = $('card-detail-' + sym);
  if (!el) return;
  if (el.style.display === 'none' || !el.style.display) {
    el.style.display = 'block';
    if (!el.getAttribute('data-loaded')) { el.setAttribute('data-loaded', '1'); loadCardDetail(sym, el); }
  } else {
    el.style.display = 'none';
  }
}

function loadCardDetail(sym, el) {
  var cs = csMap[sym];
  var h = '';
  if (cs) {
    h += '<div class="cd-meta" style="font-size:10px;color:#9aa0aa;margin:8px 0 6px">'
      + (cs.status ? 'STATUS: ' + esc(cs.status) + '  ' : '')
      + (cs.role ? '\u00B7 ROLE: ' + esc(cs.role) + '  ' : '')
      + (cs.theme ? '\u00B7 THEME: ' + esc(cs.theme) : '') + '</div>';
  } else {
    h += '<div class="cd-meta" style="font-size:10px;color:#888;margin:8px 0 6px">No saved plan \u2014 dead-bag / untracked holding</div>';
  }
  h += '<div class="cd-pl" id="cd-lifetime-' + sym + '" style="font-size:10px;color:#888;margin-bottom:6px">Loading P&L...</div>';
  if (cs && cs.strategy_md) {
    h += '<div class="cd-plan" style="white-space:pre-wrap;font-size:11px;color:#bbb;line-height:1.45;background:#141414;padding:8px;border-radius:4px;margin-bottom:8px">' + rxPlanHtml(cs.strategy_md, sym) + '</div>';   // #505
  }
  if (sym === 'XRP') { h += '<div id="cd-xrp-loc-XRP" style="font-size:11px;color:#888;margin-bottom:8px">Loading XRP locations...</div>'; }
  h += '<div class="cd-lots" id="cd-tranches-' + sym + '" style="font-size:11px;color:#888;margin-bottom:8px">Loading lots\u2026</div>';
  h += '<div class="cd-journal" id="cd-journal-' + sym + '" style="font-size:11px;color:#888">Loading journal\u2026</div>';
  el.innerHTML = h;

  (function(s) {
    function renderLifetimePnl(ld) {
      var c = $('cd-lifetime-' + s);
      if (!c) return;
      var assets = (ld && ld.assets) || [];
      var a = null;
      for (var i = 0; i < assets.length; i++) { if ((assets[i].symbol || '').toUpperCase() === s) { a = assets[i]; break; } }
      if (!a) { c.innerHTML = '<span style="color:#666">No P&L history yet</span>'; return; }
      function money(v) { if (v == null) return '\u2014'; return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2); }
      function col(v) { if (v == null) return '#888'; return v < 0 ? '#ff5555' : (v > 0 ? '#33cc66' : '#888'); }
      var warn = a.sells_missing_realized ? ' <span style="color:#ff8800">\u26a0 ' + a.sells_missing_realized + ' sells pre-#8</span>' : '';
      c.innerHTML = '<div style="display:flex;gap:10px;flex-wrap:wrap">'
        + '<span>Lifetime <b style="color:' + col(a.lifetime_total_usd) + '">' + money(a.lifetime_total_usd) + '</b></span>'
        + '<span style="color:#777">Real <span style="color:' + col(a.realized_pnl_usd) + '">' + money(a.realized_pnl_usd) + '</span></span>'
        + '<span style="color:#777">Unreal <span style="color:' + col(a.unrealized_pnl_usd) + '">' + money(a.unrealized_pnl_usd) + '</span></span>'
        + warn + '</div>';
    }
    if (ledgerCache) { renderLifetimePnl(ledgerCache); }
    else { fetchData('/api/ledger').then(function(d) { ledgerCache = d; renderLifetimePnl(d); }); }
  })(sym);

  if (sym === 'XRP') {
    fetchData('/api/xrp-locations').then(function(d) {
      var c = $('cd-xrp-loc-XRP');
      if (!c) return;
      if (!d || d.error) { c.innerHTML = '<span style="color:#666">Location data unavailable</span>'; return; }
      function fmtP(v) { return (v == null) ? '\u2014' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
      function money(v) { return (v == null) ? '\u2014' : (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2); }
      function col(v) { return (!v && v !== 0) ? '#888' : v < 0 ? '#ff5555' : v > 0 ? '#33cc66' : '#888'; }
      var rv = d.revolut || {}, tg = d.tangem || {}, cm = d.combined || {};
      var html = '<div style="color:#666;font-weight:bold;margin-bottom:4px">XRP LOCATIONS</div>';
      if (rv.qty >= 0.01) {
        html += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #222">'
          + '<span>\uD83D\uDD04 Revolut X ' + fmtQty(rv.qty, 2) + ' @ ' + (rv.entry ? fmtPrice(rv.entry) : '\u2014') + '</span>'
          + '<span style="color:' + col(rv.plUsd) + '">' + money(rv.plUsd) + ' (' + fmtP(rv.plPct) + ')</span></div>';
      }
      if (tg.qty >= 0.01) {
        html += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #222">'
          + '<span>\uD83D\uDD12 Tangem ' + fmtQty(tg.qty, 2) + ' @ ' + (tg.entry ? fmtPrice(tg.entry) : '\u2014') + '</span>'
          + '<span style="color:' + col(tg.plUsd) + '">' + money(tg.plUsd) + ' (' + fmtP(tg.plPct) + ')</span></div>';
      }
      if (cm.qty >= 0.01) {
        html += '<div style="display:flex;justify-content:space-between;padding:3px 0;margin-top:2px">'
          + '<b>Combined ' + fmtQty(cm.qty, 2) + ' @ ' + (cm.entry ? fmtPrice(cm.entry) : '\u2014') + '</b>'
          + '<b style="color:' + col(cm.plUsd) + '">' + money(cm.plUsd) + ' (' + fmtP(cm.plPct) + ')</b></div>';
      }
      c.innerHTML = html;
    });
  }

  fetchData('/api/tranches/' + encodeURIComponent(sym)).then(function(t) {
    var c = $('cd-tranches-' + sym);
    if (!c) return;
    var rows = (t && t.tranches) || [];
    if (!rows.length) { c.innerHTML = '<span style="color:#666">No tracked lots</span>'; return; }
    var s = '<div style="color:#666;font-weight:bold;margin-bottom:3px">LOTS</div>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      s += '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #222">'
        + '<span>' + fmtQty(r.remaining_quantity) + ' @ ' + fmtPrice(r.entry_price) + (parseInt(r.is_legacy) ? ' <span style="color:#a70">\u00B7legacy</span>' : '') + '</span>'
        + '<span style="color:#777">$' + parseFloat(r.cost_basis || 0).toFixed(2) + '</span></div>';
    }
    c.innerHTML = s;
  });

  fetchData('/api/activity?limit=100&filter=all').then(function(j) {
    var c = $('cd-journal-' + sym);
    if (!c) return;
    var all = (j && j.trades) || [];
    var rows = [];
    for (var i = 0; i < all.length && rows.length < 6; i++) { if (all[i].symbol === sym) rows.push(all[i]); }
    if (!rows.length) { c.innerHTML = '<span style="color:#666">No recent journal entries</span>'; return; }
    var s = '<div style="color:#666;font-weight:bold;margin:6px 0 3px">RECENT JOURNAL</div>';
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      var col = r.action === 'buy' ? '#00ff88' : (r.action === 'sell' ? '#ff4444' : '#888');
      var dt = new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      s += '<div style="padding:2px 0;border-bottom:1px solid #222">'
        + '<span style="color:' + col + '">' + (r.action || '').toUpperCase() + '</span> '
        + fmtQty(r.quantity) + ' @ ' + fmtPrice(r.price) + ' <span style="color:#555">' + dt + '</span>'
        + (r.reasoning ? '<br><span style="color:#777">' + esc(r.reasoning).slice(0, 90) + '</span>' : '') + '</div>';
    }
    c.innerHTML = s;
  });
}

// ── USDT Sweep ────────────────────────────────────────────────────

function loadSweep() {
  fetchData('/api/sweep/config').then(function(data) {
    if (!data) return;
    hideEl('sweep-loading'); showEl('sweep-content');
    var tog = $('sweep-enabled-toggle'), pct = $('sweep-pct-input');
    var min = $('sweep-min-input'), bal = $('sweep-usdt-balance'), lbl = $('sweep-status-label');
    if (tog) tog.checked = data.enabled !== false;
    if (pct) pct.value = data.sweep_pct || 25;
    if (min) min.value = data.min_trade_value_usd || 10;
    if (bal) bal.textContent = '$' + parseFloat(data.usdt_reserve || 0).toFixed(2);
    if (lbl) lbl.textContent = (data.enabled !== false) ? 'ON' : 'OFF';
  });
}

function loadThresholds() {
  fetchData('/api/thresholds').then(function(data) {
    if (!data) return;
    var el = document.getElementById('threshold-list');
    if (!el) return;
    var custom = data.customThresholds || {};
    var def = parseFloat(data.defaultThreshold || 0.12);
    var keys = Object.keys(custom);
    if (!keys.length) {
      el.innerHTML = '<div class="empty-state">Default: ' + (def * 100).toFixed(0) + '% for all coins</div>';
      return;
    }
    var html = '<div style="color:#666;font-size:11px;margin-bottom:8px">Default: ' + (def * 100).toFixed(0) + '%</div>';
    keys.forEach(function(sym) {
      var pct = (parseFloat(custom[sym]) * 100).toFixed(1);
      html += '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #222">'
        + '<span style="color:#aaa">' + sym.replace('-USD','') + '</span>'
        + '<span style="color:white">' + pct + '%</span></div>';
    });
    el.innerHTML = html;
  });
}

function saveSweepConfig() {
  var tog = $('sweep-enabled-toggle'), pct = $('sweep-pct-input'), min = $('sweep-min-input');
  fetch('/api/sweep/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: tog ? tog.checked : true, sweep_pct: parseFloat((pct && pct.value) || 25), min_trade_value_usd: parseFloat((min && min.value) || 10) })
  }).then(function(r) { if (r.ok) { showToast('Sweep config saved'); loadSweep(); } else showToast('Failed to save', true); });
}

// ── Monitoring ────────────────────────────────────────────────────

var monitorPaused = false;

function loadMonitorStatus() {
  fetchData('/api/status').then(function(data) {
    if (!data) return;
    monitorPaused = data.paused || false;
    var text = $('monitor-status-text'), btn = $('pause-resume-btn');
    if (text) text.textContent = monitorPaused ? 'Paused' : 'Running';
    if (btn) btn.textContent = monitorPaused ? 'Resume' : 'Pause';
  });
}

function toggleMonitoring() {
  var action = monitorPaused ? 'resume' : 'pause';
  fetch('/api/' + action, { method: 'POST' }).then(function() {
    loadMonitorStatus(); showToast('Monitoring ' + action + 'd');
  }).catch(function() { showToast('Failed to toggle monitor', true); });
}

// ── Alerts ────────────────────────────────────────────────────────

function loadAlerts() {
  fetchData('/api/status').then(function(data) {
    var el = $('alerts-list');
    if (!el) return;
    var alerts = (data && data.activeAlerts) || [];
    if (!alerts.length) { el.innerHTML = '<div class="empty-state">None</div>'; return; }
    var html = '';
    function fp(v) { if (v == null) return ''; v = +v; return '$' + (v < 1 ? v.toFixed(6) : v.toFixed(4)); }
    alerts.forEach(function(a) {
      var sym = (a.symbol || '?').replace('-USD', '');
      var isTrail = a.type === 'trailing';
      var arrow = isTrail ? '\u25C6' : (a.direction === 'down' ? '\u25BC' : '\u25B2');
      var color = isTrail ? '#ff8800' : (a.direction === 'down' ? '#ff5555' : '#33cc66');
      var detail = isTrail
        ? ('trail' + (a.trail_pct != null ? ' ' + a.trail_pct + '%' : '') + (a.stop != null ? ' \u2192 ' + fp(a.stop) : ''))
        : fp(a.target);
      if (a.firing) detail += ' \u26A1';
      html += '<div class="alert-row"><span class="alert-symbol">'
        + '<span style="color:' + color + '">' + arrow + '</span> ' + sym + '</span>'
        + '<span style="color:#888;font-size:0.8rem">' + detail + '</span></div>';
    });
    el.innerHTML = html;
  });
}

// ── Kraken ────────────────────────────────────────────────────────

function loadKraken() {
  fetchData('/api/kraken/balances').then(function(data) {
    if (!data) return;
    var total = parseFloat(data.totalUSD || data.total_usd || 0);
    setText('kraken-total', fmtUSD(total));
    setText('kraken-status', total > 0 ? 'Connected' : 'No data');
    var el = $('kraken-holdings');
    if (!el) return;
    var bals = (data.balances || []).filter(function(b) { return parseFloat(b.valueUSD || 0) >= 1; });
    bals.sort(function(a, b) { return parseFloat(b.valueUSD || 0) - parseFloat(a.valueUSD || 0); });
    if (!bals.length) { el.innerHTML = '<div class="empty-state">No Kraken holdings</div>'; return; }
    var html = '';
    bals.forEach(function(b) {
      var val = parseFloat(b.valueUSD || 0), ep = parseFloat(b.entryPrice || 0), cp = parseFloat(b.price || 0);
      var pl = ep > 0 ? ((cp - ep) / ep * 100) : 0, plc = pl >= 0 ? '#00ff88' : '#ff4444';
      html += '<div style="border-left:3px solid ' + plc + ';padding:10px 12px;margin-bottom:8px;background:#1a1a1a;border-radius:4px">'
        + '<div style="display:flex;justify-content:space-between"><span style="color:white;font-weight:bold">' + (b.standard || b.asset) + '</span>'
        + '<span style="color:white">$' + val.toFixed(2) + '</span></div>'
        + (ep > 0 ? '<div style="color:#888;font-size:11px">Entry: ' + fmtPrice(ep) + ' | Now: ' + fmtPrice(cp) + ' | <span style="color:' + plc + '">' + fmtPct(pl) + '</span></div>' : '')
        + '</div>';
    });
    el.innerHTML = html;
  });
}

// ── Activity ──────────────────────────────────────────────────────

var currentFilter = 'all';

function filterActivity(filter, event) {
  currentFilter = filter || 'all';
  document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
  if (event && event.target) event.target.classList.add('active');
  loadActivity(currentFilter);
}

function loadActivity(filter) {
  filter = filter || currentFilter || 'all';
  var el = $('activity-feed');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Loading...</div>';
  fetchData('/api/activity?limit=50&filter=' + encodeURIComponent(filter)).then(function(data) {
    if (!data || !data.trades || !data.trades.length) { el.innerHTML = '<div class="empty-state">No activity yet</div>'; return; }
    var colors = { buy:'#00ff88', sell:'#ff4444', payment:'#ffaa00', transfer:'#888888', sweep:'#4488ff', rebalance:'#aa44ff' };
    var html = '';
    data.trades.forEach(function(t) {
      var color = colors[t.action] || '#888';
      var ds = new Date(t.created_at).toLocaleDateString('en-GB', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'});
      var qty = parseFloat(t.quantity || 0);
      var qs = qty >= 1000000 ? (qty/1000000).toFixed(2)+'M' : qty >= 1000 ? (qty/1000).toFixed(2)+'K' : qty.toFixed(4);
      var val = t.value_usd ? '$' + parseFloat(t.value_usd).toFixed(2) : '';
      var pnl = t.outcome_pnl ? parseFloat(t.outcome_pnl) : null;
      var pnlStr = pnl !== null ? '<span class="pnl-badge" style="color:' + (pnl>=0?'#00ff88':'#ff4444') + '">' + (pnl>=0?'+':'') + '$' + Math.abs(pnl).toFixed(2) + '</span>' : '';
      html += '<div class="activity-item" style="border-left-color:' + color + '">'
        + '<div class="activity-header"><div><span class="activity-action" style="color:' + color + '">' + t.action.toUpperCase() + '</span>'
        + '<span class="activity-symbol">' + t.symbol + '</span>' + pnlStr + '</div>'
        + '<span class="activity-time">' + ds + '</span></div>'
        + '<div class="activity-details">' + qs + ' @ ' + fmtPrice(t.price) + (val ? ' = ' + val : '') + '</div>'
        + '<div class="activity-reason"><span class="activity-reason-text">' + (t.reasoning || 'No reason logged') + '</span></div></div>';
    });
    el.innerHTML = html;
  });
}

// ── Journal ───────────────────────────────────────────────────────

function loadJournalEntries() {
  fetchData('/api/activity?limit=20&filter=all').then(function(data) {
    var el = $('journal-entries-list');
    if (!el) return;
    if (!data || !data.trades) { el.innerHTML = '<div class="empty-state">No entries</div>'; return; }
    var trades = data.trades.filter(function(t) { return t.action === 'buy' || t.action === 'sell'; });
    if (!trades.length) { el.innerHTML = '<div class="empty-state">No trades yet</div>'; return; }
    var html = '';
    trades.forEach(function(t) {
      var color = t.action === 'buy' ? '#00ff88' : '#ff4444';
      var date = new Date(t.created_at).toLocaleDateString('en-GB');
      html += '<div class="journal-entry"><div class="je-header">'
        + '<span class="je-action ' + t.action + '">' + t.action.toUpperCase() + '</span>'
        + '<span class="je-coin">' + t.symbol + '</span>'
        + '<span class="je-price">' + fmtPrice(t.price) + '</span>'
        + '<span class="je-emotion">' + (t.emotion || 'neutral') + '</span></div>'
        + '<div style="font-size:0.82rem;color:#888">' + (t.reasoning || '') + '</div></div>';
    });
    el.innerHTML = html;
  });
}

function loadJournalStats() {
  fetchData('/api/journal/stats').then(function(data) {
    if (!data) return;
    setText('j-win-rate', data.win_rate != null ? data.win_rate.toFixed(1) + '%' : '—');
    setText('j-total-trades', data.total_trades || '—');
    setText('j-avg-profit', data.avg_profit != null ? fmtPct(data.avg_profit) : '—');
    setText('j-claude-acc', data.claude_accuracy != null ? data.claude_accuracy.toFixed(1) + '%' : '—');
  });
}

// ── Profile ───────────────────────────────────────────────────────

function loadProfile() {
  fetchData('/api/profile').then(function(data) {
    var el = $('profile-list');
    if (!el) return;
    var prefs = (data && (data.preferences || data)) || [];
    if (!prefs.length) { el.innerHTML = '<div class="empty-state">No preferences saved yet.</div>'; return; }
    var html = '';
    prefs.forEach(function(p) {
      html += '<div class="profile-item"><span>' + (p.key || p.preference_key || '') + '</span>'
        + '<span style="color:#888;font-size:0.8rem;max-width:60%;text-align:right">' + (p.value || p.preference_value || '') + '</span></div>';
    });
    el.innerHTML = html;
    if (data && data.learning_model) setText('learning-text', data.learning_model);
  });
}

// ── Trailing stops ────────────────────────────────────────────────

function loadTrailingStops() {
  fetchData('/api/trailing-stops').then(function(data) {
    if (!data) return;
    var stops = data.stops || data || [];
    var summaryEl = $('trail-summary'), listEl = $('trail-summary-list');
    if (!stops.length || !Array.isArray(stops)) return;
    if (summaryEl) summaryEl.style.display = '';
    if (!listEl) return;
    var html = '';
    stops.forEach(function(s) {
      html += '<div class="trail-summary-row">'
        + '<span class="trail-summary-coin">' + (s.symbol || s.coin) + '</span>'
        + '<span class="trail-summary-detail">' + (s.trail_pct || s.trailPct || '—') + '% trail</span>'
        + '<span class="trail-summary-stop">Stop: ' + fmtPrice(s.stop_price || s.stopPrice) + '</span>'
        + '</div>';
    });
    listEl.innerHTML = html;
  });
}

// ── Full refresh ──────────────────────────────────────────────────

function loadLedger() {
  fetchData('/api/ledger').then(function(data) {
    var sumEl = $('ledger-summary');
    var el = $('ledger-list');
    if (!el) return;
    if (!data || data.error) { el.innerHTML = '<div class="empty-state">' + ((data && data.error) || 'Unavailable') + '</div>'; return; }
    ledgerCache = data;
    var assets = data.assets || [];
    function money(v) { if (v == null) return '—'; var s = v < 0 ? '-' : (v > 0 ? '+' : ''); return s + '$' + Math.abs(v).toFixed(2); }
    function col(v) { if (v == null) return '#888'; return v < 0 ? '#ff5555' : (v > 0 ? '#33cc66' : '#888'); }
    if (sumEl) {
      sumEl.innerHTML =
        'Realized <b style="color:' + col(data.portfolio_realized_pnl_usd) + '">' + money(data.portfolio_realized_pnl_usd) + '</b> · '
        + 'Unrealized <b style="color:' + col(data.portfolio_unrealized_pnl_usd) + '">' + money(data.portfolio_unrealized_pnl_usd) + '</b> · '
        + 'Lifetime <b style="color:' + col(data.portfolio_lifetime_total_usd) + '">' + money(data.portfolio_lifetime_total_usd) + '</b>'
        + ((data.data_quality && data.data_quality.sells_missing_realized_total) ? '<div style="color:#ff8800;margin-top:4px">⚠ ' + data.data_quality.sells_missing_realized_total + ' historical sells pre-date P&L tracking — realized is partial</div>' : '');
    }
    if (!assets.length) { el.innerHTML = '<div class="empty-state">None</div>'; return; }
    var html = '';
    assets.forEach(function(a) {
      var mv = a.market_value_usd != null ? '$' + a.market_value_usd.toFixed(2) : '—';
      var heldBadge = a.held ? '<span style="color:#33cc66">●</span> ' : '<span style="color:#555">○</span> ';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:rgba(255,255,255,0.03);border-radius:6px">'
        + '<span style="font-weight:600">' + heldBadge + (a.symbol || '?') + '</span>'
        + '<span style="font-size:0.76rem;color:#888;text-align:right">'
        +   'val ' + mv
        +   ' · u/r <span style="color:' + col(a.unrealized_pnl_usd) + '">' + money(a.unrealized_pnl_usd) + '</span>'
        +   ' · real <span style="color:' + col(a.realized_pnl_usd) + '">' + money(a.realized_pnl_usd) + '</span>'
        +   ' · life <b style="color:' + col(a.lifetime_total_usd) + '">' + money(a.lifetime_total_usd) + '</b>'
        + '</span></div>';
    });
    el.innerHTML = html;
  });
}

function toggleScorecard(idx) {
  var el = $('sc-detail-' + idx);
  if (el) el.style.display = (el.style.display === 'none' || !el.style.display) ? 'block' : 'none';
}

function loadScorecards() {
  var el = $('scorecards-list');
  if (!el) return;
  fetchData('/api/scorecards').then(function(data) {
    if (!data || data.error) { el.innerHTML = '<div class="empty-state">' + ((data && data.error) || 'Unavailable') + '</div>'; return; }
    var scs = data.scorecards || [];
    if (!scs.length) { el.innerHTML = '<div class="empty-state">No scorecards saved. Ask PM to save scorecard_data preference.</div>'; return; }
    function money(v) { if (v == null) return '\u2014'; return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2); }
    function col(v) { return (!v && v !== 0) ? '#888' : v < 0 ? '#ff5555' : v > 0 ? '#33cc66' : '#888'; }
    function fmtPt(v) { return (v == null) ? '\u2014' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
    var html = '';
    scs.forEach(function(sc, idx) {
      var lv = sc.live || {};
      var delta = lv.delta_vs_baseline_usd;
      var dStr = delta != null ? ' <span style="color:' + col(delta) + ';font-size:0.75rem">(' + money(delta) + ' vs baseline)</span>' : '';
      var exits = lv.exits || sc.exits || [];
      var exitRows = '';
      exits.forEach(function(e) {
        exitRows += '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #222">'
          + '<span style="color:#bbb">' + esc(e.coin) + ' ' + fmtQty(e.qty, 2) + ' @ ' + fmtPrice(e.sale_price) + '</span>'
          + '<span style="color:' + col(e.loss_saved_usd) + '">' + money(e.loss_saved_usd) + '</span></div>';
      });
      var detail = '<div style="font-size:0.79rem;color:#666;font-weight:700;margin-bottom:4px">EXITS (vs holding today)</div>'
        + exitRows
        + '<div style="display:flex;justify-content:space-between;padding:3px 0;margin-top:3px">'
        + '<span style="color:#888">Detour losses (realized)</span>'
        + '<span style="color:' + col(sc.detour_losses_usd) + '">' + money(sc.detour_losses_usd) + '</span></div>';
      if (sc.baseline) {
        detail += '<div style="margin-top:8px;font-size:0.75rem;color:#666;font-weight:700">BASELINE (' + esc(sc.baseline_date || '') + ')</div>'
          + '<div style="font-size:0.75rem;color:#888">Loss saved ' + money(sc.baseline.loss_saved_usd)
          + ' | Net ' + money(sc.baseline.net_usd)
          + (sc.anchor ? ' | ' + esc(sc.anchor.coin) + ' ' + money(sc.baseline.anchor_unrealized_usd) + ' (+' + sc.baseline.anchor_unrealized_pct.toFixed(2) + '%)' : '') + '</div>';
      }
      if (sc.caveats) { detail += '<div style="margin-top:6px;font-size:0.73rem;color:#555;font-style:italic">' + esc(sc.caveats) + '</div>'; }
      html += '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:12px">'
        + '<div onclick="toggleScorecard(' + idx + ')" style="cursor:pointer">'
        + '<div style="font-weight:700;font-size:0.95rem;margin-bottom:3px">' + esc(sc.name || sc.key) + ' <span style="color:#555;font-size:0.75rem">' + esc(sc.baseline_date || '') + '</span></div>'
        + '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:0.82rem">'
        + '<span>Loss saved <b style="color:' + col(lv.loss_saved_usd) + '">' + money(lv.loss_saved_usd) + '</b>' + dStr + '</span>'
        + '<span>Net <b style="color:' + col(lv.net_usd) + '">' + money(lv.net_usd) + '</b></span>'
        + (sc.anchor ? '<span>' + esc(sc.anchor.coin) + ' anchor <b style="color:' + col(lv.anchor_unrealized_usd) + '">' + money(lv.anchor_unrealized_usd) + '</b> (' + fmtPt(lv.anchor_unrealized_pct) + ')</span>' : '')
        + '</div></div>'
        + '<div id="sc-detail-' + idx + '" style="display:none;margin-top:10px;border-top:1px solid #2a2a2a;padding-top:10px;font-size:0.8rem">' + detail + '</div>'
        + '</div>';
    });
    el.innerHTML = html;
  });
}

function loadConcentration() {
  var el = $('concentration-content');
  if (!el) return;
  fetchData('/api/concentration').then(function(data) {
    if (!data || data.error) { el.innerHTML = '<div class="empty-state">' + ((data && data.error) || 'Unavailable') + '</div>'; return; }
    function col(pct) { return pct >= 40 ? '#ff5555' : pct >= 25 ? '#ffaa00' : '#33cc66'; }
    function money(v) { return '$' + (v || 0).toFixed(0); }
    var html = '<div style="margin-bottom:12px">';
    html += '<div style="font-size:0.75rem;color:#666;font-weight:700;margin-bottom:6px">BY THEME</div>';
    (data.by_theme || []).forEach(function(t) {
      var c = col(t.pct);
      html += '<div style="margin-bottom:8px">'
        + '<div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-bottom:2px">'
        + '<span style="color:#ccc">' + esc(t.theme) + '</span>'
        + '<span style="color:' + c + ';font-weight:700">' + t.pct + '% ' + money(t.value) + '</span></div>'
        + '<div style="background:#1a1a1a;border-radius:4px;height:5px">'
        + '<div style="background:' + c + ';width:' + Math.min(t.pct,100) + '%;height:5px;border-radius:4px"></div></div></div>';
    });
    html += '</div><div><div style="font-size:0.75rem;color:#666;font-weight:700;margin-bottom:6px">BY ROLE</div>';
    (data.by_role || []).forEach(function(r) {
      var c = col(r.pct);
      html += '<div style="display:flex;justify-content:space-between;font-size:0.82rem;padding:3px 0;border-bottom:1px solid #1a1a1a">'
        + '<span style="color:#bbb">' + esc(r.role) + '</span>'
        + '<span style="color:' + c + ';font-weight:700">' + r.pct + '% ' + money(r.value) + '</span></div>';
    });
    html += '</div><div style="margin-top:10px;font-size:0.75rem;color:#555">Revolut total: ' + money(data.total) + '</div>';
    el.innerHTML = html;
  });
}

function loadRotations() {
  var el = $('rotations-content'); if (!el) return;
  fetchData('/api/rotations').then(function(data) {
    if (!data || data.error) { el.innerHTML = '<div class="empty-state">' + ((data && data.error) || 'Unavailable') + '</div>'; return; }
    var rots = data.rotations || [];
    if (!rots.length) { el.innerHTML = '<div class="empty-state">No rotations yet. Use resolve_pending_trades type:rebalance.</div>'; return; }
    function money(v) { return v == null ? '\u2014' : (v >= 0 ? '+' : '\u2212') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); }   // #496
    function col(v) { return v > 0 ? '#33cc66' : '#ff5555'; }
    el.innerHTML = rots.map(function(r) {
      var dA = r.delta_vs_a, dU = r.delta_vs_usdt;
      var bdr = dA > 0 && dU > 0 ? '#33cc66' : dA != null && (dA > 0 || dU > 0) ? '#ffaa00' : '#ff5555';
      return '<div style="border-left:3px solid '+bdr+';padding:8px 10px;margin-bottom:6px;background:rgba(255,255,255,0.03);border-radius:0 6px 6px 0">'
        +'<div style="font-size:0.88rem;font-weight:700;margin-bottom:3px">'+esc(r.out_symbol)+' \u2192 '+esc(r.in_symbol)
        +' <span style="color:#555;font-weight:400;font-size:0.78rem">$'+(r.proceeds_usd||0).toFixed(0)+' | '+(r.days_since||0)+'d ago</span></div>'
        +'<div style="display:flex;gap:12px;font-size:0.8rem;flex-wrap:wrap">'
        +(r.actual_usd!=null?'<span>Now <b>$'+r.actual_usd.toFixed(0)+'</b></span>':'')
        +(dA!=null?'<span style="color:'+col(dA)+'">'+money(dA)+' vs holding</span>':'')
        +(dU!=null?'<span style="color:'+col(dU)+'">'+money(dU)+' vs USDT</span>':'')
        +(r.outcome?'<span style="color:#555;font-size:0.75rem">'+esc(r.outcome)+'</span>':'')
        +'</div></div>';
    }).join('');
  });
}

// #507 the live line under the total. Every minute (while the page is visible) it re-reads /api/portfolio/spark and
// redraws. The points are resampled to a fixed count, so the browser can slide the old line into the new one.
var RX_SPARK = { ranges: ['1h', '6h', '1d'], label: { '1h': '1 hour', '6h': '6 hours', '1d': '24 hours' }, n: 90, h: 56 };
var rxSparkRange = (function () { try { var r = localStorage.getItem('rx_spark_range'); return RX_SPARK.label[r] ? r : '6h'; } catch (e) { return '6h'; } })();
var rxSparkData = null, rxSparkBusy = false;
function rxSparkLoad() {
  var box = $('rx-spark'); if (!box || rxSparkBusy || document.hidden) return;
  rxSparkBusy = true;
  fetch('/api/portfolio/spark?range=' + rxSparkRange, { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.points && d.points.length >= 2) { rxSparkData = d; rxSparkDraw(); } })
    .catch(function () { /* quiet: the next minute tries again */ })
    .then(function () { rxSparkBusy = false; });
}
function rxSparkDraw() {
  var box = $('rx-spark'), d = rxSparkData; if (!box || !d) return;
  box.hidden = false;
  var svg = box.querySelector('svg'), w = Math.max(120, svg.clientWidth || box.clientWidth || 300), h = RX_SPARK.h, pad = 5;
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  var pts = d.points, t0 = pts[0][0], t1 = pts[pts.length - 1][0], n = RX_SPARK.n, ys = [];
  for (var i = 0; i < n; i++) {   // the value at n evenly spaced times (straight line between recorded points)
    var t = t0 + (t1 - t0) * i / (n - 1), j = 0;
    while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
    var a = pts[j], b = pts[j + 1], f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    ys.push(a[1] + (b[1] - a[1]) * f);
  }
  var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), span = hi - lo || Math.max(1, hi * 0.001);
  var X = function (i) { return (w * i / (n - 1)).toFixed(1); }, Y = function (v) { return (pad + (h - 2 * pad) * (1 - (v - lo) / span)).toFixed(1); };
  var line = 'M' + ys.map(function (v, i) { return X(i) + ' ' + Y(v); }).join(' L');
  var area = line + ' L' + X(n - 1) + ' ' + h + ' L0 ' + h + ' Z';
  var lp = svg.querySelector('.rx-spark-line'), ap = svg.querySelector('.rx-spark-area');
  lp.style.d = 'path("' + line + '")'; ap.style.d = 'path("' + area + '")';
  if (!lp.style.d) { lp.setAttribute('d', line); ap.setAttribute('d', area); }   // browsers without CSS d: draw without the slide
  var dot = box.querySelector('.rx-spark-dot'); dot.style.left = X(n - 1) + 'px'; dot.style.top = Y(ys[n - 1]) + 'px';
  var up = !(d.change < 0);
  box.classList.toggle('down', !up);
  box.querySelector('.rx-spark-range').textContent = RX_SPARK.label[rxSparkRange];
  box.querySelector('.rx-spark-chg').textContent = d.change == null ? '' : (up ? '+' : '\u2212') + fmtUSD(Math.abs(d.change)) + (d.pct == null ? '' : ' (' + (up ? '+' : '\u2212') + Math.abs(d.pct).toFixed(2) + '%)');
  box.setAttribute('aria-label', 'Portfolio value, last ' + RX_SPARK.label[rxSparkRange] + ': ' + box.querySelector('.rx-spark-chg').textContent + '. Tap to change the time span.');
}
function rxSparkNext() {
  rxSparkRange = RX_SPARK.ranges[(RX_SPARK.ranges.indexOf(rxSparkRange) + 1) % RX_SPARK.ranges.length];
  try { localStorage.setItem('rx_spark_range', rxSparkRange); } catch (e) {}
  rxSparkLoad();
}
document.addEventListener('DOMContentLoaded', function () {
  var box = $('rx-spark'); if (!box) return;
  box.addEventListener('click', rxSparkNext);
  box.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rxSparkNext(); } });
  rxSparkLoad();
  setInterval(rxSparkLoad, 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) rxSparkLoad(); });
  var rt = null; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(rxSparkDraw, 150); });
});

function refreshAll() {
  var spinner = $('spinner');
  if (spinner) spinner.classList.add('active');
  try { loadPortfolio(); } catch(e){ console.error('loadPortfolio FAILED', e); }
  try { loadSweep(); } catch(e){ console.error('loadSweep FAILED', e); }
  try { loadMonitorStatus(); } catch(e){ console.error('loadMonitorStatus FAILED', e); }
  try { loadScorecards(); } catch(e){ console.error('loadScorecards FAILED', e); }
  try { loadConcentration(); } catch(e){ console.error('loadConcentration FAILED', e); }
  try { loadRotations(); } catch(e){ console.error('loadRotations FAILED', e); }
  if (spinner) setTimeout(function() { spinner.classList.remove('active'); }, 3000);
}

// ── Init ──────────────────────────────────────────────────────────

// #495 the app's Home tab (Bryan 28 Sep 18:58): burger menu for the tabs, invested / P&L / break-even in the top card, the account
// breakdown folded, and every section below the chart folded into a tappable header (open ones are remembered on this phone).
function rxAppLayout() {
  var root = document.documentElement;
  if (!root.classList.contains('in-app') || root.getAttribute('data-rx-layout')) return;
  root.setAttribute('data-rx-layout', '1');
  var store = { get: function (k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
                set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  // (1) burger menu
  var tabs = [].map.call(document.querySelectorAll('.tab-nav .tab-btn'), function (b) {
    var m = /switchTab\('([a-z]+)'\)/.exec(b.getAttribute('onclick') || '');
    return m ? { name: m[1], label: b.textContent.trim() } : null;
  }).filter(Boolean);
  var menu = document.createElement('div'); menu.id = 'rx-menu';
  menu.innerHTML = '<div class="shade"></div><div class="sheet" role="menu"><button type="button" class="rx-inbox" data-inbox="1"><span>\ud83d\udd14 Notifications</span><span class="rx-badge" hidden></span></button><h3>Dashboard</h3>' +   // #500
    tabs.map(function (t) { return '<button type="button" data-tab="' + t.name + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
  document.body.appendChild(menu);
  var label = $('rx-tab-label'), burger = $('rx-burger');
  function mark(name) {
    var t = tabs.filter(function (x) { return x.name === name; })[0];
    if (label && t) label.textContent = t.label.replace(/^[^A-Za-z0-9]+\s*/, '');
    [].forEach.call(menu.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === name); });
  }
  var origSwitch = window.switchTab;
  window.switchTab = function (name) { origSwitch(name); mark(name); };
  // #500 Notifications: the first menu item opens the feed (the app's inbox tab), with an unread count on it and on the ☰
  var rxSt = document.createElement('style');
  rxSt.textContent = '#rx-menu .sheet button.rx-inbox{display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:6px}' +
    '.rx-badge{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#ff4d6a;color:#fff;font:700 12px/20px system-ui,sans-serif;text-align:center}' +
    '#rx-burger{position:relative}#rx-burger .rx-dot{position:absolute;left:12px;top:-6px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#ff4d6a;color:#fff;font:700 10px/16px system-ui,sans-serif;text-align:center}';
  document.head.appendChild(rxSt);
  function rxInboxOpen() {
    try { if (window.parent !== window && window.parent.rxApp && window.parent.rxApp.show) { window.parent.rxApp.show('inbox'); return; } } catch (e) {}
    location.href = '/inbox';
  }
  function rxInboxCount() {
    var seen = 0; try { seen = parseInt(localStorage.getItem('rx_inbox_seen') || '0', 10) || 0; } catch (e) {}
    fetch('/api/app/inbox?count=1&after=' + seen, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var n = j && j.count ? j.count : 0, txt = n > 99 ? '99+' : String(n);
      var b = menu.querySelector('.rx-badge'); if (b) { b.textContent = txt; b.hidden = !n; }
      var d = burger && burger.querySelector('.rx-dot');
      if (burger && !d) { d = document.createElement('span'); d.className = 'rx-dot'; burger.appendChild(d); }
      if (d) { d.textContent = txt; d.hidden = !n; }
    }).catch(function () {});
  }
  if (burger) burger.addEventListener('click', function () { menu.classList.add('on'); rxInboxCount(); });
  menu.addEventListener('click', function (e) {
    if (e.target.closest('button[data-inbox]')) { menu.classList.remove('on'); rxInboxOpen(); return; }   // #500
    var b = e.target.closest('button[data-tab]');
    if (b) { window.switchTab(b.getAttribute('data-tab')); window.scrollTo(0, 0); }
    if (b || e.target.classList.contains('shade')) menu.classList.remove('on');
  });
  mark('portfolio');
  rxInboxCount(); setInterval(rxInboxCount, 60000);   // #500 unread count; the feed marks what you have seen
  window.addEventListener('storage', function (e) { if (e.key === 'rx_inbox_seen') rxInboxCount(); });
  // (2) the top card: invested / P&L / break-even under the total; the breakdown by account folded
  var pane = $('tab-portfolio'), top = pane && pane.querySelector('.card'), cap = $('capital-bar'), totals = $('portfolio-totals');
  if (top && cap) { var pv = $('rx-spark') || $('portfolio-value'); top.insertBefore(cap, pv ? pv.nextSibling : null); }   // #507 below the live line
  if (top && totals) {
    var fold = document.createElement('details'); fold.className = 'rx-fold';
    fold.innerHTML = '<summary>Breakdown by account</summary>';
    fold.open = !!(store.get('rx_open') || {})['__breakdown'];
    top.insertBefore(fold, totals); fold.appendChild(totals);
    fold.addEventListener('toggle', function () { var o = store.get('rx_open') || {}; o['__breakdown'] = fold.open; store.set('rx_open', o); });
  }
  // (3) everything after the chart: a header you tap to open; closed by default
  var pvCard = $('pv-card'), pnl = $('pnl-summary-bar'), holdings = null;
  var after = false, secs = [];
  [].slice.call(pane.children).forEach(function (el) {
    if (el === pvCard) { after = true; return; }
    if (!after || /^(SCRIPT|STYLE)$/.test(el.tagName) || el === cap) return;
    secs.push(el);
  });
  secs.forEach(function (el) {
    var head = el.querySelector(':scope > .card-title, :scope > .tangem-title, :scope > .trail-summary-title');
    if (!head) return;
    if (/^Holdings$/.test(head.textContent.trim())) holdings = el;
  });
  if (pnl && holdings) { var ht = holdings.querySelector(':scope > .card-title'); holdings.insertBefore(pnl, ht.nextSibling); secs = secs.filter(function (x) { return x !== pnl; }); }
  var open = store.get('rx_open') || {};
  secs.forEach(function (el) {
    var head = el.querySelector(':scope > .card-title, :scope > .tangem-title, :scope > .trail-summary-title');
    if (!head) return;
    var key = head.textContent.replace(/Full view.*$/, '').replace(/[^A-Za-z ]/g, '').trim().slice(0, 40);
    var body = document.createElement('div'); body.className = 'rx-body';
    [].slice.call(el.children).forEach(function (c) { if (c !== head) body.appendChild(c); });
    el.appendChild(body);
    el.classList.add('rx-sec'); head.classList.add('rx-head');
    var dflt = /^Coins$/.test(key) || /^Budget agent/.test(key) || /^Morning brief/.test(key);   // #531   // #517 the coin list starts open (the Tangem card, #496, is now XRP's row); #528 and the agent's equity chart; everything else starts folded
    if (!(key in open ? open[key] : dflt)) el.classList.add('rx-collapsed');
    head.addEventListener('click', function (e) {
      if (e.target.closest('a')) return;
      e.stopPropagation();   // the agent and desk cards open their page on a tap; the header only folds
      el.classList.toggle('rx-collapsed');
      var o = store.get('rx_open') || {}; o[key] = !el.classList.contains('rx-collapsed'); store.set('rx_open', o);
    });
  });
  try { rxWidgetsInit(pane); } catch (e) { console.warn('widgets', e); }   // #529
  try { rxPipInit(pane); } catch (e) { console.warn('pip', e); }   // #530
}

// #529 Home widgets (Bryan 30 Sep 22:56 "Move [USDT sweep] under portfolio value graph. Default collapsed. Can we make these actually
// choosable widgets that if I press and hold can move?"). Each card from Top movers down is a widget: press and hold it for a menu, or
// hold and move to drag it; "Edit widgets" at the bottom shows or hides each one and moves it with arrows. The order and the hidden set are
// remembered on this phone (localStorage 'rx_widgets'); a new card appears in its default place.
var RX_WIDGETS_DEFAULT = ['brief-card', 'movers-card', 'pv-card', 'sweep-card', 'agent-card', 'coins-card', 'monitor-card'];
function rxWidgetEls(pane) {
  return [].slice.call(pane.children).filter(function (el) { return el.id && rxIsWidget(el.id); });   // #533 cards and coin tiles
}
function rxWidgetName(el) {
  if (RX_TILE_RE.test(el.id)) return el.id.slice(5) + ' tile';   // #533
  var h = el.querySelector('.card-title'); if (!h) return el.id;
  var t = h.cloneNode(true); [].forEach.call(t.querySelectorAll('a, .mini-badge, .rx-dot'), function (x) { x.remove(); });
  return t.textContent.replace(/\s+/g, ' ').trim() || el.id;
}
function rxWidgetsState() {
  var s = (function () { try { return JSON.parse(localStorage.getItem('rx_widgets') || 'null'); } catch (e) { return null; } })() || {};
  var order = Array.isArray(s.order) ? s.order.filter(function (id, i, a) { return rxIsWidget(id) && a.indexOf(id) === i; }) : [];
  RX_WIDGETS_DEFAULT.forEach(function (id, i) {   // a widget missing from the saved order goes after the one before it by default
    if (order.indexOf(id) >= 0) return;
    var prev = RX_WIDGETS_DEFAULT.slice(0, i).reverse().filter(function (p) { return order.indexOf(p) >= 0; })[0];
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
  });
  if (!s.tiles_v) { var at = order.indexOf('movers-card') + 1; ['tile-BTC', 'tile-ETH'].forEach(function (t, k) { if (order.indexOf(t) < 0) order.splice(at + k, 0, t); }); }   // #533 the first time: BTC and ETH tiles under Top movers
  return { order: order, hidden: s.hidden && typeof s.hidden === 'object' ? s.hidden : {} };
}
function rxWidgetsSave(st) { try { localStorage.setItem('rx_widgets', JSON.stringify({ order: st.order, hidden: st.hidden, tiles_v: 1 })); } catch (e) {} }
function rxWidgetsApply(pane, st) {
  st.order.forEach(function (id) { if (RX_TILE_RE.test(id)) rxTileEnsure(pane, id); });   // #533 a tile exists while it is in the order
  [].slice.call(pane.querySelectorAll(':scope > .ct-tile')).forEach(function (el) { if (st.order.indexOf(el.id) < 0) el.remove(); });
  var els = rxWidgetEls(pane); if (!els.length) return;
  var byId = {}; els.forEach(function (el) { byId[el.id] = el; });
  var mark = document.getElementById('rx-w-mark');
  if (!mark) { mark = document.createElement('span'); mark.id = 'rx-w-mark'; mark.hidden = true; pane.insertBefore(mark, els[0]); }
  var ref = mark;
  st.order.forEach(function (id) { var el = byId[id]; if (!el) return; ref.parentNode.insertBefore(el, ref.nextSibling); ref = el; el.hidden = !!st.hidden[id]; });
  rxTilesLoad();   // #533
}
function rxWidgetsInit(pane) {
  if (!pane) return;
  var mc = [].slice.call(pane.children).filter(function (el) { var h = el.querySelector && el.querySelector('.card-title'); return h && /Monitoring Controls/.test(h.textContent); })[0];
  if (mc && !mc.id) mc.id = 'monitor-card';
  var st = rxWidgetsState();
  rxWidgetsApply(pane, st);
  // the Edit widgets button and sheet
  var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'rx-w-edit'; btn.textContent = '✎ Edit widgets';
  pane.appendChild(btn);
  var sheet = document.createElement('div'); sheet.className = 'rx-w-sheet'; sheet.hidden = true;
  sheet.innerHTML = '<div class="rx-w-panel" role="dialog" aria-label="Edit widgets"><div class="rx-w-top"><b>Widgets</b><button type="button" data-w="close" aria-label="Close">✕</button></div>' +
    '<p class="rx-w-tip">Tick the ones to show. Use the arrows, or press and hold a widget on Home and drag it.</p><div class="rx-w-list"></div>' +
    '<button type="button" class="rx-w-reset" data-w="addtile">＋ Add a coin tile</button><button type="button" class="rx-w-reset" data-w="reset">Reset to the default order</button></div>';
  document.body.appendChild(sheet);
  function paint() {
    var byId = {}; rxWidgetEls(pane).forEach(function (el) { byId[el.id] = el; });
    sheet.querySelector('.rx-w-list').innerHTML = st.order.filter(function (id) { return byId[id]; }).map(function (id, i, a) {
      return '<div class="rx-w-row"><label><input type="checkbox" data-w="show" data-id="' + id + '"' + (st.hidden[id] ? '' : ' checked') + '> ' + esc(rxWidgetName(byId[id])) + '</label>' +
        '<button type="button" data-w="up" data-id="' + id + '" aria-label="Move up"' + (i ? '' : ' disabled') + '>▲</button><button type="button" data-w="down" data-id="' + id + '" aria-label="Move down"' + (i < a.length - 1 ? '' : ' disabled') + '>▼</button></div>';
    }).join('');
  }
  btn.addEventListener('click', function () { st = rxWidgetsState(); paint(); sheet.hidden = false; });
  sheet.addEventListener('click', function (e) {
    if (e.target === sheet) { sheet.hidden = true; return; }
    var b = e.target.closest('[data-w]'); if (!b) return;
    var w = b.getAttribute('data-w'), id = b.getAttribute('data-id');
    if (w === 'close') { sheet.hidden = true; return; }
    if (w === 'addtile') { sheet.hidden = true; rxCoinPick('Add a coin tile', function (c) { st = rxWidgetsState(); var nid = 'tile-' + c; if (st.order.indexOf(nid) < 0) { var at = st.order.indexOf('movers-card') + 1; st.order.splice(at, 0, nid); } delete st.hidden[nid]; rxWidgetsSave(st); rxWidgetsApply(pane, st); }); return; }   // #533
    if (w === 'reset') { st = { order: RX_WIDGETS_DEFAULT.slice(), hidden: {} }; st.order.splice(st.order.indexOf('movers-card') + 1, 0, 'tile-BTC', 'tile-ETH'); }   // #533 with the two first tiles
    else if (w === 'show') { if (b.checked) delete st.hidden[id]; else st.hidden[id] = true; }
    else if (w === 'up' || w === 'down') { var i = st.order.indexOf(id), j = w === 'up' ? i - 1 : i + 1; if (i < 0 || j < 0 || j >= st.order.length) return; st.order[i] = st.order[j]; st.order[j] = id; }
    else return;
    rxWidgetsSave(st); rxWidgetsApply(pane, st); paint();
  });
  // #529 press and hold a widget (Bryan 23:09, like Revolut X): a menu pops up (Pop out / Add or edit widgets / Remove); move the finger
  // instead and the menu goes away and the widget follows it until you let go where you want it.
  var menu = document.createElement('div'); menu.className = 'rx-w-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);
  var held = null, drag = null, timer = null, sx = 0, sy = 0, eatClick = false, menuFor = null;
  function cancel() { clearTimeout(timer); timer = null; }
  function cardOf(t) {
    if (!t || !t.closest || t.closest('input, textarea, select, .rx-w-menu, .rx-w-sheet')) return null;
    var el = t; while (el && el.parentNode !== pane) el = el.parentNode;
    return el && rxIsWidget(el.id) && !el.hidden ? el : null;
  }
  function menuClose() { menu.hidden = true; if (menuFor) menuFor.classList.remove('rx-w-held'); menuFor = null; }
  function menuOpen(card) {
    menuFor = card; card.classList.add('rx-w-held');
    var pip = typeof window.rxPopOut === 'function' && document.documentElement.classList.contains('rx-pip-ok');
    var tile = RX_TILE_RE.test(card.id);   // #533 a coin tile: Select crypto / Add coin tile / Remove
    menu.innerHTML = (tile ? '<button type="button" role="menuitem" data-m="pick"><span>✎</span>Select crypto</button>' : '') +
      (pip ? '<button type="button" role="menuitem" data-m="pop"><span>⧉</span>Pop out</button>' : '') +
      '<button type="button" role="menuitem" data-m="addtile"><span>＋</span>Add coin tile</button>' +
      (tile ? '' : '<button type="button" role="menuitem" data-m="edit"><span>☰</span>Edit widgets</button>') +
      '<button type="button" role="menuitem" data-m="remove" class="rx-w-danger"><span>🗑</span>Remove</button>';
    menu.hidden = false;
    var r = card.getBoundingClientRect(), mh = menu.offsetHeight, mw = menu.offsetWidth;
    var top = Math.min(Math.max(8, sy - mh / 2), window.innerHeight - mh - 8);
    menu.style.top = top + 'px'; menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw - 8)) + 'px';
  }
  menu.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-m]'); if (!b || !menuFor) return;
    var m = b.getAttribute('data-m'), card = menuFor; menuClose();
    if (m === 'pick' || m === 'addtile') {   // #533
      rxCoinPick(m === 'pick' ? 'Select crypto' : 'Add a coin tile', function (c) {
        var nid = 'tile-' + c; st = rxWidgetsState();
        if (st.order.indexOf(nid) >= 0 && nid !== card.id) { showToast(c + ' already has a tile'); return; }
        var at = st.order.indexOf(card.id);
        if (m === 'pick') { st.order[at] = nid; if (card.id !== nid) card.remove(); } else st.order.splice(at + 1, 0, nid);
        rxWidgetsSave(st); rxWidgetsApply(pane, st);
      });
      return;
    }
    if (m === 'remove' && RX_TILE_RE.test(card.id)) { st = rxWidgetsState(); st.order = st.order.filter(function (x) { return x !== card.id; }); delete st.hidden[card.id]; rxWidgetsSave(st); rxWidgetsApply(pane, st); return; }   // #533 a tile goes; add it again from any widget's menu
    if (m === 'pop') window.rxPopOut(card.id);
    else if (m === 'edit') btn.click();
    else if (m === 'remove') { st = rxWidgetsState(); st.hidden[card.id] = true; rxWidgetsSave(st); rxWidgetsApply(pane, st); showToast(rxWidgetName(card) + ' removed - add it back with Edit widgets at the bottom'); }
  });
  document.addEventListener('pointerdown', function (e) { if (!menu.hidden && !e.target.closest('.rx-w-menu')) { menuClose(); } }, true);
  window.addEventListener('scroll', function () { if (!menu.hidden && !held) menuClose(); }, { passive: true });
  function lift(card) {   // the hold completed: menu up, ready to drag
    held = card; eatClick = true;
    try { navigator.vibrate && navigator.vibrate(15); } catch (e) {}
    menuOpen(card);
  }
  function startDrag() {
    menuClose(); drag = held; drag.classList.add('rx-w-drag'); document.documentElement.classList.add('rx-w-dragging');
  }
  function move(x, y) {
    if (!drag) return;
    var els = rxWidgetEls(pane).filter(function (el) { return !el.hidden && el !== drag; });
    var before = null, after = null, top0 = drag.getBoundingClientRect().top;
    for (var k = 0; k < els.length; k++) {   // #533 over a tile: its left half goes before it, its right half after it (tiles share rows)
      var q = els[k].getBoundingClientRect();
      if (x >= q.left && x <= q.right && y >= q.top && y <= q.bottom) { if (els[k].classList.contains('ct-tile') ? x < q.left + q.width / 2 : y < q.top + q.height / 2) before = els[k]; else after = els[k]; break; }
    }
    if (after) { if (after.nextElementSibling !== drag) pane.insertBefore(drag, after.nextSibling); }
    else {
      if (!before) for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { before = els[i]; break; } }
      if (before) { if (drag.nextElementSibling !== before) pane.insertBefore(drag, before); }
      else { var last = els[els.length - 1]; if (last && last.nextSibling !== drag) pane.insertBefore(drag, last.nextSibling); }
    }
    var jump = drag.getBoundingClientRect().top - top0; if (jump) window.scrollBy(0, jump);   // keep the card under the finger when it jumps past a tall one
    if (y < 60) window.scrollBy(0, -12); else if (y > window.innerHeight - 60) window.scrollBy(0, 12);   // scrolls while held at an edge
  }
  function end() {
    cancel();
    if (drag) {
      drag.classList.remove('rx-w-drag'); document.documentElement.classList.remove('rx-w-dragging'); drag = null;
      st = rxWidgetsState(); var shown = rxWidgetEls(pane).map(function (el) { return el.id; });
      st.order = shown.concat(st.order.filter(function (id) { return shown.indexOf(id) < 0; }));
      rxWidgetsSave(st);
    }
    held = null;   // a hold without a move leaves the menu open for a tap
    if (eatClick) setTimeout(function () { eatClick = false; }, 400);
  }
  function down(card, x, y) { sx = x; sy = y; cancel(); timer = setTimeout(function () { timer = null; lift(card); }, 450); }
  function moved(x, y) {
    if (timer && (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8)) cancel();   // it is a scroll, not a hold
    if (held && !drag && (Math.abs(x - sx) > 10 || Math.abs(y - sy) > 10)) startDrag();
    if (drag) move(x, y);
  }
  pane.addEventListener('touchstart', function (e) { var card = cardOf(e.target); if (card && e.touches.length === 1) down(card, e.touches[0].clientX, e.touches[0].clientY); else cancel(); }, { passive: true });
  document.addEventListener('touchmove', function (e) { var t = e.touches[0]; if (!t) return; moved(t.clientX, t.clientY); if (held) e.preventDefault(); }, { passive: false });
  document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
  pane.addEventListener('mousedown', function (e) { var card = cardOf(e.target); if (card && !e.button) down(card, e.clientX, e.clientY); });   // the same with a mouse
  document.addEventListener('mousemove', function (e) { if (timer || held) { moved(e.clientX, e.clientY); if (drag) e.preventDefault(); } });
  document.addEventListener('mouseup', end);
  pane.addEventListener('contextmenu', function (e) { if (cardOf(e.target)) e.preventDefault(); });
  document.addEventListener('click', function (e) { if (eatClick) { e.stopPropagation(); e.preventDefault(); eatClick = false; } }, true);   // letting go after a hold is not a tap (not even on the menu that just opened under the finger)
}

// #530 POP OUT (Bryan 30 Sep 22:56 "option to make pop out that stays open above my apps ... like YouTube or Google Maps"; 23:33 desk
// #37 Option B: a floating window over every app that he can drag and resize from a corner). Inside the app (v13+, which has the
// RxFloat plugin) a widget's press-and-hold menu offers "Pop out" (23:09: options on a hold, not buttons on the widget). The app opens
// a floating window over other apps with this page in float mode: /?app=1&float=<widget> shows that one widget, scaled to the window;
// a coin tile floats its coin's chart (/coin?c=SYM&float=1). A tap in the window brings the app to the front. In a browser, or an
// older app, there is no Pop out. Read-only: the float pages are the same read routes the app uses.
var rxPip = { id: null, wasCollapsed: false, w: 0, h: 0 };
function rxPipApp() { try { return window.parent !== window && window.parent.rxApp && window.parent.rxApp.float ? window.parent.rxApp : null; } catch (e) { return null; } }
function rxPipScale() {
  var el = rxPip.id && document.getElementById(rxPip.id); if (!el) return;
  document.documentElement.style.setProperty('--pipw', rxPip.w + 'px');
  var s = Math.min(window.innerWidth / rxPip.w, rxPip.h > 0 ? window.innerHeight / rxPip.h : 99);   // the whole widget fits the window
  document.documentElement.style.setProperty('--pips', String(Math.max(0.1, s)));
}
window.rxPipShow = function (id) {   // a widget id to show alone (float mode), or null for the normal page
  var cur = rxPip.id && document.getElementById(rxPip.id);
  if (cur) { cur.classList.remove('rx-pip-on'); if (rxPip.wasCollapsed) cur.classList.add('rx-collapsed'); }
  rxPip.id = null; document.documentElement.classList.remove('rx-pip');
  var el = id && document.getElementById(id);
  if (!el || !rxIsWidget(id)) return;   // #533 tiles pop out too
  rxPip.wasCollapsed = el.classList.contains('rx-collapsed'); el.classList.remove('rx-collapsed'); el.hidden = false;
  var r = el.getBoundingClientRect(); rxPip.w = Math.round(r.width) || 380; rxPip.h = Math.round(r.height) || 0;
  rxPip.id = id; el.classList.add('rx-pip-on'); document.documentElement.classList.add('rx-pip'); rxPipScale();
};
window.addEventListener('resize', function () { if (rxPip.id) { var el = document.getElementById(rxPip.id); if (el) rxPip.h = Math.round(el.offsetHeight) || rxPip.h; } rxPipScale(); });
function rxPopOut(id) {
  var A = rxPipApp(); if (!A) return;
  var t = /^tile-([A-Z0-9]{1,15})$/.exec(id || '');
  var path = t ? '/coin?c=' + t[1] + '&float=1' : '/?app=1&float=' + String(id || '').replace(/[^a-z-]/g, '');
  Promise.resolve(A.float(path)).then(function (r) {
    if (r && r.needs_permission) showToast('Allow "Display over other apps" for Revolut X, then tap Pop out again');
  }).catch(function (e) { showToast('Pop-out did not open: ' + (e && e.message ? e.message : e), true); });
}
function rxPipInit(pane) {   // the app says whether it can float; the widget menu (press and hold) then offers "Pop out"
  var fm = /[?&]float=([a-z-]{1,40})(&|$)/.exec(location.search);
  if (fm) { rxFloatMode(fm[1]); return; }
  var A = rxPipApp(); if (!A || !A.floatOk) return;
  Promise.resolve(A.floatOk()).then(function (ok) { if (ok) document.documentElement.classList.add('rx-pip-ok'); }).catch(function () {});
}
function rxFloatMode(id) {   // this page IS the floating window: one widget; a tap opens the app (on a coin when the tap was on one)
  document.documentElement.classList.add('rx-float');
  setTimeout(function () { window.rxPipShow(id); }, 300);
  setTimeout(function () { window.rxPipShow(id); }, 2500);   // again once its data has drawn (the height changes)
  document.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var c = e.target.closest && e.target.closest('[data-coin]'), coin = c ? String(c.getAttribute('data-coin') || '').toUpperCase() : '';
    try { if (window.RxFloatHost && window.RxFloatHost.open) window.RxFloatHost.open(/^[A-Z0-9]{1,15}$/.test(coin) ? coin : ''); } catch (e2) {}
  }, true);
}

// #492 open one coin's card - from a notification (the app shell calls rxFocusCoin, or loads /?app=1#coin=AST).
// #508 a coin now has its own page (/coin?c=AST: live price, candles, levels and everything the card held), so a card tap,
// a ticker in a notification and a pushed coin all open that page. The hash is cleared first, so Back returns to the
// dashboard instead of re-opening the coin.
function rxOpenCoin(sym) {
  sym = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
  if (!sym) return;
  location.href = '/coin?c=' + sym + (document.documentElement.classList.contains('in-app') ? '&app=1' : '');
}
function rxFocusCoin(sym) { rxOpenCoin(sym); }
function rxFocusFromHash() {
  var m = /[#&]coin=([A-Za-z0-9]{1,15})/.exec(location.hash); if (!m) return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  rxOpenCoin(m[1]);
}
window.addEventListener('hashchange', rxFocusFromHash);

document.addEventListener('DOMContentLoaded', function() {
  console.log('Dashboard v' + DASHBOARD_VERSION + ' initialising');
  try { rxAppLayout(); } catch (e) { console.error('rxAppLayout', e); }   // #495
  refreshAll();
  rxFocusFromHash();   // #492
  setInterval(refreshAll, 5 * 60 * 1000);
  setInterval(function () { if (!document.hidden) loadCoins(); }, 60 * 1000);   // #516 prices and 24 h change every minute
});

// #531 the Morning brief widget: the newest brief from GET /api/brief/latest (refreshed every 10 minutes)
var rxBriefOpen = false, rxBriefCur = null;
function rxBriefHand(line) {   // #535 hand the brief (or one line of it) to the Claude PM thread as the link opens; the server writes the note
  if (!rxBriefCur || !rxBriefCur.id) return;
  try { fetch('/api/brief/handover', { method: 'POST', keepalive: true, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rxBriefCur.id, line: line == null ? null : line }) }).catch(function () {}); } catch (e) {}
}
function rxBriefRender(d) {
  var box = document.getElementById('bf-body'); if (!box) return;
  var b = d && d.brief;
  if (!b) { box.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">No brief kept yet. The next one comes at 09:15, or send /brief in Telegram.</span>'; return; }
  var when = new Date(b.ts * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  var v = b.video, h = '<div class="bf-when">' + esc(when) + '</div>';
  if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v.id || '')) {
    h += '<a class="bf-vid" href="https://www.youtube.com/watch?v=' + v.id + '" target="_blank" rel="noopener noreferrer"><div class="bf-thumb" style="background-image:url(\'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg\')"><span class="bf-play" aria-hidden="true"></span></div>' +
      '<div class="bf-vt"><small>YouTube' + (v.channel ? ' · ' + esc(v.channel) : '') + '</small><b>' + esc(v.title || 'Video') + '</b></div></a>';
  }
  rxBriefCur = { id: b.id, url: d.pm_url || null };   // #535 a line is tappable: Ask the PM / Claude, with that line handed over
  var lines = String(b.market_html || '').split('\n').map(function (l, i) { return l.replace(/<[^>]*>/g, '').trim() ? '<div class="bf-l" data-i="' + i + '">' + l + '</div>' : '<div class="bf-e"></div>'; }).join('');
  h += '<div class="bf-txt' + (rxBriefOpen ? '' : ' clip') + '" id="bf-txt">' + lines + '</div>' +
    '<button type="button" class="bf-more" id="bf-more">' + (rxBriefOpen ? 'Show less ▴' : 'Read the whole brief ▾') + '</button>' +
    (b.snapshot_html ? '<details><summary>Portfolio snapshot at the time</summary><div class="bf-txt">' + b.snapshot_html + '</div></details>' : '');
  var app = null; try { app = window.parent !== window && window.parent.rxApp && window.parent.rxApp.pm ? window.parent.rxApp : null; } catch (e) {}
  var acts = (app ? '<button type="button" class="bf-ask" id="bf-ask">💬 Ask PM</button>' : '') +
    (d.pm_url ? '<a class="bf-claude" id="bf-claude" href="' + rxAttr(d.pm_url) + '" target="_blank" rel="noopener noreferrer">Claude ↗</a>' : '') +
    '<span class="bf-tip">or tap a line</span>';
  if (acts) h += '<div class="bf-acts">' + acts + '</div>';
  box.innerHTML = h;
}
function rxBriefLoad() {
  fetch('/api/brief/latest', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(rxBriefRender).catch(function (e) { var box = document.getElementById('bf-body'); if (box) box.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">Brief not loaded: ' + esc(e.message) + '</span>'; });
}
document.addEventListener('click', function (e) {
  var t = e.target;
  if (t && t.id === 'bf-more') { rxBriefOpen = !rxBriefOpen; var x = document.getElementById('bf-txt'); if (x) x.classList.toggle('clip', !rxBriefOpen); t.textContent = rxBriefOpen ? 'Show less ▴' : 'Read the whole brief ▾'; return; }
  if (t && t.id === 'bf-ask') { try { window.parent.rxApp.pm('About this morning\'s brief: '); } catch (e2) {} }
  if (t && t.closest && t.closest('#bf-claude')) rxBriefHand(null);   // #535 the whole brief goes with him
  var la = t && t.closest && t.closest('.bf-la [data-a]');
  if (la) { var ln = la.closest('.bf-la').previousElementSibling, i = ln ? Number(ln.getAttribute('data-i')) : null, txt = ln ? ln.textContent.trim() : '';
    if (la.getAttribute('data-a') === 'claude') rxBriefHand(i);
    else { try { window.parent.rxApp.pm('About this line of the morning brief: "' + txt.slice(0, 220) + '" - '); } catch (e3) {} }
    return; }
  var l = t && t.closest && t.closest('#bf-txt .bf-l');
  if (l && !(t.closest && t.closest('a'))) {   // #535 tap a line: two small actions under it
    var open = l.nextElementSibling && l.nextElementSibling.classList.contains('bf-la');
    [].forEach.call(document.querySelectorAll('#bf-txt .bf-la'), function (x) { x.remove(); });
    [].forEach.call(document.querySelectorAll('#bf-txt .bf-l.on'), function (x) { x.classList.remove('on'); });
    if (open) return;
    var appOk = false; try { appOk = !!(window.parent !== window && window.parent.rxApp && window.parent.rxApp.pm); } catch (e4) {}
    if (!appOk && !(rxBriefCur && rxBriefCur.url)) return;
    l.classList.add('on');
    var a = document.createElement('div'); a.className = 'bf-la';
    a.innerHTML = (appOk ? '<button type="button" data-a="ask">💬 Ask PM</button>' : '') + (rxBriefCur && rxBriefCur.url ? '<a data-a="claude" href="' + rxAttr(rxBriefCur.url) + '" target="_blank" rel="noopener noreferrer">Claude ↗</a>' : '');
    l.parentNode.insertBefore(a, l.nextSibling);
    if (!rxBriefOpen) { rxBriefOpen = true; var bx = document.getElementById('bf-txt'); if (bx) bx.classList.remove('clip'); var mb = document.getElementById('bf-more'); if (mb) mb.textContent = 'Show less ▴'; }
  }
});
if (document.getElementById('bf-body')) { rxBriefLoad(); setInterval(function () { if (!document.hidden) rxBriefLoad(); }, 10 * 60000); }

// #533 coin tiles on Home (Bryan 30 Sep 23:21, like Revolut X): small two-per-row widgets, one coin each - pair, logo, price, 24 h
// change and a 24 h line. They are widgets like the cards: press and hold for Select crypto / Add coin tile / Remove, or hold and move
// to put one anywhere (two tiles side by side share a row). Tap one for its coin page. Kept on this phone with the widget order.
var RX_TILE_RE = /^tile-[A-Z0-9]{1,15}$/;
function rxIsWidget(id) { return RX_WIDGETS_DEFAULT.indexOf(id) >= 0 || RX_TILE_RE.test(id || ''); }
var rxTileData = {};
function rxTileEnsure(pane, id) {
  var el = document.getElementById(id); if (el) return el;
  var c = id.slice(5);
  el = document.createElement('div'); el.className = 'card ct-tile'; el.id = id; el.setAttribute('data-coin', c); el.setAttribute('role', 'link'); el.tabIndex = 0;
  el.innerHTML = '<div class="ct-top"><span class="ct-pair">' + esc(c) + '-USD</span><span class="ct-ic"></span></div><div class="ct-px">–</div><div class="ct-ch">&nbsp;</div><div class="ct-sp"></div>';
  el.addEventListener('click', function () { rxOpenCoin(c); });
  pane.appendChild(el); rxTileRender(el);
  return el;
}
function rxTilePx(v) { if (v == null || !isFinite(v)) return '–'; var a = Math.abs(v); return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: a >= 1000 ? 0 : 2, maximumFractionDigits: a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8 }); }
function rxTileSpark(pts, up) {
  if (!pts || pts.length < 2) return '';
  var W = 150, H = 54, lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts); if (hi - lo <= 0) { hi += 1e-9; lo -= 1e-9; }
  var x = function (i) { return (i * W / (pts.length - 1)).toFixed(1); }, y = function (v) { return (3 + (hi - v) * (H - 6) / (hi - lo)).toFixed(1); };
  var line = pts.map(function (v, i) { return x(i) + ',' + y(v); }).join(' '), col = up ? 'var(--ct-up)' : 'var(--ct-dn)', gid = 'ctg' + (up ? 'u' : 'd'), g = '';
  for (var i = 1; i < 6; i++) g += '<line x1="' + (i * W / 6).toFixed(1) + '" x2="' + (i * W / 6).toFixed(1) + '" y1="0" y2="' + H + '" class="ct-grid"/>';
  for (var j = 1; j < 4; j++) g += '<line x1="0" x2="' + W + '" y1="' + (j * H / 4).toFixed(1) + '" y2="' + (j * H / 4).toFixed(1) + '" class="ct-grid"/>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="' + gid + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + col + '" stop-opacity="0.35"/><stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' + g +
    '<line x1="0" x2="' + W + '" y1="' + y(pts[0]) + '" y2="' + y(pts[0]) + '" class="ct-open"/>' +
    '<polygon fill="url(#' + gid + ')" points="0,' + H + ' ' + line + ' ' + W + ',' + H + '"/><polyline fill="none" stroke="' + col + '" stroke-width="1.8" stroke-linejoin="round" points="' + line + '"/></svg>';
}
function rxTileRender(el) {
  var d = rxTileData[el.getAttribute('data-coin')]; if (!d) return;
  var up = d.change24h == null ? true : d.change24h >= 0;
  el.querySelector('.ct-px').textContent = rxTilePx(d.price);
  var ch = el.querySelector('.ct-ch'); ch.className = 'ct-ch ' + (d.change24h == null ? '' : up ? 'up' : 'dn'); ch.textContent = d.change24h == null ? ' ' : (up ? '▲ ' : '▼ ') + Math.abs(d.change24h).toFixed(2) + '%';
  el.querySelector('.ct-sp').innerHTML = rxTileSpark(d.spark, up);
  var ic = el.querySelector('.ct-ic');
  if (!ic.getAttribute('data-done')) { ic.setAttribute('data-done', '1'); ic.innerHTML = rxCoinIcon({ coin: d.coin, icon: d.icon }); }
  el.setAttribute('aria-label', (d.name || d.coin) + ' ' + rxTilePx(d.price));
}
function rxTilesLoad() {
  var els = [].slice.call(document.querySelectorAll('#tab-portfolio > .ct-tile')); if (!els.length) return;
  var cs = els.map(function (el) { return el.getAttribute('data-coin'); });
  fetch('/api/coins/tiles?c=' + encodeURIComponent(cs.join(',')), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) {
    (j.tiles || []).forEach(function (t) { rxTileData[t.coin] = t; });
    els.forEach(function (el) { var ic = el.querySelector('.ct-ic'); if (ic && ic.getAttribute('data-done') && !ic.querySelector('img') && (rxTileData[el.getAttribute('data-coin')] || {}).icon) ic.removeAttribute('data-done'); rxTileRender(el); });
  }).catch(function () {});
}
setInterval(function () { if (!document.hidden && !document.documentElement.classList.contains('rx-w-dragging')) rxTilesLoad(); }, 60000);
// the coin picker: his coins first (from the coin list), a search box, and any ticker typed
function rxCoinPick(title, cb) {
  var sh = document.getElementById('ct-pick');
  if (!sh) { sh = document.createElement('div'); sh.id = 'ct-pick'; sh.className = 'rx-w-sheet'; document.body.appendChild(sh); }
  sh.innerHTML = '<div class="rx-w-panel" role="dialog" aria-label="' + rxAttr(title) + '"><div class="rx-w-top"><b>' + esc(title) + '</b><button type="button" data-p="close" aria-label="Close">✕</button></div>' +
    '<input class="ct-q" type="search" placeholder="Search or type a ticker, e.g. SOL" autocomplete="off" spellcheck="false"><div class="ct-list"><p class="rx-w-tip">Loading your coins…</p></div></div>';
  sh.hidden = false;
  var q = sh.querySelector('.ct-q'), list = sh.querySelector('.ct-list'), all = [];
  function paint() {
    var s = String(q.value || '').trim().toUpperCase().replace(/-USD$/, ''), rows = all.filter(function (c) { return !s || c.coin.indexOf(s) === 0 || String(c.name || '').toUpperCase().indexOf(s) >= 0; }).slice(0, 60);
    var h = rows.map(function (c) { return '<button type="button" class="ct-opt" data-c="' + rxAttr(c.coin) + '">' + rxCoinIcon(c) + '<span><b>' + esc(c.coin) + '</b> ' + esc(c.name || '') + '</span></button>'; }).join('');
    if (/^[A-Z0-9]{1,15}$/.test(s) && !all.some(function (c) { return c.coin === s; })) h += '<button type="button" class="ct-opt" data-c="' + s + '"><span class="cl-ic"></span><span><b>' + esc(s) + '</b> use this ticker</span></button>';
    list.innerHTML = h || '<p class="rx-w-tip">No match.</p>';
  }
  q.addEventListener('input', paint);
  sh.onclick = function (e) {
    if (e.target === sh || e.target.closest('[data-p="close"]')) { sh.hidden = true; return; }
    var b = e.target.closest('.ct-opt'); if (!b) return;
    sh.hidden = true; cb(b.getAttribute('data-c'));
  };
  fetch('/api/coins', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    var seen = {}; ['BTC', 'ETH'].concat((d.coins || []).filter(function (c) { return c.section !== 'dust'; }).map(function (c) { return c.coin; })).forEach(function (c) { seen[c] = seen[c] || { coin: c }; });
    (d.coins || []).forEach(function (c) { if (seen[c.coin]) { seen[c.coin].name = c.name; seen[c.coin].icon = c.icon; } });
    all = Object.keys(seen).map(function (k) { return seen[k]; }); paint();
  }).catch(function () { paint(); });
  setTimeout(function () { try { q.focus(); } catch (e) {} }, 60);
}
