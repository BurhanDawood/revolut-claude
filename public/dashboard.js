// dashboard.js v3.0.0 — matched to dashboard.html

var DASHBOARD_VERSION = '3.0.0';
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

function fetchData(url) {
  return fetch(url).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).catch(function(e) {
    console.error('Fetch error ' + url + ':', e.message);
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
  if (name === 'kraken') loadKraken();
  if (name === 'rebalancing') loadRebalancing();
  if (name === 'journal') { loadJournalEntries(); loadJournalStats(); }
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
      (plUsd >= 0 ? '+' : '') + '$' + Math.abs(plUsd).toFixed(2) + ' (' + fmtPct(plPct) + ')',
      plUsd >= 0 ? '#00ff88' : '#ff4444');
    setText('cap-breakeven', '+' + breakEven.toFixed(1) + '% needed', '#ffaa00');

    showEl('pnl-summary-bar');
    var positions = data.positions || [];
    var winners = 0, losers = 0, totalUnreal = 0;
    positions.forEach(function(p) {
      var ep = parseFloat(p.entry_price || 0), cp = parseFloat(p.current_price || 0), qty = parseFloat(p.quantity || 0);
      var pl = (ep && cp && qty) ? (cp - ep) * qty : 0;
      totalUnreal += pl;
      if (pl > 0) winners++; else if (pl < 0) losers++;
    });
    setText('pnl-tracked', positions.length);
    setText('pnl-winners', winners, '#00ff88');
    setText('pnl-losers', losers, '#ff4444');
    setText('pnl-total-unreal', (totalUnreal >= 0 ? '+' : '') + '$' + Math.abs(totalUnreal).toFixed(2), totalUnreal >= 0 ? '#00ff88' : '#ff4444');

    hideEl('tangem-loading'); showEl('tangem-content');
    setText('tangem-value-usd', fmtUSD(tangemVal));
    setText('tangem-xrp-qty', fmtQty(tangemXRP, 2) + ' XRP');
    setText('tangem-address', 'r4E3rtCa4FT4HxTQV2iw3yQHRTrAHMYS3v');
    if (tangemEntry > 0 && tangemPrice > 0) {
      var tPlUsd = tangemXRP * (tangemPrice - tangemEntry);
      var tPlPct = ((tangemPrice - tangemEntry) / tangemEntry * 100);
      setText('tangem-pnl-usd', (tPlUsd >= 0 ? '+' : '') + '$' + Math.abs(tPlUsd).toFixed(2), tPlUsd >= 0 ? '#00ff88' : '#ff4444');
      setText('tangem-pnl-pct', fmtPct(tPlPct), tPlPct >= 0 ? '#00ff88' : '#ff4444');
      setText('tangem-entry-line', 'Entry: $' + tangemEntry.toFixed(4));
    }

    positions.sort(function(a, b) { return parseFloat(b.value_usd || 0) - parseFloat(a.value_usd || 0); });
    var html = '';
    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      var val = parseFloat(pos.value_usd || 0);
      if (val < 1) continue;
      var cp = parseFloat(pos.current_price || 0), ep = parseFloat(pos.entry_price || 0);
      var pl = ep > 0 ? ((cp - ep) / ep * 100) : 0, plc = pl >= 0 ? '#00ff88' : '#ff4444';
      var overnight = parseFloat(pos.change_from_baseline_pct || 0);
      var oColor = overnight >= 0 ? 'pos' : 'neg';
      var entryLine = ep > 0
        ? 'Entry: ' + fmtPrice(ep) + ' | Now: ' + fmtPrice(cp) + ' | <span style="color:' + plc + '">' + fmtPct(pl) + '</span>'
        : 'Now: ' + fmtPrice(cp);
      var hb = parseFloat(pos.historical_basis || 0), histLine = '';
      if (hb > 0 && ep > 0 && Math.abs(hb - ep) > 0.000001) {
        var hpl = ((cp - hb) / hb * 100), hc = hpl >= 0 ? '#00ff88' : '#ff4444';
        histLine = '<br><span style="color:#555;font-size:10px">Hist: ' + fmtPrice(hb) + ' <span style="color:' + hc + '">' + fmtPct(hpl) + '</span></span>';
      }
      var cy = parseInt(pos.cycle_count || 0);
      var cyLine = cy > 0 ? '<br><span style="color:#444;font-size:10px">' + cy + ' cycle(s)</span>' : '';
      html += '<div style="border-left:3px solid ' + plc + ';padding:10px 12px;margin-bottom:8px;background:#1a1a1a;border-radius:4px">'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        + '<span style="color:white;font-weight:bold">' + pos.currency + '</span>'
        + '<div style="text-align:right"><span style="color:white;font-weight:bold">$' + val.toFixed(2) + '</span>'
        + (overnight !== 0 ? '<br><span class="overnight-badge ' + oColor + '" style="font-size:10px">' + (overnight >= 0 ? '+' : '') + overnight.toFixed(1) + '% overnight</span>' : '')
        + '</div></div><div style="font-size:11px;color:#888">' + entryLine + histLine + cyLine + '</div></div>';
    }
    var holdEl = $('holdings-list');
    if (holdEl) holdEl.innerHTML = html || '<div class="empty-state">No positions</div>';
    setText('last-updated', 'Updated ' + new Date().toLocaleTimeString('en-GB'));
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
    alerts.forEach(function(a) {
      html += '<div class="alert-row"><span class="alert-symbol">' + (a.symbol || '?') + '</span>'
        + '<span style="color:#888;font-size:0.8rem">' + (a.type || '') + '</span></div>';
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

function submitKrakenTrade() {
  var symbol = ($('k-symbol') || {}).value || '';
  var side = ($('k-side') || {}).value || 'buy';
  var orderType = ($('k-ordertype') || {}).value || 'market';
  var volume = ($('k-volume') || {}).value || '';
  var price = ($('k-price') || {}).value || '';
  var preview = $('k-trade-preview');
  if (!symbol || !volume) { showToast('Symbol and volume required', true); return; }
  var body = { exchange: 'kraken', symbol: symbol, side: side, order_type: orderType, volume: volume };
  if (orderType === 'limit' && price) body.price = price;
  if (preview) preview.textContent = 'Sending to Telegram...';
  fetch('/api/trade/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r) { return r.json(); }).then(function(d) {
      showToast('Trade sent to Telegram');
      if (preview) preview.textContent = d.message || 'Sent for approval';
    }).catch(function() { showToast('Failed to submit trade', true); });
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

function selectAction(val) {
  document.querySelectorAll('#j-action-group .action-btn').forEach(function(b) {
    b.classList.toggle('selected', b.getAttribute('onclick') && b.getAttribute('onclick').indexOf("'" + val + "'") > -1);
  });
}
function selectEmotion(val) {
  document.querySelectorAll('#j-emotion-group .emotion-btn').forEach(function(b) {
    b.classList.toggle('selected', b.getAttribute('onclick') && b.getAttribute('onclick').indexOf("'" + val + "'") > -1);
  });
}
function selectFollowed(val) {
  document.querySelectorAll('#j-followed-group .action-btn').forEach(function(b) {
    b.classList.toggle('selected', b.getAttribute('onclick') && b.getAttribute('onclick').indexOf("'" + val + "'") > -1);
  });
}

function submitJournalEntry() {
  var coin = ($('j-coin') || {}).value || '';
  var price = parseFloat(($('j-price') || {}).value);
  var qty = parseFloat(($('j-qty') || {}).value) || null;
  var reasoning = ($('j-reasoning') || {}).value || null;
  var actionEl = document.querySelector('#j-action-group .action-btn.selected');
  var emotionEl = document.querySelector('#j-emotion-group .emotion-btn.selected');
  var action = actionEl ? (actionEl.getAttribute('onclick').match(/'([^']+)'/) || [])[1] : null;
  var emotion = emotionEl ? (emotionEl.getAttribute('onclick').match(/'([^']+)'/) || [])[1] : 'neutral';
  if (!coin || !action || !price) { showToast('Coin, action and price required', true); return; }
  fetch('/api/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: coin, action: action, price: price, quantity: qty, reasoning: reasoning, emotion: emotion })
  }).then(function(r) {
    if (r.ok) { showToast('Trade logged'); loadJournalEntries(); loadJournalStats(); }
    else showToast('Failed to log trade', true);
  }).catch(function() { showToast('Failed to log trade', true); });
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

function addPreference() {
  var input = $('pref-input');
  var val = input ? input.value.trim() : '';
  if (!val) return;
  fetch('/api/profile/preference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preference: val }) })
    .then(function(r) {
      if (r.ok) { showToast('Preference saved'); if (input) input.value = ''; loadProfile(); }
      else showToast('Failed', true);
    }).catch(function() { showToast('Failed', true); });
}

// ── Rebalancing ───────────────────────────────────────────────────

function loadRebalancing() {
  fetchData('/api/rebalancing').then(function(data) {
    if (!data) return;
    setText('rb-total-value', fmtUSD(data.total_value));
    setText('rb-total-loss', fmtUSD(data.total_loss));
    setText('rb-recovery-pct', data.recovery_pct != null ? fmtPct(data.recovery_pct) : '—');
    setText('rb-analysis-date', data.analysis_date ? new Date(data.analysis_date).toLocaleDateString() : 'No analysis yet');
    if (data.analysis) setText('rb-analysis-text', data.analysis);
    var h = data.health || {};
    setText('leg-winning', 'Winning — ' + (h.winning || 0));
    setText('leg-small', 'Small loss (0–20%) — ' + (h.small || 0));
    setText('leg-moderate', 'Moderate loss (20–50%) — ' + (h.moderate || 0));
    setText('leg-severe', 'Severe loss (50%+) — ' + (h.severe || 0));
    setText('leg-none', 'No entry set — ' + (h.no_entry || 0));
    setText('pnl-winners', h.winning || 0);
    setText('pnl-losers', (h.small || 0) + (h.moderate || 0) + (h.severe || 0));
    setText('pnl-total-unreal', fmtUSD(data.total_unrealised));
  });
}

function runRebalancingAnalysis() {
  var btn = $('rb-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analysing...'; }
  fetch('/api/rebalancing/analyse', { method: 'POST' }).then(function() {
    showToast('Analysis requested');
    setTimeout(loadRebalancing, 3000);
  }).catch(function() { showToast('Failed', true); })
    .finally(function() { if (btn) { btn.disabled = false; btn.textContent = 'Refresh Analysis'; } });
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

function refreshAll() {
  var spinner = $('spinner');
  if (spinner) spinner.classList.add('active');
  loadPortfolio();
  loadSweep();
  loadAlerts();
  loadMonitorStatus();
  loadTrailingStops();
  if (spinner) setTimeout(function() { spinner.classList.remove('active'); }, 3000);
}

// ── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  console.log('Dashboard v' + DASHBOARD_VERSION + ' initialising');
  refreshAll();
  setInterval(refreshAll, 5 * 60 * 1000);
});
