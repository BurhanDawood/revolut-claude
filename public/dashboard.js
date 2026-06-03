var DASHBOARD_VERSION = '1.0.6';

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

function showTab(name, el) {
  var tabs = document.querySelectorAll('.tab-btn');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.remove('active');
  }
  var panes = document.querySelectorAll('.tab-pane');
  for (var j = 0; j < panes.length; j++) {
    panes[j].style.display = 'none';
  }
  if (el) el.classList.add('active');
  var pane = document.getElementById('tab-' + name);
  if (pane) pane.style.display = 'block';
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
  fetchData('/portfolio/summary').then(function(data) {
    if (!data) {
      var el = document.getElementById('total-value');
      if (el) el.textContent = 'Error loading';
      return;
    }

    var totalEl = document.getElementById('total-value');
    if (totalEl) {
      totalEl.textContent = '$' + parseFloat(
        data.grand_total_usd || data.total_value_usd || 0
      ).toFixed(2);
    }

    var invEl = document.getElementById('invested');
    if (invEl && data.invested) {
      invEl.textContent = '$' + parseFloat(data.invested).toFixed(2);
    }

    var plUsdEl = document.getElementById('pl-usd');
    if (plUsdEl && data.pl_usd !== undefined) {
      var plUsd = parseFloat(data.pl_usd);
      plUsdEl.textContent = (plUsd >= 0 ? '+' : '') + '$' + Math.abs(plUsd).toFixed(2);
      plUsdEl.style.color = plUsd >= 0 ? '#00ff88' : '#ff4444';
    }

    var plPctEl = document.getElementById('pl-pct');
    if (plPctEl && data.pl_pct !== undefined) {
      var plPct = parseFloat(data.pl_pct);
      plPctEl.textContent = (plPct >= 0 ? '+' : '') + plPct.toFixed(1) + '%';
      plPctEl.style.color = plPct >= 0 ? '#00ff88' : '#ff4444';
    }

    var breakEl = document.getElementById('break-even');
    if (breakEl && data.break_even_pct) {
      breakEl.textContent = '+' + parseFloat(data.break_even_pct).toFixed(1) + '%';
    }

    var cashEl = document.getElementById('cash-available');
    if (cashEl && data.cash_available) {
      var c = data.cash_available;
      cashEl.textContent = '$' + parseFloat(c.total_cash || c.revolut_usd || 0).toFixed(2);
    }

    var sweepEl = document.getElementById('usdt-reserve');
    if (sweepEl && data.usdt_reserve !== undefined) {
      sweepEl.textContent = '$' + parseFloat(data.usdt_reserve).toFixed(2);
    }

    var tangemEl = document.getElementById('tangem-value');
    if (tangemEl) {
      if (data.tangem && data.tangem.valueUSD) {
        tangemEl.textContent = '$' + parseFloat(data.tangem.valueUSD).toFixed(2);
      } else {
        tangemEl.textContent = 'Unavailable';
      }
    }

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
      var borderColor = pl >= 0 ? '#00ff88' : '#ff4444';
      var isSold = pos.status === 'sold';

      var entryLine = '';
      if (ep > 0) {
        entryLine = 'Entry: ' + fmt(ep) +
          ' | Now: ' + fmt(cp) +
          ' | <span style="color:' + plColor + '">' +
          (pl >= 0 ? '+' : '') + pl.toFixed(1) + '%</span>';

        var hb = parseFloat(pos.historical_basis || 0);
        if (hb > 0 && Math.abs(hb - ep) > 0.000001) {
          var hpl = ((cp - hb) / hb * 100);
          var hc = hpl >= 0 ? '#00ff88' : '#ff4444';
          entryLine += '<br><span style="color:#555;font-size:10px">Hist basis: ' + fmt(hb) +
            ' <span style="color:' + hc + '">' + (hpl >= 0 ? '+' : '') + hpl.toFixed(1) + '%</span></span>';
        }
      }

      var cardStyle = isSold
        ? 'opacity:0.4;border-left:3px solid #444;'
        : 'border-left:3px solid ' + borderColor + ';';

      html += '<div style="' + cardStyle + 'padding:10px 12px;margin-bottom:8px;background:#1a1a1a;border-radius:4px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
        '<span style="color:' + (isSold ? '#555' : 'white') + ';font-weight:bold">' + pos.currency +
        (isSold ? ' <span style="font-size:9px;color:#444">[SOLD]</span>' : '') + '</span>' +
        '<span style="color:' + (isSold ? '#555' : 'white') + ';font-weight:bold">' +
        (isSold ? '' : '$' + val.toFixed(2)) + '</span></div>' +
        '<div style="font-size:11px;color:#888">' + entryLine + '</div>' +
        '</div>';
    }

    holdingsEl.innerHTML = html || '<p style="color:#888">No positions</p>';
  });
}

function loadActivity(filter) {
  filter = filter || 'all';
  var feedEl = document.getElementById('activity-feed');
  if (!feedEl) return;
  feedEl.innerHTML = '<p style="color:#888">Loading...</p>';

  fetchData('/api/activity?limit=50&filter=' + encodeURIComponent(filter)).then(function(data) {
    if (!data || !data.trades || !data.trades.length) {
      feedEl.innerHTML = '<p style="color:#888">No activity yet</p>';
      return;
    }

    var colors = {
      buy: '#00ff88', sell: '#ff4444',
      payment: '#ffaa00', transfer: '#888888',
      sweep: '#4488ff', rebalance: '#aa44ff'
    };

    var html = '';
    for (var i = 0; i < data.trades.length; i++) {
      var t = data.trades[i];
      var color = colors[t.action] || '#888';
      var date = new Date(t.created_at);
      var dateStr = date.toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit'
      });
      var qty = parseFloat(t.quantity || 0);
      var qtyStr = qty >= 1000000
        ? (qty / 1000000).toFixed(2) + 'M'
        : qty >= 1000
        ? (qty / 1000).toFixed(2) + 'K'
        : qty.toFixed(4);
      var val = t.value_usd ? '$' + parseFloat(t.value_usd).toFixed(2) : '';
      var pnl = t.outcome_pnl ? parseFloat(t.outcome_pnl) : null;
      var pnlStr = pnl !== null
        ? '<span style="color:' + (pnl >= 0 ? '#00ff88' : '#ff4444') +
          ';margin-left:8px;font-size:11px">' +
          (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2) + '</span>'
        : '';

      html += '<div style="border-left:3px solid ' + color +
        ';padding:10px 12px;margin-bottom:8px;background:#1a1a1a;border-radius:4px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
        '<div><span style="color:' + color + ';font-weight:bold;font-size:11px;text-transform:uppercase">' +
        t.action + '</span><span style="color:white;font-weight:bold;margin-left:6px">' +
        t.symbol + '</span>' + pnlStr + '</div>' +
        '<span style="color:#666;font-size:11px">' + dateStr + '</span></div>' +
        '<div style="color:#aaa;font-size:12px;margin-bottom:4px">' +
        qtyStr + ' @ ' + fmt(t.price) + (val ? ' = ' + val : '') + '</div>' +
        '<div style="color:#666;font-size:11px">' + (t.reasoning || 'No reason logged') + '</div>' +
        '</div>';
    }

    feedEl.innerHTML = html;
  });
}

function loadJournal() {
  var el = document.getElementById('journal-list');
  if (!el) return;
  el.innerHTML = '<p style="color:#888">Loading...</p>';
  fetchData('/api/activity?limit=20&filter=all').then(function(data) {
    if (!data || !data.trades) {
      el.innerHTML = '<p style="color:#888">No data</p>';
      return;
    }
    var trades = data.trades.filter(function(t) {
      return t.action === 'buy' || t.action === 'sell';
    });
    if (!trades.length) {
      el.innerHTML = '<p style="color:#888">No trades yet</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      var color = t.action === 'buy' ? '#00ff88' : '#ff4444';
      var date = new Date(t.created_at).toLocaleDateString('en-GB');
      html += '<div style="padding:10px;margin-bottom:8px;background:#1a1a1a;border-radius:4px;border-left:3px solid ' + color + '">' +
        '<div style="color:white;font-weight:bold">' + t.symbol + ' ' + t.action.toUpperCase() +
        ' <span style="color:#666;font-size:11px">' + date + '</span></div>' +
        '<div style="color:#aaa;font-size:11px;margin-top:4px">' + (t.reasoning || 'No reasoning') + '</div>' +
        '</div>';
    }
    el.innerHTML = html;
  });
}

function saveSweepConfig() {
  var pct = document.getElementById('sweep-pct');
  var min = document.getElementById('sweep-min');
  var enabled = document.getElementById('sweep-enabled');
  if (!pct || !min) return;
  fetch('/api/sweep/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sweep_pct: parseFloat(pct.value),
      min_trade_value_usd: parseFloat(min.value),
      enabled: enabled ? enabled.checked : true
    })
  }).then(function(r) {
    if (r.ok) alert('Sweep config saved');
  }).catch(function(e) {
    console.error('Save sweep error:', e);
  });
}

document.addEventListener('DOMContentLoaded', function() {
  console.log('DOM ready — loading portfolio');
  loadPortfolio();
  setInterval(loadPortfolio, 300000);
});
