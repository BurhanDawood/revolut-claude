// dashboard.js — v2.0.0
// Atomic rewrite — all element IDs matched exactly to dashboard.html
// ─────────────────────────────────────────────────────────────────

const API = '';          // same origin
let refreshTimer = null;
let monitorPaused = false;

// ── Helpers ───────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function fmt(n, dp = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtUSD(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-$' : '$') + str;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}

function colorClass(n) {
  if (n == null || isNaN(n)) return '';
  return n >= 0 ? 'positive' : 'negative';
}

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val ?? '—';
}

function setHTML(id, val) {
  const el = $(id);
  if (el) el.innerHTML = val ?? '';
}

function showToast(msg, isError = false) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast ' + (isError ? 'error' : 'success') + ' show';
  setTimeout(() => t.className = 'toast', 3000);
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Tab switching ─────────────────────────────────────────────────

function initTabs() {
  const tabs = ['tab-portfolio', 'tab-activity', 'tab-journal', 'tab-rebalancing', 'tab-kraken'];
  tabs.forEach(tabId => {
    const el = $(tabId);
    if (!el) return;
    el.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      el.classList.add('active');
      const panelId = tabId.replace('tab-', 'panel-');
      const panel = $(panelId);
      if (panel) panel.classList.add('active');
    });
  });
}

// ── Portfolio summary (Revolut X) ─────────────────────────────────

async function loadPortfolioSummary() {
  try {
    const res = await fetch(`${API}/api/portfolio`);
    const data = await res.json();

    // Holdings list
    const holdings = data.holdings || data.balances || [];
    const holdingsEl = $('holdings-list');
    if (holdingsEl) {
      if (holdings.length === 0) {
        holdingsEl.innerHTML = '<p class="muted">No holdings found.</p>';
      } else {
        holdingsEl.innerHTML = holdings.map(h => {
          const pnlPct = h.pnl_pct ?? h.pnlPct ?? null;
          const pnlUsd = h.pnl_usd ?? h.pnlUsd ?? null;
          const cls = colorClass(pnlPct);
          return `
            <div class="holding-row">
              <span class="coin">${h.symbol ?? h.coin ?? '?'}</span>
              <span class="value">${fmtUSD(h.value_usd ?? h.valueUsd)}</span>
              <span class="qty muted">${fmt(h.quantity ?? h.qty, 4)}</span>
              <span class="pnl ${cls}">${fmtPct(pnlPct)}</span>
              <span class="pnl-usd ${cls}">${fmtUSD(pnlUsd)}</span>
            </div>`;
        }).join('');
      }
    }

    // Portfolio value (top-level)
    const totalValue = data.total_value ?? data.totalValue ?? data.total ?? null;
    setText('portfolio-value', totalValue != null ? fmtUSD(totalValue) : '—');

    // Revolut subtotals
    setText('revolut-crypto-subtotal', fmtUSD(data.crypto_value ?? data.cryptoValue));
    setText('revolut-cash-subtotal', fmtUSD(data.cash_value ?? data.cashValue ?? data.usd_balance ?? data.usdBalance));

    // Last updated
    setText('last-updated', timeAgo(data.last_updated ?? data.lastUpdated ?? new Date().toISOString()));

  } catch (e) {
    console.error('loadPortfolioSummary:', e);
    setText('portfolio-value', 'Error');
  }
}

// ── Full portfolio data (all accounts) ───────────────────────────

async function loadPortfolioData() {
  try {
    const res = await fetch(`${API}/api/portfolio/all`);
    const data = await res.json();

    // Portfolio totals panel
    const revolut  = data.revolut  ?? {};
    const kraken   = data.kraken   ?? {};
    const tangem   = data.tangem   ?? {};
    const totals   = data.totals   ?? {};

    setText('revolut-crypto-subtotal', fmtUSD(revolut.crypto ?? revolut.crypto_value));
    setText('revolut-cash-subtotal',   fmtUSD(revolut.cash  ?? revolut.cash_value));
    setText('kraken-crypto-subtotal',  fmtUSD(kraken.crypto ?? kraken.crypto_value));
    setText('kraken-cash-subtotal',    fmtUSD(kraken.cash   ?? kraken.cash_value));
    setText('tangem-subtotal',         fmtUSD(tangem.value  ?? tangem.value_usd));
    setText('portfolio-crypto-sum',    fmtUSD(totals.crypto ?? totals.total_crypto));
    setText('portfolio-cash-sum',      fmtUSD(totals.cash   ?? totals.total_cash));
    setText('portfolio-total-sum',     fmtUSD(totals.total  ?? totals.grand_total));

    // Capital panel
    const capital = data.capital ?? {};
    const invested = capital.invested ?? data.invested_capital ?? null;
    const current  = capital.current  ?? totals.total ?? null;
    const pnl      = (current != null && invested != null) ? current - invested : null;
    const pnlPct   = (pnl != null && invested) ? (pnl / invested) * 100 : null;
    const breakeven = (pnl != null && current) ? ((invested - current) / current) * 100 : null;

    setText('cap-invested', fmtUSD(invested));
    setText('cap-current',  fmtUSD(current));

    const pnlEl = $('cap-pnl');
    if (pnlEl) {
      pnlEl.textContent = pnl != null ? `${fmtUSD(pnl)} (${fmtPct(pnlPct)})` : '—';
      pnlEl.className = colorClass(pnl);
    }
    setText('cap-breakeven', breakeven != null ? fmtPct(breakeven) : '—');

    // Tangem panel
    loadTangem(tangem);

  } catch (e) {
    console.error('loadPortfolioData:', e);
  }
}

// ── Tangem panel ─────────────────────────────────────────────────

function loadTangem(data) {
  const loading = $('tangem-loading');
  const content = $('tangem-content');
  if (loading) loading.style.display = 'none';
  if (content) content.style.display = '';

  setText('tangem-xrp-qty',   fmt(data.xrp_qty   ?? data.quantity, 4));
  setText('tangem-value-usd', fmtUSD(data.value   ?? data.value_usd));
  setText('tangem-address',   data.address ?? 'r4E3rtCa4FT4HxTQV2iw3yQHRTrAHMYS3v');

  const pnlUsd = data.pnl_usd ?? data.pnl ?? null;
  const pnlPct = data.pnl_pct ?? null;
  const pnlUsdEl = $('tangem-pnl-usd');
  const pnlPctEl = $('tangem-pnl-pct');
  if (pnlUsdEl) { pnlUsdEl.textContent = fmtUSD(pnlUsd); pnlUsdEl.className = colorClass(pnlUsd); }
  if (pnlPctEl) { pnlPctEl.textContent = fmtPct(pnlPct); pnlPctEl.className = colorClass(pnlPct); }

  const entryEl = $('tangem-entry-line');
  if (entryEl && data.entry_price) {
    entryEl.textContent = `Entry: $${fmt(data.entry_price, 4)}`;
  }
}

// ── USDT Sweep panel ──────────────────────────────────────────────

async function loadSweep() {
  const loading = $('sweep-loading');
  const content = $('sweep-content');
  try {
    const res = await fetch(`${API}/api/sweep/config`);
    const data = await res.json();
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = '';

    const toggle = $('sweep-enabled-toggle');
    if (toggle) toggle.checked = data.enabled ?? false;

    const pctEl = $('sweep-pct-input');
    if (pctEl) pctEl.value = data.sweep_pct ?? 20;

    const minEl = $('sweep-min-input');
    if (minEl) minEl.value = data.min_trade_value_usd ?? 50;

    const labelEl = $('sweep-status-label');
    if (labelEl) labelEl.textContent = data.enabled ? 'Auto-sweep ON' : 'Auto-sweep OFF';

    setText('sweep-usdt-balance', fmtUSD(data.usdt_balance ?? data.usdtBalance));
  } catch (e) {
    console.error('loadSweep:', e);
    if (loading) loading.textContent = 'Failed to load sweep config.';
  }
}

async function saveSweep() {
  const enabled = $('sweep-enabled-toggle')?.checked ?? false;
  const sweep_pct = parseFloat($('sweep-pct-input')?.value ?? 20);
  const min_trade_value_usd = parseFloat($('sweep-min-input')?.value ?? 50);
  try {
    await fetch(`${API}/api/sweep/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, sweep_pct, min_trade_value_usd })
    });
    showToast('Sweep config saved ✅');
    loadSweep();
  } catch (e) {
    showToast('Failed to save sweep config', true);
  }
}

// ── Alerts ────────────────────────────────────────────────────────

async function loadAlerts() {
  try {
    const res = await fetch(`${API}/api/alerts`);
    const data = await res.json();
    const alerts = data.alerts ?? data ?? [];
    const el = $('alerts-list');
    if (!el) return;
    if (alerts.length === 0) {
      el.innerHTML = '<p class="muted">None</p>';
      return;
    }
    el.innerHTML = alerts.map(a => `
      <div class="alert-row">
        <span class="coin">${a.symbol ?? a.coin}</span>
        <span class="type muted">${a.type ?? ''}</span>
        <span class="value">${a.value != null ? fmtUSD(a.value) : (a.pct != null ? fmtPct(a.pct) : '—')}</span>
        <span class="status ${a.status}">${a.status ?? ''}</span>
      </div>`).join('');
  } catch (e) {
    console.error('loadAlerts:', e);
  }
}

// ── Trailing stops ────────────────────────────────────────────────

async function loadTrailingStops() {
  try {
    const res = await fetch(`${API}/api/trailing-stops`);
    const data = await res.json();
    const stops = data.stops ?? data ?? [];
    const summaryEl = $('trail-summary');
    const listEl    = $('trail-summary-list');

    if (summaryEl) summaryEl.textContent = `${stops.length} active`;
    if (!listEl) return;

    if (stops.length === 0) {
      listEl.innerHTML = '<p class="muted">No trailing stops active.</p>';
      return;
    }
    listEl.innerHTML = stops.map(s => `
      <div class="trail-row">
        <span class="coin">${s.symbol ?? s.coin}</span>
        <span>${s.trail_pct ?? s.trailPct ?? '—'}%</span>
        <span class="muted">High: ${fmtUSD(s.high_price ?? s.highPrice)}</span>
        <span class="muted">Stop: ${fmtUSD(s.stop_price ?? s.stopPrice)}</span>
      </div>`).join('');
  } catch (e) {
    console.error('loadTrailingStops:', e);
  }
}

// ── Thresholds ────────────────────────────────────────────────────

async function loadThresholds() {
  try {
    const res = await fetch(`${API}/api/thresholds`);
    const data = await res.json();
    const thresholds = data.thresholds ?? data ?? [];
    const el = $('threshold-list');
    if (!el) return;
    if (thresholds.length === 0) {
      el.innerHTML = '<p class="muted">No custom thresholds set.</p>';
      return;
    }
    el.innerHTML = thresholds.map(t => `
      <div class="threshold-row">
        <span class="coin">${t.symbol ?? t.coin}</span>
        <span>${t.threshold_pct ?? t.pct ?? '—'}%</span>
      </div>`).join('');
  } catch (e) {
    console.error('loadThresholds:', e);
  }
}

// ── Kraken panel ──────────────────────────────────────────────────

async function loadKraken() {
  try {
    const res = await fetch(`${API}/api/kraken/portfolio`);
    const data = await res.json();
    const statusEl = $('kraken-status');
    if (statusEl) {
      statusEl.textContent = data.connected ? 'Connected ✅' : 'Disconnected ❌';
    }
    setText('kraken-total',          fmtUSD(data.total ?? data.total_value));
    setText('kraken-crypto-subtotal', fmtUSD(data.crypto ?? data.crypto_value));
    setText('kraken-cash-subtotal',   fmtUSD(data.cash  ?? data.cash_value));

    const holdingsEl = $('kraken-holdings');
    if (!holdingsEl) return;
    const holdings = data.holdings ?? data.balances ?? [];
    if (holdings.length === 0) {
      holdingsEl.innerHTML = '<p class="muted">No Kraken holdings.</p>';
      return;
    }
    holdingsEl.innerHTML = holdings.map(h => {
      const pnlPct = h.pnl_pct ?? h.pnlPct ?? null;
      const pnlUsd = h.pnl_usd ?? h.pnlUsd ?? null;
      const cls = colorClass(pnlPct);
      return `
        <div class="holding-row">
          <span class="coin">${h.symbol ?? h.coin ?? '?'}</span>
          <span class="value">${fmtUSD(h.value_usd ?? h.valueUsd)}</span>
          <span class="qty muted">${fmt(h.quantity ?? h.qty, 4)}</span>
          <span class="pnl ${cls}">${fmtPct(pnlPct)}</span>
          <span class="pnl-usd ${cls}">${fmtUSD(pnlUsd)}</span>
        </div>`;
    }).join('');
  } catch (e) {
    console.error('loadKraken:', e);
    setText('kraken-status', 'Error loading Kraken data');
  }
}

// ── Kraken trade form ─────────────────────────────────────────────

async function submitKrakenTrade() {
  const symbol    = $('k-symbol')?.value?.trim();
  const side      = $('k-side')?.value;
  const orderType = $('k-ordertype')?.value;
  const volume    = $('k-volume')?.value?.trim();
  const price     = $('k-price')?.value?.trim();
  const preview   = $('k-trade-preview');

  if (!symbol || !volume) { showToast('Symbol and volume required', true); return; }

  const body = { exchange: 'kraken', symbol, side, order_type: orderType, volume };
  if (orderType === 'limit' && price) body.price = price;

  if (preview) {
    preview.textContent = `Sending to Telegram: ${side.toUpperCase()} ${volume} ${symbol} (${orderType})…`;
  }

  try {
    const res = await fetch(`${API}/api/trade/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (preview) preview.textContent = data.message ?? 'Trade request sent to Telegram ✅';
    showToast('Trade sent to Telegram for approval ✅');
  } catch (e) {
    showToast('Failed to submit trade', true);
    if (preview) preview.textContent = 'Error submitting trade.';
  }
}

// ── Activity feed ─────────────────────────────────────────────────

let activityFilter = 'all';

async function loadActivityFeed(filter = activityFilter) {
  activityFilter = filter;
  // Highlight active filter button
  ['all', 'sells', 'buys', 'payments', 'transfers'].forEach(f => {
    const btn = document.querySelector(`[data-filter="${f}"]`);
    if (btn) btn.classList.toggle('active', f === filter);
  });

  try {
    const url = filter === 'all' ? `${API}/api/activity` : `${API}/api/activity?type=${filter}`;
    const res = await fetch(url);
    const data = await res.json();
    const entries = data.entries ?? data.activity ?? data ?? [];
    const el = $('activity-feed');
    if (!el) return;
    if (entries.length === 0) {
      el.innerHTML = '<p class="muted">No activity yet.</p>';
      return;
    }
    el.innerHTML = entries.map(e => `
      <div class="activity-row" data-id="${e.id ?? ''}">
        <span class="activity-date muted">${new Date(e.created_at ?? e.date ?? '').toLocaleDateString()}</span>
        <span class="activity-coin coin">${e.symbol ?? e.coin ?? '?'}</span>
        <span class="activity-type tag ${e.type}">${e.type ?? ''}</span>
        <span class="activity-value">${fmtUSD(e.value_usd ?? e.amount_usd ?? e.amount)}</span>
        <span class="activity-reason muted">${e.reason ?? ''}</span>
        <button class="btn-sm" onclick="editActivity(${e.id})">Edit</button>
      </div>`).join('');
  } catch (e) {
    console.error('loadActivityFeed:', e);
  }
}

async function editActivity(id) {
  const reason = prompt('Update reason/type for this entry:');
  if (!reason) return;
  try {
    await fetch(`${API}/api/activity/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    showToast('Entry updated ✅');
    loadActivityFeed();
  } catch (e) {
    showToast('Failed to update entry', true);
  }
}

// ── Journal ───────────────────────────────────────────────────────

async function loadJournalEntries() {
  try {
    const res = await fetch(`${API}/api/journal?limit=20`);
    const data = await res.json();
    const entries = data.entries ?? data ?? [];
    const el = $('journal-entries-list');
    if (!el) return;
    if (entries.length === 0) {
      el.innerHTML = '<p class="muted">No journal entries yet.</p>';
      return;
    }
    el.innerHTML = entries.map(e => `
      <div class="journal-row">
        <span class="coin">${e.symbol ?? e.coin}</span>
        <span class="tag ${e.action?.toLowerCase()}">${e.action}</span>
        <span>${fmtUSD(e.price)}</span>
        <span class="muted">${e.quantity ? fmt(e.quantity, 4) : ''}</span>
        <span class="muted">${e.reasoning ?? ''}</span>
        <span class="emotion muted">${e.emotion ?? ''}</span>
        <span class="date muted">${timeAgo(e.created_at ?? e.date)}</span>
      </div>`).join('');
  } catch (e) {
    console.error('loadJournalEntries:', e);
  }
}

async function submitJournalEntry() {
  const coin     = $('j-coin')?.value?.trim();
  const price    = parseFloat($('j-price')?.value);
  const qty      = parseFloat($('j-qty')?.value) || null;
  const reasoning = $('j-reasoning')?.value?.trim() || null;

  const actionEl  = document.querySelector('#j-action-group .selected, #j-action-group button.active');
  const emotionEl = document.querySelector('#j-emotion-group .selected, #j-emotion-group button.active');
  const followedEl = document.querySelector('#j-followed-group .selected, #j-followed-group button.active');

  const action   = actionEl?.dataset?.value  ?? actionEl?.textContent?.trim();
  const emotion  = emotionEl?.dataset?.value ?? emotionEl?.textContent?.trim();
  const followed = followedEl?.dataset?.value ?? null;

  if (!coin || !action || !price) { showToast('Coin, action and price required', true); return; }

  try {
    await fetch(`${API}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: coin, action, price, quantity: qty, reasoning, emotion, followed_claude: followed })
    });
    showToast('Trade logged ✅');
    loadJournalEntries();
    loadJournalStats();
  } catch (e) {
    showToast('Failed to log trade', true);
  }
}

async function loadJournalStats() {
  try {
    const res = await fetch(`${API}/api/journal/stats`);
    const s = await res.json();
    setText('j-win-rate',    s.win_rate   != null ? s.win_rate.toFixed(1) + '%' : '—');
    setText('j-total-trades', s.total_trades ?? '—');
    setText('j-avg-profit',  s.avg_profit  != null ? fmtPct(s.avg_profit) : '—');
    setText('j-claude-acc',  s.claude_accuracy != null ? s.claude_accuracy.toFixed(1) + '%' : '—');
  } catch (e) {
    console.error('loadJournalStats:', e);
  }
}

// ── Trader profile / preferences ──────────────────────────────────

async function loadProfile() {
  try {
    const res = await fetch(`${API}/api/profile`);
    const data = await res.json();
    const prefs = data.preferences ?? data ?? [];
    const el = $('profile-list');
    if (!el) return;
    if (!prefs.length) {
      el.innerHTML = '<p class="muted">No preferences saved yet.</p>';
      return;
    }
    el.innerHTML = prefs.map(p => `
      <div class="pref-row">
        <span>${p.key ?? p.preference}</span>
        <span class="muted">${p.value}</span>
      </div>`).join('');

    const learningEl = $('learning-text');
    if (learningEl && data.learning_model) {
      learningEl.textContent = data.learning_model;
    }
  } catch (e) {
    console.error('loadProfile:', e);
  }
}

async function savePreference() {
  const val = $('pref-input')?.value?.trim();
  if (!val) return;
  try {
    await fetch(`${API}/api/profile/preference`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preference: val })
    });
    showToast('Preference saved ✅');
    $('pref-input').value = '';
    loadProfile();
  } catch (e) {
    showToast('Failed to save preference', true);
  }
}

// ── Rebalancing ───────────────────────────────────────────────────

async function loadRebalancing() {
  try {
    const res = await fetch(`${API}/api/rebalancing`);
    const data = await res.json();

    // Stats
    setText('rebal-accuracy-pct', data.accuracy_pct != null ? data.accuracy_pct.toFixed(1) + '%' : '—');
    setText('rebal-accuracy-sub', data.accuracy_decisions != null ? `${data.accuracy_decisions} decisions` : '—');
    setText('rebal-avg-pnl',      data.avg_7d_gain != null ? fmtPct(data.avg_7d_gain) : '—');

    const bar = $('rebal-accuracy-bar');
    if (bar) bar.style.width = (data.accuracy_pct ?? 0) + '%';

    // Tracker table
    const trackerBody = $('rebal-tracker-body');
    if (trackerBody) {
      const rows = data.history ?? [];
      trackerBody.innerHTML = rows.length === 0
        ? '<tr><td colspan="6" class="muted">No rebalances logged yet</td></tr>'
        : rows.map(r => `
            <tr>
              <td>${new Date(r.date ?? r.created_at).toLocaleDateString()}</td>
              <td>${r.sold ?? '—'}</td>
              <td>${r.bought ?? '—'}</td>
              <td class="${colorClass(r.result_7d)}">${fmtPct(r.result_7d)}</td>
              <td class="${colorClass(r.result_30d)}">${fmtPct(r.result_30d)}</td>
              <td class="tag ${r.outcome?.toLowerCase()}">${r.outcome ?? '—'}</td>
            </tr>`).join('');
    }

    // Portfolio health donut legend
    const health = data.health ?? {};
    setText('leg-winning',  health.winning  ?? 0);
    setText('leg-small',    health.small    ?? 0);
    setText('leg-moderate', health.moderate ?? 0);
    setText('leg-severe',   health.severe   ?? 0);
    setText('leg-none',     health.no_entry ?? 0);

    // Rebalancing analysis panel
    setText('rb-total-value',   fmtUSD(data.total_value));
    setText('rb-total-loss',    fmtUSD(data.total_loss));
    setText('rb-recovery-pct',  data.recovery_pct != null ? fmtPct(data.recovery_pct) : '—');
    setText('rb-analysis-date', data.analysis_date ? new Date(data.analysis_date).toLocaleDateString() : '—');

    const analysisText = $('rb-analysis-text');
    if (analysisText && data.analysis) {
      analysisText.textContent = data.analysis;
    }

    // Positions table
    const posBody = $('rb-positions-body');
    if (posBody) {
      const positions = data.positions ?? [];
      posBody.innerHTML = positions.length === 0
        ? '<tr><td colspan="8">Loading…</td></tr>'
        : positions.map(p => `
            <tr>
              <td class="coin">${p.symbol ?? p.coin}</td>
              <td>${fmtUSD(p.value)}</td>
              <td>${p.entry != null ? fmtUSD(p.entry) : '—'}</td>
              <td class="${colorClass(p.pnl_pct)}">${fmtPct(p.pnl_pct)}</td>
              <td class="${colorClass(p.pnl_usd)}">${fmtUSD(p.pnl_usd)}</td>
              <td>${p.recovery_needed != null ? fmtPct(p.recovery_needed) : '—'}</td>
              <td><span class="tag ${p.status?.toLowerCase()}">${p.status ?? '—'}</span></td>
              <td><input type="checkbox" class="cap-calc-cb" data-value="${p.value ?? 0}" data-coin="${p.symbol ?? p.coin}"></td>
            </tr>`).join('');

      // Wire up freed capital calculator checkboxes
      posBody.querySelectorAll('.cap-calc-cb').forEach(cb => {
        cb.addEventListener('change', updateFreedCapital);
      });
    }

    // PnL summary bar
    const pnlBar = $('pnl-summary-bar');
    if (pnlBar && data.health) {
      const total = Object.values(data.health).reduce((a, b) => a + b, 0) || 1;
      const winPct = ((data.health.winning ?? 0) / total) * 100;
      pnlBar.style.setProperty('--win-pct', winPct + '%');
    }

    setText('pnl-winners',   health.winning  ?? 0);
    setText('pnl-losers',    (health.small ?? 0) + (health.moderate ?? 0) + (health.severe ?? 0));
    setText('pnl-tracked',   data.tracked_count ?? 0);
    setText('pnl-total-unreal', fmtUSD(data.total_unrealised));

    // Freed capital calculator initial state
    const capListEl = $('cap-calc-list');
    if (capListEl) capListEl.innerHTML = '<p class="muted">Loading positions…</p>';

  } catch (e) {
    console.error('loadRebalancing:', e);
  }
}

function updateFreedCapital() {
  const checkboxes = document.querySelectorAll('.cap-calc-cb:checked');
  let total = 0;
  checkboxes.forEach(cb => { total += parseFloat(cb.dataset.value ?? 0); });
  setText('freed-count',  checkboxes.length + ' positions selected');
  setText('freed-amount', fmtUSD(total));
  const box = $('freed-total-box');
  if (box) box.textContent = fmtUSD(total);
}

async function refreshRebalancingAnalysis() {
  const btn = $('rb-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analysing…'; }
  try {
    await fetch(`${API}/api/rebalancing/analyse`, { method: 'POST' });
    showToast('Analysis requested — refresh in a moment');
    setTimeout(loadRebalancing, 3000);
  } catch (e) {
    showToast('Failed to trigger analysis', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Analysis'; }
  }
}

// ── Monitor status ────────────────────────────────────────────────

async function loadMonitorStatus() {
  try {
    const res = await fetch(`${API}/api/monitor/status`);
    const data = await res.json();
    monitorPaused = data.paused ?? false;
    const pill = $('monitor-status-pill');
    const text = $('monitor-status-text');
    const btn  = $('pause-resume-btn');
    if (pill) pill.className = 'status-pill ' + (monitorPaused ? 'paused' : 'running');
    if (text) text.textContent = monitorPaused ? 'Paused' : 'Running';
    if (btn)  btn.textContent  = monitorPaused ? 'Resume' : 'Pause';
  } catch (e) {
    console.error('loadMonitorStatus:', e);
  }
}

async function toggleMonitor() {
  const action = monitorPaused ? 'resume' : 'pause';
  try {
    await fetch(`${API}/api/monitor/${action}`, { method: 'POST' });
    loadMonitorStatus();
    showToast(`Monitoring ${action}d ✅`);
  } catch (e) {
    showToast('Failed to toggle monitor', true);
  }
}

// ── Error banner ──────────────────────────────────────────────────

function showError(msg) {
  const el = $('error-banner');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

// ── Spinner ───────────────────────────────────────────────────────

function setLoading(on) {
  const el = $('spinner');
  if (el) el.style.display = on ? 'block' : 'none';
}

// ── Button group helper (journal form) ────────────────────────────

function initButtonGroups() {
  document.querySelectorAll('.btn-group, [id$="-group"]').forEach(group => {
    group.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });
}

// ── Activity filter buttons ───────────────────────────────────────

function initActivityFilters() {
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      loadActivityFeed(btn.dataset.filter);
    });
  });
}

// ── Wire up all static buttons ────────────────────────────────────

function initButtons() {
  // Sweep save
  const sweepSave = $('sweep-save-btn');
  if (sweepSave) sweepSave.addEventListener('click', saveSweep);

  // Sweep toggle label update
  const sweepToggle = $('sweep-enabled-toggle');
  if (sweepToggle) sweepToggle.addEventListener('change', () => {
    const label = $('sweep-status-label');
    if (label) label.textContent = sweepToggle.checked ? 'Auto-sweep ON' : 'Auto-sweep OFF';
  });

  // Monitor pause/resume
  const pauseBtn = $('pause-resume-btn');
  if (pauseBtn) pauseBtn.addEventListener('click', toggleMonitor);

  // Rebalancing refresh
  const rbRefresh = $('rb-refresh-btn');
  if (rbRefresh) rbRefresh.addEventListener('click', refreshRebalancingAnalysis);

  // Kraken trade submit — look for a submit button near the kraken trade form
  const kTradeBtn = document.querySelector('#panel-kraken .trade-submit-btn, button[data-action="kraken-trade"]');
  if (kTradeBtn) kTradeBtn.addEventListener('click', submitKrakenTrade);

  // Journal log
  const jLogBtn = document.querySelector('button[data-action="log-trade"], .log-trade-btn');
  if (jLogBtn) jLogBtn.addEventListener('click', submitJournalEntry);

  // Profile preference add
  const prefBtn = document.querySelector('button[data-action="add-pref"], .pref-add-btn');
  if (prefBtn) prefBtn.addEventListener('click', savePreference);
}

// ── Full refresh ──────────────────────────────────────────────────

async function refreshAll() {
  setLoading(true);
  try {
    await Promise.allSettled([
      loadPortfolioSummary(),
      loadPortfolioData(),
      loadSweep(),
      loadAlerts(),
      loadTrailingStops(),
      loadThresholds(),
      loadKraken(),
      loadJournalEntries(),
      loadJournalStats(),
      loadProfile(),
      loadRebalancing(),
      loadActivityFeed(),
      loadMonitorStatus(),
    ]);
    setText('last-updated', 'just now');
    showError('');
  } catch (e) {
    showError('Some data failed to load — retrying in 5 min');
  } finally {
    setLoading(false);
  }
}

// ── Auto-refresh every 5 minutes ──────────────────────────────────

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, 5 * 60 * 1000);
}

// ── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  console.log('dashboard.js v2.0.0 — initialising');
  initTabs();
  initButtons();
  initButtonGroups();
  initActivityFilters();
  refreshAll();
  startAutoRefresh();
});
