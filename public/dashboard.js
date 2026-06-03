var DASHBOARD_VERSION = '1.0.9';
console.log('Dashboard v' + DASHBOARD_VERSION);

window.onerror = function(msg, src, line) {
  var b = document.createElement('div');
  b.style.cssText = 'background:red;color:white;padding:10px;font-size:12px;position:fixed;top:0;left:0;right:0;z-index:9999';
  b.textContent = 'JS Error line ' + line + ': ' + msg;
  document.body.prepend(b);
};

function fmt(price) {
  var p = parseFloat(price || 0);
  if (!p) return '$0';
  if (p < 0.000001) return '$' + p.toFixed(10);
  if (p < 0.0001) return '$' + p.toFixed(8);
  if (p < 0.01) return '$' + p.toFixed(6);
  if (p < 1) return '$' + p.toFixed(4);
  return '$' + p.toFixed(2);
}

function setEl(id, text, color) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (color) el.style.color = color;
}

function fetchData(url) {
  return fetch(url).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).catch(function(e) {
    console.error('Fetch error:', url, e.message);
    return null;
  });
}

function showTab(name, el) {
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(p) { p.classList.remove('active'); });
  if (el) el.classList.add('active');
  var pane = document.getElementById('tab-' + name);
  if (pane) pane.classList.add('active');
  if (name === 'activity') loadActivity('all');
  if (name === 'portfolio') loadPortfolio();
}

function filterActivity(f, el) {
  document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
  if (el) el.classList.add('active');
  loadActivity(f);
}

function loadPortfolio() {
  fetchData('/portfolio/summary').then(function(data) {
    if (!data) { setEl('portfolio-value', 'Error loading'); return; }

    var revolut  = parseFloat(data.total_value_usd || 0);
    var kraken   = parseFloat(data.kraken_total_usd || 0);
    var tangem   = parseFloat(data.tangem_value_usd || (data.tangem && data.tangem.valueUSD) || 0);
    var cashUSD  = parseFloat(data.cash_usd || 0);
    var cashUSDT = parseFloat(data.cash_usdt || 0);
    var grandTotal = revolut + kraken + tangem + cashUSD + cashUSDT;

    setEl('portfolio-value', '$' + grandTotal.toFixed(2));
    setEl('revolut-crypto-subtotal', '$' + revolut.toFixed(2));
    setEl('kraken-crypto-subtotal', kraken > 0 ? '$' + kraken.toFixed(2) : '$0');
    setEl('tangem-subtotal', tangem > 0 ? '$' + tangem.toFixed(2) : '~$1,228 (cached)');
    setEl('revolut-cash-subtotal', '$' + (cashUSD + cashUSDT).toFixed(2));
    setEl('portfolio-total-sum', '$' + grandTotal.toFixed(2));

    var inv    = parseFloat(data.invested || 0);
    var pnlUsd = parseFloat(data.pl_usd || 0);
    var pnlPct = parseFloat(data.pl_pct || 0);
    var beNeeded = grandTotal > 0 && inv > grandTotal ? ((inv - grandTotal) / grandTotal * 100) : 0;

    setEl('cap-invested', '$' + inv.toFixed(0));
    setEl('cap-current',  '$' + grandTotal.toFixed(0));
    setEl('cap-pnl',
      (pnlUsd >= 0 ? '+' : '') + '$' + Math.abs(pnlUsd).toFixed(0) +
      ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%)',
      pnlUsd >= 0 ? 'var(--accent)' : 'var(--danger)'
    );
    setEl('cap-breakeven', '+' + beNeeded.toFixed(1) + '%', 'var(--warn)');
    setEl('last-updated', 'Updated ' + new Date().toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', second:'2-digit'}));

    var positions = data.positions || [];
    positions.sort(function(a, b) { return parseFloat(b.value_usd || 0) - parseFloat(a.value_usd || 0); });

    var html = '';
    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      var val = parseFloat(pos.value_usd || 0);
      if (val < 1) continue;
      var cp  = parseFloat(pos.current_price || 0);
      var ep  = parseFloat(pos.entry_price   || 0);
      var pl  = ep > 0 ? ((cp - ep) / ep * 100) : 0;
      var plc = pl >= 0 ? '#00ff88' : '#ff4444';
      var entryLine = ep > 0
        ? 'Entry: ' + fmt(ep) + ' | Now: ' + fmt(cp) + ' | <span style="color:' + plc + '">' + (pl >= 0 ? '+' : '') + pl.toFixed(1) + '%</span>'
        : 'Now: ' + fmt(cp);
      var hb = parseFloat(pos.historical_basis || 0);
      var histLine = '';
      if (hb > 0 && ep > 0 && Math.abs(hb - ep) > 0.000001) {
        var hpl = ((cp - hb) / hb * 100);
        var hc  = hpl >= 0 ? '#00ff88' : '#ff4444';
        histLine = '<br><span style="color:#555;font-size:10px">Hist: ' + fmt(hb) + ' <span style="color:' + hc + '">' + (hpl >= 0 ? '+' : '') + hpl.toFixed(1) + '%</span></span>';
      }
      var cy = parseInt(pos.cycle_count || 0);
      var cyLine = cy > 0 ? '<br><span style="color:#444;font-size:10px">' + cy + ' cycle(s)</span>' : '';
      html += '<div style="border-left:3px solid ' + plc + ';padding:10px 12px;margin-bottom:8px;background:#1a1a1a;border-radius:4px">'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        + '<span style="color:white;font-weight:bold">' + pos.currency + '</span>'
        + '<span style="color:white;font-weight:bold">$' + val.toFixed(2) + '</span></div>'
        + '<div style="font-size:11px;color:#888">' + entryLine + histLine + cyLine + '</div></div>';
    }
    var holdEl = document.getElementById('holdings-list');
    if (holdEl) holdEl.innerHTML = html || '<p style="color:#888">No positions</p>';
  });

  fetchData('/api/kraken/balances').then(function(data) {
    var el = document.getElementById('kraken-holdings');
    if (!el || !data || !data.balances) return;
    var html = '';
    var bal = data.balances.filter(function(b) { return parseFloat(b.valueUSD || 0) >= 1; });
    bal.sort(function(a, b) { return parseFloat(b.valueUSD || 0) - parseFloat(a.valueUSD || 0); });
    for (var i = 0; i < bal.length; i++) {
      var b   = bal[i];
      var val = parseFloat(b.valueUSD || 0);
      var ep  = parseFloat(b.entryPrice || 0);
      var cp  = parseFloat(b.price || 0);
      var pl  = ep > 0 ? ((cp - ep) / ep * 100) : 0;
      var plc = pl >= 0 ? '#00ff88' : '#ff4444';
      html += '<div style="border-left:3px solid ' + plc + ';padding:8px 12px;margin-bottom:6px;background:#111;border-radius:4px">'
        + '<div style="display:flex;justify-content:space-between">'
        + '<span style="color:#aaa;font-weight:bold">' + b.standard + '</span>'
        + '<span style="color:#aaa">$' + val.toFixed(2) + '</span></div>'
        + (ep > 0 ? '<div style="color:#666;font-size:10px">' + fmt(ep) + ' entry | <span style="color:' + plc + '">' + (pl >= 0 ? '+' : '') + pl.toFixed(1) + '%</span></div>' : '')
        + '</div>';
    }
    el.innerHTML = html || '<p style="color:#555;font-size:12px">No Kraken holdings</p>';
  });
}

function loadSweepConfig() {
  fetchData('/api/sweep/config').then(function(data) {
    if (!data) return;
    var pctEl = document.getElementById('sweep-pct-input');
    var minEl = document.getElementById('sweep-min-input');
    var chkEl = document.getElementById('sweep-enabled-toggle');
    var resEl = document.getElementById('sweep-usdt-balance');
    if (pctEl) pctEl.value = data.sweep_pct || 25;
    if (minEl) minEl.value = data.min_trade_value_usd || 10;
    if (chkEl) chkEl.checked = data.enabled !== false;
    if (resEl) resEl.textContent = '$' + parseFloat(data.usdt_reserve || 0).toFixed(2);
  });
}

function saveSweepConfig() {
  var pctEl = document.getElementById('sweep-pct-input');
  var minEl = document.getElementById('sweep-min-input');
  var chkEl = document.getElementById('sweep-enabled-toggle');
  if (!pctEl || !minEl) return;
  fetch('/api/sweep/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sweep_pct: parseFloat(pctEl.value), min_trade_value_usd: parseFloat(minEl.value), enabled: chkEl ? chkEl.checked : true })
  }).then(function(r) { if (r.ok) alert('Sweep config saved'); });
}

function loadActivity(filter) {
  filter = filter || 'all';
  var el = document.getElementById('activity-feed');
  if (!el) return;
  el.innerHTML = '<p style="color:#888">Loading...</p>';
  fetchData('/api/activity?limit=50&filter=' + encodeURIComponent(filter)).then(function(data) {
    if (!data || !data.trades || !data.trades.length) { el.innerHTML = '<p style="color:#888">No activity yet</p>'; return; }
    var colors = { buy:'#00ff88', sell:'#ff4444', payment:'#ffaa00', transfer:'#888888', sweep:'#4488ff', rebalance:'#aa44ff' };
    var html = '';
    for (var i = 0; i < data.trades.length; i++) {
      var t   = data.trades[i];
      var col = colors[t.action] || '#888';
      var d   = new Date(t.created_at);
      var ds  = d.toLocaleDateString('en-GB', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'});
      var qty = parseFloat(t.quantity || 0);
      var qs  = qty >= 1000000 ? (qty/1000000).toFixed(2)+'M' : qty >= 1000 ? (qty/1000).toFixed(2)+'K' : qty.toFixed(4);
      var val = t.value_usd ? '$' + parseFloat(t.value_usd).toFixed(2) : '';
      var pnl = t.outcome_pnl ? parseFloat(t.outcome_pnl) : null;
      var pnlStr = pnl !== null ? '<span style="color:' + (pnl>=0?'#00ff88':'#ff4444') + ';margin-left:8px;font-size:11px">' + (pnl>=0?'+':'') + '$' + Math.abs(pnl).toFixed(2) + '</span>' : '';
      html += '<div style="border-left:3px solid ' + col + ';padding:10px 12px;margin-bottom:8px;background:#1a1a1a;border-radius:4px">'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        + '<div><span style="color:' + col + ';font-weight:bold;font-size:11px;text-transform:uppercase">' + t.action + '</span>'
        + '<span style="color:white;font-weight:bold;margin-left:6px">' + t.symbol + '</span>' + pnlStr + '</div>'
        + '<span style="color:#666;font-size:11px">' + ds + '</span></div>'
        + '<div style="color:#aaa;font-size:12px;margin-bottom:4px">' + qs + ' @ ' + fmt(t.price) + (val ? ' = ' + val : '') + '</div>'
        + '<div style="color:#666;font-size:11px">' + (t.reasoning || 'No reason logged') + '</div></div>';
    }
    el.innerHTML = html;
  });
}

document.addEventListener('DOMContentLoaded', function() {
  loadPortfolio();
  loadSweepConfig();
  setInterval(loadPortfolio, 300000);
});
