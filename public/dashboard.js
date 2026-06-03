// dashboard.js — v3.0.0
// Complete rewrite — correct API endpoints, all HTML-called functions defined
// ──────────────────────────────────────────────────────────────────────────────

const API = '';
let monitoringPaused = false;
let selectedAction = null;
let selectedEmotion = null;
let selectedFollowed = 'na';
let activityFilter = 'all';

// ── Helpers ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function fmt(n, dp = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtUSD(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(Number(n));
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (Number(n) < 0 ? '-$' : '$') + str;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return (Number(n) >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}

function colorClass(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n) >= 0 ? 'positive' : 'negative';
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
  setTimeout(() => { t.className = 'toast'; }, 3000);
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

function spinner(show) {
  const el = $('spinner');
  if (el) el.classList.toggle('active', show);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
// HTML uses: onclick="switchTab('portfolio')"

function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const panel = $('tab-' + name);
  if (panel) panel.classList.add('active');
  // Activate the button that triggered this call
  if (typeof event !== 'undefined' && event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  } else {
    document.querySelectorAll('.tab-btn').forEach(b => {
      if ((b.getAttribute('onclick') || '').includes(`'${name}'`)) b.classList.add('active');
    });
  }
  // Lazy-load tab data
  if (name === 'activity')    loadActivity();
  if (name === 'journal')     { loadJournalStats(); loadJournalEntries(); loadLearning(); loadProfilePreferences(); }
  if (name === 'rebalancing') { loadRebalancingTracker(); loadRebalancingPositions(); }
  if (name === 'kraken')      loadKraken();
}

// ── Portfolio (main tab) ──────────────────────────────────────────────────────

async function loadPortfolio() {
  spinner(true);
  try {
    const res = await fetch(`${API}/portfolio/summary`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Grand total
    const grand = parseFloat(data.grand_total_usd ?? data.total_value_usd ?? 0);
    setText('portfolio-value', fmtUSD(grand));

    // Show portfolio totals section
    const totalsEl = $('portfolio-totals');
    if (totalsEl) totalsEl.style.display = '';

    // Subtotals
    setText('revolut-crypto-subtotal', fmtUSD(data.total_value_usd));
    const cashTotal = (parseFloat(data.cash_usd || 0) + parseFloat(data.cash_usdt || 0)).toFixed(2);
    setText('revolut-cash-subtotal',   fmtUSD(cashTotal));
    setText('kraken-crypto-subtotal',  fmtUSD(data.kraken_total_usd));
    setText('kraken-cash-subtotal',    '—');
    setText('tangem-subtotal',         fmtUSD(data.tangem_value_usd));

    // Portfolio sums row
    const cryptoSum = parseFloat(data.total_value_usd || 0)
                    + parseFloat(data.kraken_total_usd || 0)
                    + parseFloat(data.tangem_value_usd || 0);
    const cashSum   = parseFloat(data.cash_usd || 0) + parseFloat(data.cash_usdt || 0);
    setText('portfolio-crypto-sum', fmtUSD(cryptoSum));
    setText('portfolio-cash-sum',   fmtUSD(cashSum));
    setText('portfolio-total-sum',  fmtUSD(grand));

    // Capital bar
    const invested  = parseFloat(data.invested ?? 0);
    const pnlUsd    = parseFloat(data.pl_usd ?? 0);
    const pnlPct    = parseFloat(data.pl_pct ?? 0);
    const breakEven = data.break_even_pct ? parseFloat(data.break_even_pct) : null;

    if (invested > 0) {
      const capBar = $('capital-bar');
      if (capBar) capBar.style.display = '';
      setText('cap-invested', fmtUSD(invested));
      setText('cap-current',  fmtUSD(grand));
      const pnlEl = $('cap-pnl');
      if (pnlEl) {
        pnlEl.textContent = `${fmtUSD(pnlUsd)} (${fmtPct(pnlPct)})`;
        pnlEl.className = 'cap-stat-value ' + colorClass(pnlUsd);
      }
      setText('cap-breakeven', breakEven != null ? fmtPct(breakEven) : '—');
    }

    // Holdings list
    const positions = data.positions ?? [];
    const holdingsEl = $('holdings-list');
    if (holdingsEl) {
      if (positions.length === 0) {
        holdingsEl.innerHTML = '<p class="muted">No holdings found.</p>';
      } else {
        holdingsEl.innerHTML = positions.map(h => {
          const plPct  = parseFloat(h.pl_pct ?? 0);
          const valUsd = parseFloat(h.value_usd ?? 0);
          const cls    = colorClass(plPct);
          return `
            <div class="holding-row">
              <div class="holding-left">
                <div class="coin-icon">${(h.currency || '?').slice(0, 3)}</div>
                <div>
                  <div class="coin-symbol">${h.currency ?? '?'}</div>
                  <div class="coin-price">${h.current_price ? '$' + fmt(h.current_price, 4) : '—'}</div>
                </div>
              </div>
              <div class="coin-value">
                <div>${fmtUSD(valUsd)}</div>
                <div class="${cls}" style="font-size:0.78rem">${h.pl_pct != null ? fmtPct(plPct) : '—'}</div>
              </div>
            </div>`;
        }).join('');
      }
    }

    // PnL summary bar
    if (positions.length > 0) {
      const winners  = positions.filter(p => parseFloat(p.pl_pct || 0) > 0);
      const losers   = positions.filter(p => parseFloat(p.pl_pct || 0) < 0);
      const sumPnl   = positions.reduce((s, p) => {
        const entry = parseFloat(p.entry_price || 0);
        const price = parseFloat(p.current_price || 0);
        const qty   = parseFloat(p.quantity || 0);
        return (entry && price && qty) ? s + (price - entry) * qty : s;
      }, 0);
      const pnlBar = $('pnl-summary-bar');
      if (pnlBar) pnlBar.style.display = '';
      setText('pnl-tracked',      positions.filter(p => p.entry_price).length + ' tracked');
      setText('pnl-winners',      winners.length + ' winners');
      setText('pnl-losers',       losers.length + ' losers');
      setText('pnl-total-unreal', fmtUSD(sumPnl));
    }

    setText('last-updated', timeAgo(new Date().toISOString()));
  } catch (e) {
    console.error('loadPortfolio:', e);
    setText('portfolio-value', 'Error');
    showToast('Portfolio load failed: ' + e.message, true);
  } finally {
    spinner(false);
  }
}

// ── Tangem panel ──────────────────────────────────────────────────────────────

async function loadTangem() {
  const loading = $('tangem-loading');
  const content = $('tangem-content');
  try {
    const res  = await fetch(`${API}/api/tangem`);
    const data = await res.json();
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = '';

    setText('tangem-value-usd', fmtUSD(data.valueUSD ?? data.value_usd));
    setText('tangem-xrp-qty',   fmt(data.balance ?? data.xrp_qty, 4) + ' XRP');
    setText('tangem-address',   data.address ?? '—');

    const entryEl = $('tangem-entry-line');
    if (entryEl) entryEl.textContent = data.entryPrice ? `Entry: $${fmt(data.entryPrice, 4)}` : '';

    const pnlUsdEl = $('tangem-pnl-usd');
    const pnlPctEl = $('tangem-pnl-pct');
    if (pnlUsdEl) {
      pnlUsdEl.textContent = fmtUSD(data.unrealisedPnlUsd);
      pnlUsdEl.className = 'tangem-pnl-value ' + colorClass(data.unrealisedPnlUsd);
    }
    if (pnlPctEl) {
      pnlPctEl.textContent = fmtPct(data.unrealisedPnlPct);
      pnlPctEl.className = 'tangem-pnl-pct ' + colorClass(data.unrealisedPnlPct);
    }
  } catch (e) {
    console.error('loadTangem:', e);
    if (loading) loading.textContent = 'Tangem load failed.';
  }
}

// ── USDT Sweep panel ──────────────────────────────────────────────────────────

async function loadSweep() {
  const loading = $('sweep-loading');
  const content = $('sweep-content');
  try {
    const res  = await fetch(`${API}/api/system/config`);
    const data = await res.json();
    const rows  = data.config ?? [];
    const row   = rows.find(r => r.config_key === 'usdt_sweep_config');
    const cfg   = row ? JSON.parse(row.config_value) : { enabled: true, sweep_pct: 20, min_trade_value_usd: 50 };

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = '';

    const toggle = $('sweep-enabled-toggle');
   