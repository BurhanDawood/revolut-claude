var DASHBOARD_VERSION = '1.0.7';

window.onerror = function(msg, src, line) {
  var b = document.createElement('div');
  b.style.cssText = 'background:red;color:white;padding:10px;font-size:12px;position:fixed;top:0;left:0;right:0;z-index:9999';
  b.textContent = 'JS Error line ' + line + ': ' + msg;
  document.body.prepend(b);
};

console.log('Dashboard loaded v' + DASHBOARD_VERSION);

function fmt(price) {
  var p = parseFloat(price || 0);
  if (!p) return '$0';
  if (p < 0.000001) return '$' + p.toFixed(10);
  if (p < 0.0001) return '$' + p.toFixed(8);
  if (p < 0.01) return '$' + p.toFixed(6);
  if (p < 1) return '$' + p.toFixed(4);
  return '$' + p.toFixed(2);
}

function fmtQty(qty) {
  var q = parseFloat(qty || 0);
  if (q >= 1000000000) return (q / 1000000000).toFixed(2) + 'B';
  if (q >= 1000000) return (q / 1000000).toFixed(2) + 'M';
  if (q >= 1000) return (q / 1000).toFixed(2) + 'K';
  if (q < 0.000001) return q.toExponential(4);
  return q.toFixed(4);
}

function setEl(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setElHtml(id, val) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = val;
}

function setElColor(id, val, color) {
  var el = document.getElementById(id);
  if (el) { el.textContent = val; el.style.color = color; }
}

function fetchData(url) {
  return fetch(url)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .catch(function(e) {
      console.error('Fetch error:', url, e.message);
      return null;
    });
}

// Tab switching — HTML uses class="tab-content", toggled by .active
function switchTab(name) {
  var tabs = document.querySelectorAll('.tab-btn');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.remove('active');
  }
  var panes = document.querySelectorAll('.tab-content');
  for (var j = 0; j < panes.length; j++) {
    panes[j].classList.remove('active');
  }
  // Mark the clicked button active
  if (event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  }
  var pane = document.getElementById('tab-' + name);
  if (pane) pane.classList.add('active');
  if (name === 'activity') loadActivity('all');
  if (name === 'portfolio') loadPortfolio();
  if (name === 'journal') loadJournal();
}

function filterActivity(filter, el) {
  var btns = document.querySelectorAll('.filter-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.remove('active');
  }
  if (el) el.classList.add('active');
  loadActivity(filter);
}

function loadPortfolio() {
  console.log('[dashboard] loadPortfolio called');
  fetchData('/portfolio/summary').then(function(data) {
    if (!data) {
      console.error('[dashboard] /portfolio/summary returned null');
      setEl('portfolio-value', 'Error');
      return;
    }
    console.log('[dashboard] Portfolio data received');

    // Big total value
    var total = parseFloat(data.grand_total_usd || data.total_value_usd || 0);
    setEl('portfolio-value', '$' + total.toFixed(2));
    setEl('last-updated', 'Updated just now');

    // Capital bar stats
    if (data.invested !== undefined) {
      setEl('cap-invested', '$' + parseFloat(data.invested).toFixed(0));
    }
    if (data.total_value_usd !== undefined) {
      setEl('cap-current', '$' + parseFloat(data.total_value_usd).toFixed(0));
    }
    if (data.pl_usd !== undefined) {
      var plUsd = parseFloat(data.pl_usd);
      var plPct = parseFloat(data.pl_pct || 0);
      var plColor = plUsd >= 0 ? 'var(--accent)' : 'var(--danger)';
      setElColor('cap-pnl',
        (plUsd >= 0 ? '+' : '') + '$' + Math.abs(plUsd).toFixed(0) +
        ' (' + (plPct >= 0 ? '+' : '') + plPct.toFixed(1) + '%)',
        plColor);
    }
    if (data.break_even_pct !== undefined) {
      setEl('cap-breakeven', '+' + parseFloat(data.break_even_pct).toFixed(1) + '%');
    }

    // Portfolio totals breakdown
    var totalsEl = document.getElementById('portfolio-totals');
    if (totalsEl) totalsEl.style.display = '';

    // Holdings list
    var holdingsEl = document.getElementById('holdings-list');
    if (!holdingsEl) return;

    var positions = data.positions || [];
    positions.sort(function(a, b) {
      return parseFloat(b.value_usd || 0) - parseFloat(a.value_usd || 0);
    });

    var html = '';
    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      var val = parseFloat(pos.value_usd || 0);
      if (val < 1 && pos.status !== 'sold') continue;

      var cp = parseFloat(pos.current_price || 0);
      var ep = parseFloat(pos.entry_price || 0);
      var pl = ep > 0 ? ((cp - ep) / ep * 100) : 0;
      var plColor = pl >= 0 ? '#00ff88' : '#ff4444';
      var isSold = pos.status === 'sold';

      var entryLine = '';
      if (ep > 0) {
        entryLine = 'Entry: ' + fmt(ep) + ' | Now: ' + fmt(cp) +
          ' | <span style="color:' + plColor + '">' +
          (pl >= 0 ? '+' : '') + pl.toFixed(1) + '%</span>';
        var hb = parseFloat(pos.historical_basis || 0);
        if (hb > 0 && Math.abs(hb - ep) > 0.000001) {
          var hpl = ((cp - hb) / hb * 100);
          var hc = hpl >= 0 ? '#00ff88' : '#ff4444';
          entryLine += '<br><span style="color:#555;font-size:10px">Hist: ' + fmt(hb) +
            ' <span style="color:' + hc + '">' + (hpl >= 0 ? '+' : '') + hpl.toFixed(1) + '%</span></span>';
        }
      }

      html += '<div style="border-left:3px solid ' + (isSold ? '#444' : plColor) + ';' +
        'padding:10px 12px;margin-bottom:8px;background:var(--surface2);border-radius:8px;' +
        (isSold ? 'opacity:0.45;' : '') + '">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
        '<span style="font-weight:600">' + pos.currency +
        (isSold ? ' <span style="font-size:9px;color:#555">[SOLD]</span>' : '') + '</span>' +
        '<span style="font-weight:600">' + (isSold ? '' : '$' + val.toFixed(2)) + '</span></div>' +
        (entryLine ? '<div style="font-size:11px;color:var(--text-muted)">' + entryLine + '</div>' : '') +
        '</div>';
    }

    holdingsEl.innerHTML = html || '<p style="color:var(--text-muted)">No positions found</p>';
  });
}

function loadActivity(filter) {
  filter = filter || 'all';
  var feedEl = document.getElementById('activity-feed');
  if (!feedEl) return;
  feedEl.innerHTML = '<p style="color:var(--text-muted)">Loading...</p>';

  fetchData('/api/activity?limit=50&filter=' + encodeURIComponent(filter)).then(function(data) {
    if (!data || !data.trades || !data.trades.length) {
      feedEl.innerHTML = '<p style="color:var(--text-muted)">No activity yet</p>';
      return;
    }

    var colors = { buy: '#00ff88', sell: '#ff4444', payment: '#ffaa00', transfer: '#888', sweep: '#4488ff' };
    var html = '';
    for (var i = 0; i < data.trades.length; i++) {
      var t = data.trades[i];
      var col = colors[t.action] || '#888';
      var date = new Date(t.created_at);
      var dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) +
        ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var qty = parseFloat(t.quantity || 0);
      var qs = qty >= 1000000 ? (qty / 1000000).toFixed(2) + 'M'
        : qty >= 1000 ? (qty / 1000).toFixed(2) + 'K' : qty.toFixed(4);
      var val = t.value_usd ? ' = $' + parseFloat(t.value_usd).toFixed(2) : '';
      var pnl = t.outcome_pnl ? parseFloat(t.outcome_pnl) : null;
      var pnlStr = pnl !== null
        ? '<span style="color:' + (pnl >= 0 ? '#00ff88' : '#ff4444') + ';margin-left:8px;font-size:11px">' +
          (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2) + '</span>'
        : '';

      html += '<div style="border-left:3px solid ' + col +
        ';padding:10px 12px;margin-bottom:8px;background:var(--surface2);border-radius:8px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
        '<div><span style="color:' + col + ';font-weight:700;font-size:11px;text-transform:uppercase">' +
        t.action + '</span><span style="font-weight:600;margin-left:6px">' + t.symbol + '</span>' + pnlStr + '</div>' +
        '<span style="color:var(--text-muted);font-size:11px">' + dateStr + '</span></div>' +
        '<div style="color:var(--text-muted);font-size:12px;margin-bottom:4px">' + qs + ' @ ' + fmt(t.price) + val + '</div>' +
        '<div style="color:#666;font-size:11px">' + (t.reasoning || 'No reason logged') + '</div>' +
        '</div>';
    }
    feedEl.innerHTML = html;
  });
}

function loadJournal() {
  var el = document.getElementById('journal-entries-list');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text-muted)">Loading...</p>';
  fetchData('/api/activity?limit=20').then(function(data) {
    if (!data || !data.trades) { el.innerHTML = '<p style="color:var(--text-muted)">No data</p>'; return; }
    var trades = data.trades.filter(function(t) { return t.action === 'buy' || t.action === 'sell'; });
    if (!trades.length) { el.innerHTML = '<p style="color:var(--text-muted)">No trades yet</p>'; return; }
    var html = '';
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      var col = t.action === 'buy' ? '#00ff88' : '#ff4444';
      var date = new Date(t.created_at).toLocaleDateString('en-GB');
      html += '<div style="padding:10px;margin-bottom:8px;background:var(--surface2);border-radius:8px;border-left:3px solid ' + col + '">' +
        '<div style="font-weight:600">' + t.symbol + ' ' + t.action.toUpperCase() +
        ' <span style="color:var(--text-muted);font-size:11px">' + date + '</span></div>' +
        '<div style="color:var(--text-muted);font-size:11px;margin-top:4px">' + (t.reasoning || 'No reasoning') + '</div>' +
        '</div>';
    }
    el.innerHTML = html;
  });
}

document.addEventListener('DOMContentLoaded', function() {
  console.log('[dashboard] DOMContentLoaded — starting loadPortfolio');
  loadPortfolio();
  setInterval(loadPortfolio, 300000);
});
