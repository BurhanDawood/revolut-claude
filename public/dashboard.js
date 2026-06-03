var DASHBOARD_VERSION = '1.0.4';
console.log('Dashboard loaded v' + DASHBOARD_VERSION);

  window.onerror = function(msg, src, line, col, err) {
    const bar = document.getElementById('js-error-bar') || document.createElement('div');
    bar.id = 'js-error-bar';
    bar.style = 'background:#cc0000;color:#fff;padding:8px 12px;font-size:12px;position:fixed;top:0;left:0;right:0;z-index:99999;word-break:break-all';
    bar.textContent = 'JS Error line ' + line + ': ' + msg;
    document.body.prepend(bar);
    console.error('Dashboard JS error:', msg, src, line, col, err);
  };

  const BASE = window.location.origin;
  const REFRESH_MS = 5 * 60 * 1000;

  let balancesData = [];
  let statusData = {};
  let targetsData = {};
  let entryPricesData = {};
  let entryDetailData = {};
  let trailingStopsData = {};
  let historicalBasisData = {};
  let revolutTotalUSD = 0;

  window.journalLoaded = false;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function fmt(usd) {
    if (usd == null) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd);
  }

  function fmtPrice(p) {
    if (p == null) return '—';
    if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (p >= 1) return '$' + p.toFixed(4);
    return '$' + p.toFixed(6);
  }

  function setLoading(on) {
    document.getElementById('spinner').classList.toggle('active', on);
  }

  function showError(msg) {
    const el = document.getElementById('error-banner');
    if (msg) { el.textContent = msg; el.classList.add('visible'); }
    else { el.classList.remove('visible'); }
  }

  function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = 'toast'; }, 2800);
  }

  async function apiFetch(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(BASE + path, opts);
    } catch (networkErr) {
      console.error(`[apiFetch] Network error on ${method} ${path}:`, networkErr.message);
      throw new Error(`Network error: ${networkErr.message}`);
    }
    if (!res.ok) {
      console.error(`[apiFetch] HTTP ${res.status} on ${method} ${path}`);
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!text || text.trim() === '') return {};
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      console.error(`[apiFetch] JSON parse error on ${method} ${path}:`, text.substring(0, 300));
      throw new Error(`Invalid JSON response from ${path}`);
    }
  }

  // ── Tab switching ─────────────────────────────────────────────────────────

  function switchTab(tab) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    event.currentTarget.classList.add('active');

    if (tab === 'journal' && !window.journalLoaded) {
      window.journalLoaded = true;
      loadJournalStats();
      loadLearning();
      loadJournal();
      loadProfile();
    }
    if (tab === 'rebalancing' && !window.rebalancingLoaded) {
      window.rebalancingLoaded = true;
      loadRebalancingData();
    }
    if (tab === 'kraken') {
      loadKrakenTab();
    }
    if (tab === 'activity') {
      loadActivity(currentFilter);
    }
  }

  // ── Portfolio Render ──────────────────────────────────────────────────────

  // ── Holdings rendering ────────────────────────────────────────────────────

  const DUST_USD = 10;
  const MEDALS = ['🥇','🥈','🥉','4️⃣','5️⃣'];
  const STABLE_COINS = ['USD','USDT','USDC','EUR','GBP'];

  function overnightBadge(pct) {
    if (pct == null) return '';
    const sign = pct >= 0 ? '+' : '';
    const cls  = pct >= 0 ? 'pos' : 'neg';
    return `<span class="overnight-badge ${cls}">${sign}${pct.toFixed(1)}% overnight</span>`;
  }

  function pnlClass(pct) {
    if (pct == null) return '';
    if (pct >= 0)    return 'upnl-profit';
    if (pct > -20)   return 'upnl-small-loss';
    if (pct > -50)   return 'upnl-loss';
    return 'upnl-severe';
  }

  function topHoldingCardHtml(h, index, totalValue) {
    const pct   = totalValue > 0 ? (h.valueUSD / totalValue * 100).toFixed(1) : '0';
    const sym   = h.symbol || `${h.currency}-USD`;
    const price = h.price || 0;
    const overnight = h.overnightChangePct != null
      ? `<span class="overnight-badge ${h.overnightChangePct >= 0 ? 'pos' : 'neg'}">${h.overnightChangePct >= 0 ? '+' : ''}${h.overnightChangePct.toFixed(1)}% overnight</span>`
      : '';
    var epDetail = (typeof entryDetailData !== 'undefined') ? entryDetailData[sym] : null;
    var cycleCount = epDetail ? epDetail.cycle_count : 0;
    var origEntry  = epDetail ? (epDetail.original_entry_price || h.entryPrice) : h.entryPrice;
    var histBasisEntry = (typeof historicalBasisData !== 'undefined') ? (historicalBasisData[h.currency] || null) : null;
    var entriesDiffer = h.entryPrice && origEntry && Math.abs(h.entryPrice - origEntry) > 0.000001;
    var pnlLine;
    if (h.entryPrice != null && h.unrealisedPnlPct != null) {
      // Cycle entry line (existing template literal — unchanged, already validated)
      var cycleLabel = cycleCount > 0 ? 'Cycle' : 'Entry';
      var plSign = h.unrealisedPnlPct >= 0 ? '+' : '';
      var plUsdSign = h.unrealisedPnlUsd >= 0 ? '+' : '';
      var plEmoji = h.unrealisedPnlPct >= 0 ? '🟢' : '🔴';
      var cycleLine = '<div class="hc-pnl-line ' + pnlClass(h.unrealisedPnlPct) + '">' +
        cycleLabel + ': ' + fmtPrice(h.entryPrice) + ' | Now: ' + fmtPrice(price) + ' | ' +
        plSign + h.unrealisedPnlPct.toFixed(1) + '% (' +
        plUsdSign + fmt(h.unrealisedPnlUsd) + ') ' + plEmoji + '</div>';

      // Historical basis line — string concat only, no template literals
      var histLine = '';
      var hb = histBasisEntry ? histBasisEntry.historical_basis : (entriesDiffer ? origEntry : null);
      if (hb && Math.abs(hb - h.entryPrice) > 0.000001) {
        var hbPl = ((price - hb) / hb * 100);
        var hbCol = hbPl >= 0 ? 'var(--accent)' : 'var(--danger)';
        var hbSign = hbPl >= 0 ? '+' : '';
        var netStr = histBasisEntry ? (' - $' + histBasisEntry.net_deployed.toFixed(0) + ' net') : '';
        histLine = '<div style="font-size:0.72rem;color:#666;padding:2px 0 0 2px">' +
          'Historical basis: ' + fmtPrice(hb) +
          ' <span style="color:' + hbCol + '">' + hbSign + hbPl.toFixed(1) + '%</span>' +
          netStr + '</div>';
      }
      pnlLine = cycleLine + histLine;
    } else {
      pnlLine = `<div class="entry-inline"><span style="color:var(--text-muted);font-size:0.75rem">No entry set</span> <button class="btn-outline btn-sm" onclick="showQuickEntry('${h.currency}')">Set entry</button><div class="alert-inline" id="quick-entry-${h.currency}" style="display:none"><input type="number" id="qe-input-${h.currency}" placeholder="Entry $" step="any" class="threshold-input" style="width:90px"><button class="btn-accent btn-sm" onclick="submitQuickEntry('${sym}','${h.currency}')">SET</button><button class="btn-outline btn-sm" onclick="hideQuickEntry('${h.currency}')">✕</button></div></div>`;
    }
    return `
      <div class="hc-top" data-coin="COIN">
        <div class="hc-main">
          <div class="hc-left">
            <span class="hc-medal">${MEDALS[index]}</span>
            <div class="coin-icon">${h.currency.slice(0,3)}</div>
            <div>
              <div class="coin-symbol">${h.currency}</div>
              <div class="coin-price">${fmtPrice(price)}</div>
            </div>
          </div>
          <div class="hc-right">
            <div class="hc-value">${fmt(h.valueUSD)}</div>
            <div class="hc-portfolio-pct">${pct}% of portfolio</div>
            ${overnight}
          </div>
        </div>
        ${pnlLine}
        <div class="hc-actions">
          <button class="btn-outline btn-sm" onclick="showSetAlert('${sym}','${h.currency}',${price})">🔔 Set Alert</button>
          <div class="alert-inline" id="alert-inline-${h.currency}" style="display:none">
            <input type="number" id="alert-pct-${h.currency}" value="10" min="1" max="1000" step="0.5" class="threshold-input" style="width:65px">
            <span>% from now</span>
            <button class="btn-accent btn-sm" onclick="submitSetAlert('${sym}','${h.currency}',${price})">Set</button>
            <button class="btn-outline btn-sm" onclick="hideSetAlert('${h.currency}')">✕</button>
          </div>
        </div>
      </div>`;
  }

  function otherHoldingRowHtml(h) {
    const sym = h.symbol || `${h.currency}-USD`;
    const overnight = h.overnightChangePct != null
      ? `<span class="overnight-badge ${h.overnightChangePct >= 0 ? 'pos' : 'neg'}">${h.overnightChangePct >= 0 ? '+' : ''}${h.overnightChangePct.toFixed(1)}%</span>`
      : '';
    const pnlBadge = (h.entryPrice != null && h.unrealisedPnlPct != null)
      ? `<span class="${pnlClass(h.unrealisedPnlPct)}" style="font-size:0.78rem;font-weight:600">${h.unrealisedPnlPct >= 0 ? '+' : ''}${h.unrealisedPnlPct.toFixed(1)}%</span>`
      : `<button class="btn-outline btn-sm" style="font-size:0.7rem;padding:2px 6px" onclick="showQuickEntry('${h.currency}')">Set entry</button>`;
    const quickEntryForm = `<div class="alert-inline" id="quick-entry-${h.currency}" style="display:none;padding:6px 0"><input type="number" id="qe-input-${h.currency}" placeholder="Entry $" step="any" class="threshold-input" style="width:90px"><button class="btn-accent btn-sm" onclick="submitQuickEntry('${sym}','${h.currency}')">SET</button><button class="btn-outline btn-sm" onclick="hideQuickEntry('${h.currency}')">✕</button></div>`;
    return `
      <div class="holding-row">
        <div class="holding-left">
          <div class="coin-icon">${h.currency.slice(0,3)}</div>
          <div>
            <div class="coin-symbol">${h.currency}</div>
            <div class="coin-price">${fmtPrice(h.price)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="coin-value">${fmt(h.valueUSD)}</div>
          ${overnight}
          ${pnlBadge}
        </div>
      </div>
      ${quickEntryForm}`;
  }

  function dustHoldingRowHtml(h) {
    const sym   = h.symbol || `${h.currency}-USD`;
    const price = h.price || 0;
    const qty   = (h.available || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const pnlBit = (h.entryPrice != null && h.unrealisedPnlPct != null)
      ? `<span class="${pnlClass(h.unrealisedPnlPct)}" style="font-size:0.75rem">${h.unrealisedPnlPct >= 0 ? '+' : ''}${h.unrealisedPnlPct.toFixed(1)}%</span>`
      : '';
    return `
      <div class="holding-row" style="opacity:0.75">
        <div class="holding-left">
          <div class="coin-icon" style="background:rgba(136,136,136,0.1);color:var(--text-muted)">${h.currency.slice(0,3)}</div>
          <div>
            <div class="coin-symbol" style="font-size:0.85rem">${h.currency}</div>
            <div class="coin-price">${fmtPrice(price)} × ${qty}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <div class="coin-value" style="color:var(--text-muted);font-size:0.85rem">${fmt(h.valueUSD)}</div>
          ${pnlBit}
          <button class="btn-outline btn-sm" title="Set buy alert" onclick="showDustAlert('${sym}','${h.currency}',${price})">🔔</button>
          <button class="btn-outline btn-sm" title="Research" onclick="researchDust('${h.currency}')">🔍</button>
        </div>
      </div>
      <div class="alert-inline" id="dust-alert-${h.currency}" style="display:none;padding:8px 12px;background:var(--surface2);border-radius:8px;margin-top:-6px;margin-bottom:4px">
        <span>Alert when ${h.currency} rises</span>
        <input type="number" id="dust-pct-${h.currency}" value="20" min="1" max="10000" step="1" class="threshold-input" style="width:65px">
        <span>% from now</span>
        <button class="btn-accent btn-sm" onclick="submitDustAlert('${sym}','${h.currency}',${price})">Set</button>
        <button class="btn-outline btn-sm" onclick="hideDustAlert('${h.currency}')">✕</button>
      </div>`;
  }

  function renderHoldings(balances) {
    const el = document.getElementById('holdings-list');
    if (!balances || balances.length === 0) {
      el.innerHTML = '<div class="empty-state">No holdings found.</div>';
      return;
    }

    const coins = balances
      .filter(h => h.valueUSD != null && !STABLE_COINS.includes(h.currency) && !h.ignored)
      .sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));

    const significant = coins.filter(h => (h.valueUSD || 0) >= DUST_USD);
    const dust        = coins.filter(h => (h.valueUSD || 0) <  DUST_USD);
    const top5        = significant.slice(0, 5);
    const others      = significant.slice(5);
    const totalValue  = significant.reduce((s, h) => s + (h.valueUSD || 0), 0);

    let othersExpanded = false, dustExpanded = false;
    try { othersExpanded = localStorage.getItem('holdingsOthersExpanded') === 'true'; } catch(e) {}
    try { dustExpanded   = localStorage.getItem('holdingsDustExpanded')   === 'true'; } catch(e) {}

    const top5Html = top5.map((h, i) => topHoldingCardHtml(h, i, totalValue)).join('');

    const othersHtml = others.length > 0 ? `
      <button class="holdings-toggle-btn" onclick="toggleOtherHoldings()" id="others-toggle">
        <span>📋 Other Holdings (${others.length} assets)</span>
        <span id="others-toggle-arrow">${othersExpanded ? '▲ Hide' : '▼ Show'}</span>
      </button>
      <div class="holdings-full-list${othersExpanded ? ' expanded' : ''}" id="holdings-others-list">
        <div class="holdings-full-list-inner">${others.map(otherHoldingRowHtml).join('')}</div>
      </div>` : '';

    const dustHtml = dust.length > 0 ? `
      <div style="margin-top:14px;text-align:center">
        <button class="dust-link" onclick="toggleDustSection()">
          🔍 View dust positions (${dust.length} coins) <span id="dust-toggle-arrow">${dustExpanded ? '▲' : '▼'}</span>
        </button>
      </div>
      <div class="holdings-full-list${dustExpanded ? ' expanded' : ''}" id="holdings-dust-list">
        <div class="holdings-full-list-inner">${dust.map(dustHoldingRowHtml).join('')}</div>
      </div>` : '';

    el.innerHTML = top5Html + othersHtml + dustHtml;
  }

  // ── Holdings toggle handlers ──────────────────────────────────────────────

  function toggleOtherHoldings() {
    const list  = document.getElementById('holdings-others-list');
    const arrow = document.getElementById('others-toggle-arrow');
    if (!list) return;
    const expanding = !list.classList.contains('expanded');
    list.classList.toggle('expanded', expanding);
    if (arrow) arrow.textContent = expanding ? '▲ Hide' : '▼ Show';
    try { localStorage.setItem('holdingsOthersExpanded', String(expanding)); } catch(e) {}
  }

  function toggleDustSection() {
    const list  = document.getElementById('holdings-dust-list');
    const arrow = document.getElementById('dust-toggle-arrow');
    if (!list) return;
    const expanding = !list.classList.contains('expanded');
    list.classList.toggle('expanded', expanding);
    if (arrow) arrow.textContent = expanding ? '▲' : '▼';
    try { localStorage.setItem('holdingsDustExpanded', String(expanding)); } catch(e) {}
  }

  // ── Alert inline controls ─────────────────────────────────────────────────

  function showSetAlert(sym, coinBase, price) {
    document.getElementById(`alert-inline-${coinBase}`).style.display = 'flex';
  }
  function hideSetAlert(coinBase) {
    document.getElementById(`alert-inline-${coinBase}`).style.display = 'none';
  }
  async function submitSetAlert(sym, coinBase, currentPrice) {
    const pct = parseFloat(document.getElementById(`alert-pct-${coinBase}`).value);
    if (!pct || pct <= 0) { showToast('Enter a valid % > 0', 'error'); return; }
    try {
      await apiFetch('POST', `/api/targets/${sym}`, { threshold_pct: pct });
      hideSetAlert(coinBase);
      const target = (currentPrice * (1 + pct / 100));
      showToast(`✅ Alert set for ${coinBase} — up ${pct}% → ${fmtPrice(target)}`, 'success');
      targetsData = await apiFetch('GET', '/api/targets').catch(() => targetsData);
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  }

  function showDustAlert(sym, coinBase, price) {
    document.getElementById(`dust-alert-${coinBase}`).style.display = 'flex';
  }
  function hideDustAlert(coinBase) {
    document.getElementById(`dust-alert-${coinBase}`).style.display = 'none';
  }
  async function submitDustAlert(sym, coinBase, currentPrice) {
    const pct = parseFloat(document.getElementById(`dust-pct-${coinBase}`).value);
    if (!pct || pct <= 0) { showToast('Enter a valid %', 'error'); return; }
    try {
      await apiFetch('POST', `/api/targets/${sym}`, { threshold_pct: pct });
      hideDustAlert(coinBase);
      const target = currentPrice * (1 + pct / 100);
      showToast(`✅ Alert set for ${coinBase} — up ${pct}% from ${fmtPrice(currentPrice)} → ${fmtPrice(target)}`, 'success');
      targetsData = await apiFetch('GET', '/api/targets').catch(() => targetsData);
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  }

  async function researchDust(coinBase) {
    try {
      await apiFetch('POST', '/api/research-dust', { coin: coinBase });
      showToast(`📊 Research on ${coinBase} sent to Telegram`, 'success');
    } catch(e) {
      showToast(`Type "research ${coinBase}" in Telegram`, '');
    }
  }

  function renderCapitalBar(cap) {
    if (!cap || cap.invested == null) return;
    const bar = document.getElementById('capital-bar');
    bar.style.display = '';
    document.getElementById('cap-invested').textContent = fmt(cap.invested);
    document.getElementById('cap-current').textContent = fmt(cap.portfolioValue);
    const pnlEl = document.getElementById('cap-pnl');
    const pnlSign = cap.pnl >= 0 ? '+' : '';
    pnlEl.textContent = `${pnlSign}${fmt(cap.pnl)} (${pnlSign}${cap.pnlPct.toFixed(1)}%)`;
    pnlEl.className = 'cap-stat-value ' + (cap.pnl >= 0 ? 'pnl-pos' : 'pnl-neg');
    const beEl = document.getElementById('cap-breakeven');
    if (cap.pnl < 0) {
      beEl.textContent = `+${cap.breakEvenPct.toFixed(1)}%`;
      beEl.className = 'cap-stat-value break-even';
    } else {
      beEl.textContent = '✅ In profit';
      beEl.className = 'cap-stat-value pnl-pos';
    }
  }

  function renderPnlSummary(balances) {
    const bar = document.getElementById('pnl-summary-bar');
    if (!bar) return;
    const tracked = (balances || []).filter(h => h.unrealisedPnlPct != null && !STABLE_COINS.includes(h.currency));
    if (tracked.length === 0) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    const winners   = tracked.filter(h => h.unrealisedPnlPct >= 0);
    const losers    = tracked.filter(h => h.unrealisedPnlPct < 0);
    const totalUSD  = tracked.reduce((s, h) => s + (h.unrealisedPnlUsd || 0), 0);
    document.getElementById('pnl-tracked').textContent       = tracked.length;
    document.getElementById('pnl-winners').textContent       = winners.length;
    document.getElementById('pnl-losers').textContent        = losers.length;
    const totalEl = document.getElementById('pnl-total-unreal');
    totalEl.textContent = `${totalUSD >= 0 ? '+' : ''}${fmt(totalUSD)}`;
    totalEl.className   = 'pnl-sum-value ' + (totalUSD >= 0 ? 'upnl-profit' : 'upnl-severe');
  }

  async function renderTangemCard(tangem) {
    const loading = document.getElementById('tangem-loading');
    const content = document.getElementById('tangem-content');
    if (!tangem || tangem.valueUSD == null) {
      if (loading) loading.textContent = 'Unavailable';
      return;
    }

    // Show content, hide loading
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = '';

    // Value and quantity
    const valueEl = document.getElementById('tangem-value-usd');
    if (valueEl) valueEl.textContent = fmt(tangem.valueUSD);

    const xrpEl = document.getElementById('tangem-xrp-qty');
    if (xrpEl) xrpEl.textContent = `${tangem.balance.toFixed(2)} XRP @ ${fmtPrice(tangem.price)}`;

    // Entry vs current
    const entryEl = document.getElementById('tangem-entry-line');
    if (entryEl) entryEl.textContent = `Entry: $${tangem.entryPrice.toFixed(2)} | Current: $${tangem.price.toFixed(4)}`;

    // P&L
    const pnlUsdEl  = document.getElementById('tangem-pnl-usd');
    const pnlPctEl  = document.getElementById('tangem-pnl-pct');
    const pnlPos    = tangem.unrealisedPnlPct >= 0;
    const pnlSign   = pnlPos ? '+' : '';
    const pnlEmoji  = pnlPos ? '🟢' : '🔴';
    if (pnlUsdEl) {
      pnlUsdEl.textContent = `${pnlSign}${fmt(tangem.unrealisedPnlUsd)} ${pnlEmoji}`;
      pnlUsdEl.className   = 'tangem-pnl-value ' + (pnlPos ? 'pnl-pos' : 'pnl-neg');
    }
    if (pnlPctEl) {
      pnlPctEl.textContent = `${pnlSign}${tangem.unrealisedPnlPct.toFixed(1)}%`;
      pnlPctEl.className   = 'tangem-pnl-pct ' + (pnlPos ? 'pnl-pos' : 'pnl-neg');
    }

    // Address
    const addrEl = document.getElementById('tangem-address');
    if (addrEl && tangem.address) {
      const a = tangem.address;
      addrEl.textContent = a.slice(0, 8) + '…' + a.slice(-6);
    }

    // Update portfolio header — detailed breakdown: Revolut crypto+cash, Kraken crypto+cash, Tangem
    let krakenCryptoUSD = 0;
    let krakenCashUSD   = 0;
    try {
      const krakenData = await apiFetch('GET', '/api/kraken/balances');
      krakenCryptoUSD = krakenData?.totalUSD || 0;
      krakenCashUSD   = krakenData?.usdCash  || 0;
    } catch (e) { console.warn('Kraken balance fetch failed for portfolio header:', e); }

    // Split Revolut balancesData into crypto vs cash (USD/USDT/USDC/EUR/GBP)
    const REVOLUT_CASH = ['USD','USDT','USDC','EUR','GBP'];
    const revCryptoUSD = (balancesData || [])
      .filter(b => !REVOLUT_CASH.includes(b.currency) && b.valueUSD != null)
      .reduce((s, b) => s + (b.valueUSD || 0), 0);
    const revCashUSD = (balancesData || [])
      .filter(b => REVOLUT_CASH.includes(b.currency) && b.valueUSD != null)
      .reduce((s, b) => s + (b.valueUSD || 0), 0);

    const tangemUSD    = parseFloat(tangem.valueUSD) || 0;
    const totalCrypto  = revCryptoUSD + krakenCryptoUSD + tangemUSD;
    const totalCash    = revCashUSD + krakenCashUSD;
    const combined     = totalCrypto + totalCash;

    const pvEl = document.getElementById('portfolio-value');
    if (pvEl) pvEl.textContent = fmt(combined);

    const totalsEl = document.getElementById('portfolio-totals');
    if (totalsEl) totalsEl.style.display = '';

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('revolut-crypto-subtotal', fmt(revCryptoUSD));
    set('revolut-cash-subtotal',   revCashUSD > 0 ? fmt(revCashUSD) : '—');
    set('kraken-crypto-subtotal',  krakenCryptoUSD > 0 ? fmt(krakenCryptoUSD) : '—');
    set('kraken-cash-subtotal',    krakenCashUSD > 0 ? fmt(krakenCashUSD) : '—');
    set('tangem-subtotal',         `${fmt(tangemUSD)} (${tangem.balance.toFixed(0)} XRP)`);
    set('portfolio-crypto-sum',    fmt(totalCrypto));
    set('portfolio-cash-sum',      totalCash > 0 ? fmt(totalCash) : '—');
    set('portfolio-total-sum',     fmt(combined));
  }

  function renderTrailSummary(trails) {
    const box     = document.getElementById('trail-summary');
    const listEl  = document.getElementById('trail-summary-list');
    if (!box || !listEl) return;
    const entries = Object.entries(trails || {});
    if (entries.length === 0) { box.style.display = 'none'; return; }
    box.style.display = '';
    listEl.innerHTML = entries.map(([sym, ts]) => {
      const coin = sym.replace('-USD', '');
      const pctNeeded = (((ts.peakPrice - ts.stopPrice) / ts.peakPrice) * 100).toFixed(1);
      return `
        <div class="trail-summary-row">
          <span class="trail-summary-coin">${coin}</span>
          <span class="trail-summary-detail">${ts.trailPct}% trail | Peak ${fmtPrice(ts.peakPrice)}</span>
          <span class="trail-summary-stop">Stop ${fmtPrice(ts.stopPrice)} (−${pctNeeded}%)</span>
        </div>`;
    }).join('');
  }

  async function setTrailStop(symbol, coin) {
    const pct = parseFloat(document.getElementById(`trail-${coin}`).value);
    if (!pct || pct <= 0 || pct > 99) { showToast('Trail % must be 0.1–99', 'error'); return; }
    try {
      await apiFetch('POST', `/api/trailing-stops/${symbol}`, { trail_pct: pct });
      showToast(`${symbol} trailing stop set to ${pct}%`, 'success');
      trailingStopsData = await apiFetch('GET', '/api/trailing-stops').catch(() => trailingStopsData);
      renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData);
      renderTrailSummary(trailingStopsData);
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  }

  async function removeTrailStop(symbol) {
    try {
      await apiFetch('DELETE', `/api/trailing-stops/${symbol}`);
      showToast(`${symbol} trailing stop removed`, 'success');
      trailingStopsData = await apiFetch('GET', '/api/trailing-stops').catch(() => trailingStopsData);
      renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData);
      renderTrailSummary(trailingStopsData);
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  }

  function showQuickEntry(coinBase) {
    const el = document.getElementById(`quick-entry-${coinBase}`);
    if (el) el.style.display = 'flex';
  }
  function hideQuickEntry(coinBase) {
    const el = document.getElementById(`quick-entry-${coinBase}`);
    if (el) el.style.display = 'none';
  }
  async function submitQuickEntry(sym, coinBase) {
    const input = document.getElementById(`qe-input-${coinBase}`);
    const val = parseFloat(input ? input.value : '');
    if (!val || val <= 0) { showToast('Enter a valid price > 0', 'error'); return; }
    try {
      await apiFetch('POST', `/api/entryprices/${sym}`, { entry_price: val });
      entryPricesData = await apiFetch('GET', '/api/entryprices').catch(() => entryPricesData);
      hideQuickEntry(coinBase);
      showToast(`✅ Entry price for ${coinBase} set to $${val}`, 'success');
      balancesData = (await apiFetch('GET', '/api/balances').catch(() => ({ balances: balancesData }))).balances || balancesData;
      renderHoldings(balancesData);
      renderPnlSummary(balancesData);
    } catch(e) { showToast('Failed: ' + e.message, 'error'); }
  }

  function renderAlerts(activeAlerts) {
    const el = document.getElementById('alerts-list');
    const symbols = Object.keys(activeAlerts || {});
    if (symbols.length === 0) {
      el.innerHTML = '<div class="empty-state">No active alerts 🎉</div>';
      return;
    }
    el.innerHTML = symbols.map(sym => `
      <div class="alert-row">
        <span class="alert-symbol">🚀 ${sym}</span>
        <button class="btn-danger-outline" onclick="acknowledge('${sym}')">Acknowledge</button>
      </div>
    `).join('');
  }

  function renderMonitorStatus(paused) {
    const pill = document.getElementById('monitor-status-pill');
    const text = document.getElementById('monitor-status-text');
    const btn = document.getElementById('pause-resume-btn');
    if (paused) {
      pill.className = 'status-pill paused';
      text.textContent = 'Paused';
      btn.textContent = 'Resume';
    } else {
      pill.className = 'status-pill running';
      text.textContent = 'Running';
      btn.textContent = 'Pause';
    }
  }

  function renderThresholds(balances, status, targets, entries, trails, detail) {
    const el = document.getElementById('threshold-list');
    const trailMap = trails || {};
    const defaultPct = ((status.defaultThreshold || 0.20) * 100).toFixed(0);

    // Sort by USD value descending, exclude stables
    const allCoins = (balances || [])
      .filter(b => !STABLE_COINS.includes(b.currency) && b.valueUSD != null)
      .sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));

    const significant = allCoins.filter(h => (h.valueUSD || 0) >= DUST_USD);
    const dustCoins   = allCoins.filter(h => (h.valueUSD || 0) <  DUST_USD);

    if (allCoins.length === 0) {
      el.innerHTML = '<div class="empty-state">No coins to configure.</div>';
      return;
    }

    function coinCardHtml(h) {
      const sym  = h.symbol || `${h.currency}-USD`;
      const coin = h.currency;
      const price = h.price || 0;
      const qty   = h.available || 0;
      const value = h.valueUSD || 0;

      // ── Header: coin name + balance ──
      const header = `
        <div class="threshold-coin-header">
          <span class="tc-name">🪙 ${coin}</span>
          <span class="tc-balance">${qty.toFixed(4)} tokens = ${fmt(value)}</span>
        </div>`;

      // ── Entry + P&L (read-only) ──
      const entry = entries && entries[sym];
      const ep = detail && detail[sym];
      let entryRow = '';
      if (entry) {
        const pnl = price ? ((price - entry) / entry * 100) : null;
        const pnlColour = pnl == null ? '' : pnl >= 5 ? 'var(--accent)' : pnl >= 0 ? '#9effd8' : pnl >= -20 ? '#ffcc00' : 'var(--danger)';
        const pnlEmoji  = pnl == null ? '' : pnl >= 0 ? '🟢' : '🔴';
        const pnlStr    = pnl != null ? `<span class="tc-pnl" style="color:${pnlColour}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}% ${pnlEmoji}</span>` : '';
        // Cost basis row for coins with completed cycles
        const cycleCount = ep ? ep.cycle_count : 0;
        const origEntry  = ep ? ep.original_entry_price : entry;
        let costBasisRow = '';
        if (cycleCount > 0 && origEntry && origEntry !== entry) {
          const histPnl = price ? ((price - origEntry) / origEntry * 100) : null;
          const histColour = histPnl == null ? '' : histPnl >= 0 ? '#9effd8' : 'var(--danger)';
          const histStr = histPnl != null
            ? `<span style="color:${histColour}">${histPnl >= 0 ? '+' : ''}${histPnl.toFixed(1)}%</span>`
            : '';
          costBasisRow = `
            <div style="font-size:0.73rem;color:var(--text-muted);margin-top:2px;padding-left:4px">
              📈 Cost basis: ${fmtPrice(origEntry)} ${histStr} · ${cycleCount} cycle${cycleCount !== 1 ? 's' : ''}
            </div>`;
        }
        entryRow = `
          <div class="tc-entry-row">
            <span class="tc-entry-label">${cycleCount > 0 ? '🔄 Cycle entry' : 'Entry'}</span>
            <span class="tc-entry-value">${fmtPrice(entry)}</span>
            <span style="color:var(--text-muted);font-size:0.75rem">→ now ${fmtPrice(price)}</span>
            ${pnlStr}
          </div>${costBasisRow}`;
      }

      // ── Daily alert ──
      const custom = status.customThresholds && status.customThresholds[sym] !== undefined;
      const dailyPct = custom ? (status.customThresholds[sym] * 100).toFixed(1) : defaultPct;
      const dailyRow = `
        <div class="ctrl-row">
          <span class="ctrl-label">📅 Daily Alert</span>
          <input class="threshold-input" type="number" id="thresh-${coin}" value="${dailyPct}" min="1" max="999" step="0.5" style="width:70px" />
          <span class="pct-label">%</span>
          <button class="btn-outline" onclick="setThreshold('${sym}','${coin}')">Set</button>
          ${custom ? `<span style="font-size:0.7rem;color:var(--accent)">custom</span>` : `<span style="font-size:0.7rem;color:var(--text-muted)">default</span>`}
        </div>`;

      // ── Fixed target ──
      const tgt = targets && targets[sym];
      let targetRow;
      if (tgt) {
        targetRow = `
          <div class="ctrl-row">
            <span class="ctrl-label">🎯 Target</span>
            <span class="ctrl-info">${fmtPrice(tgt.anchorPrice)} +${tgt.thresholdPct}% = <strong>${fmtPrice(tgt.targetPrice)}</strong></span>
            <input class="threshold-input" type="number" id="ftpct-${coin}" value="${tgt.thresholdPct}" min="0.1" max="500" step="0.1" style="width:65px" />
            <span class="pct-label">%</span>
            <button class="btn-outline" onclick="updateTarget('${sym}','${coin}')">Edit</button>
            <button class="btn-danger-outline" onclick="removeTarget('${sym}')">Remove</button>
          </div>`;
      } else {
        targetRow = `
          <div class="ctrl-row">
            <span class="ctrl-label">🎯 Target</span>
            <span class="ctrl-info muted">Not set</span>
            <input class="threshold-input" type="number" id="ftpct-${coin}" placeholder="%" min="0.1" max="500" step="0.1" style="width:65px" />
            <span class="pct-label">% from now</span>
            <button class="btn-outline" onclick="setTarget('${sym}','${coin}')">+ Add Target</button>
          </div>`;
      }

      // ── Trailing stop ──
      const trail = trailMap[sym];
      let trailRow;
      if (trail) {
        const pctToTrigger = (((trail.peakPrice - trail.stopPrice) / trail.peakPrice) * 100).toFixed(1);
        trailRow = `
          <div class="ctrl-row">
            <span class="ctrl-label">🎯 Trail Stop</span>
            <div style="flex:1;min-width:0">
              <div class="trail-info">${trail.trailPct}% trail | Peak: ${fmtPrice(trail.peakPrice)}</div>
              <div class="trail-sub">Stop: ${fmtPrice(trail.stopPrice)} (−${pctToTrigger}% from peak)</div>
            </div>
            <input class="threshold-input" type="number" id="trail-${coin}" value="${trail.trailPct}" min="0.1" max="99" step="0.1" style="width:60px" />
            <span class="pct-label">%</span>
            <button class="btn-outline" onclick="setTrailStop('${sym}','${coin}')">Update</button>
            <button class="btn-danger-outline" onclick="removeTrailStop('${sym}')">Remove</button>
          </div>`;
      } else {
        trailRow = `
          <div class="ctrl-row">
            <span class="ctrl-label">🎯 Trail Stop</span>
            <span class="ctrl-info muted">Not set</span>
            <input class="threshold-input" type="number" id="trail-${coin}" placeholder="%" min="0.1" max="99" step="0.1" style="width:60px" />
            <span class="pct-label">% trail</span>
            <button class="btn-outline" onclick="setTrailStop('${sym}','${coin}')">+ Add Trail Stop</button>
          </div>`;
      }

      return `<div class="threshold-card">${header}${entryRow}${dailyRow}${targetRow}${trailRow}</div>`;
    }

    const sigHtml  = significant.map(coinCardHtml).join('');

    let dustHtml = '';
    if (dustCoins.length > 0) {
      let tcDustExpanded = false;
      try { tcDustExpanded = localStorage.getItem('tcDustExpanded') === 'true'; } catch(e) {}
      dustHtml = `
        <div class="tc-dust-toggle">
          <button class="tc-dust-link" onclick="toggleTcDust()">
            🔍 View dust coins (${dustCoins.length}) <span id="tc-dust-arrow">${tcDustExpanded ? '▲' : '▼'}</span>
          </button>
        </div>
        <div class="holdings-full-list${tcDustExpanded ? ' expanded' : ''}" id="tc-dust-list">
          <div class="holdings-full-list-inner" style="display:flex;flex-direction:column;gap:10px;padding-top:10px">
            ${dustCoins.map(coinCardHtml).join('')}
          </div>
        </div>`;
    }

    // Sold coins section — from /api/entryprices/detail (last_sold_at set)
    let soldHtml = '';
    try {
      const soldPositions = Object.entries(entryDetailData || {})
        .filter(([, ep]) => ep.last_sold_at)
        .sort((a, b) => new Date(b[1].last_sold_at) - new Date(a[1].last_sold_at));
      if (soldPositions.length > 0) {
        const soldCards = soldPositions.map(([sym, ep]) => {
          const coin     = sym.replace('-USD', '');
          const soldDate = new Date(ep.last_sold_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
          const origEntry  = ep.original_entry_price || ep.entry_price;
          const soldPrice  = ep.last_sold_price;
          const cycleStr   = ep.cycle_count > 0 ? ` · ${ep.cycle_count} cycle${ep.cycle_count>1?'s':''}` : '';
          return `
            <div id="sold-${coin}" style="opacity:0.55;border-left:3px solid #444;padding:8px 12px;margin-bottom:6px;background:#111;border-radius:6px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="color:#888;font-weight:700;font-size:0.8rem">
                  🔴 ${coin} <span style="font-size:0.65rem;color:#555;background:#1a1a1a;padding:1px 5px;border-radius:3px;margin-left:4px">SOLD ${soldDate}</span>
                </span>
                <div style="display:flex;gap:6px;align-items:center">
                  <button onclick="deleteSoldCoin('${sym}')"
                    style="background:none;border:1px solid #333;color:#444;padding:1px 7px;border-radius:4px;font-size:10px;cursor:pointer"
                    title="Remove from history">🗑️</button>
                </div>
              </div>
              ${soldPrice ? `<div style="font-size:0.72rem;color:#555;margin-top:3px">Sold @ ${fmtPrice(soldPrice)}${cycleStr}</div>` : ''}
              ${origEntry ? `<div style="font-size:0.72rem;color:#444;margin-top:2px">📈 Original basis: ${fmtPrice(origEntry)}</div>` : ''}
            </div>`;
        }).join('');
        soldHtml = `
          <div style="margin-top:14px">
            <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.08em;color:#444;margin-bottom:6px">Recently sold</div>
            ${soldCards}
          </div>`;
      }
    } catch(e) {}

    el.innerHTML = sigHtml + dustHtml + soldHtml;
  }

  async function deleteSoldCoin(symbol) {
    const coin = symbol.replace('-USD', '');
    if (!confirm(`Remove ${coin} from history?\n\nThis cannot be undone. Only remove if you never plan to buy back.`)) return;
    try {
      const res = await fetch(`/api/entry-prices/${symbol}`, { method: 'DELETE' });
      if (res.ok) {
        const card = document.getElementById(`sold-${coin}`);
        if (card) { card.style.transition = 'opacity 0.3s'; card.style.opacity = '0'; setTimeout(() => card.remove(), 300); }
        else { renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData); }
        delete entryDetailData[symbol];
        showToast(`${coin} removed from history`, 'success');
      } else {
        showToast('Failed to delete — try again', 'error');
      }
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  }

  function toggleTcDust() {
    const list  = document.getElementById('tc-dust-list');
    const arrow = document.getElementById('tc-dust-arrow');
    if (!list) return;
    const expanding = !list.classList.contains('expanded');
    list.classList.toggle('expanded', expanding);
    if (arrow) arrow.textContent = expanding ? '▲' : '▼';
    try { localStorage.setItem('tcDustExpanded', String(expanding)); } catch(e) {}
  }

  // ── Portfolio API Actions ──────────────────────────────────────────────────

  async function acknowledge(symbol) {
    try {
      await apiFetch('POST', `/api/acknowledge/${symbol}`);
      showToast(`Acknowledged ${symbol}`, 'success');
      await refreshStatus();
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  async function toggleMonitoring() {
    const btn = document.getElementById('pause-resume-btn');
    btn.disabled = true;
    try {
      const paused = statusData.paused;
      await apiFetch('POST', paused ? '/api/resume' : '/api/pause');
      showToast(paused ? 'Monitoring resumed' : 'Monitoring paused', 'success');
      await refreshStatus();
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function setThreshold(symbol, coin) {
    const pct = parseFloat(document.getElementById(`thresh-${coin}`).value);
    if (!pct || pct <= 0) { showToast('Enter a valid % > 0', 'error'); return; }
    try {
      await apiFetch('POST', `/api/threshold/${symbol}`, { threshold: pct / 100 });
      showToast(`${symbol} daily alert set to ${pct}%`, 'success');
      await refreshStatus();
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  async function setTarget(symbol, coin) {
    const pct = parseFloat(document.getElementById(`ftpct-${coin}`).value);
    if (!pct || pct <= 0) { showToast('Enter a valid % > 0', 'error'); return; }
    try {
      await apiFetch('POST', `/api/targets/${symbol}`, { threshold_pct: pct });
      showToast(`${symbol} fixed target set to +${pct}% from current price`, 'success');
      targetsData = await apiFetch('GET', '/api/targets');
      renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData);
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  async function updateTarget(symbol, coin) {
    const pct = parseFloat(document.getElementById(`ftpct-${coin}`).value);
    if (!pct || pct <= 0) { showToast('Enter a valid % > 0', 'error'); return; }
    try {
      await apiFetch('POST', `/api/targets/${symbol}`, { threshold_pct: pct });
      showToast(`${symbol} fixed target updated to ${pct}%`, 'success');
      targetsData = await apiFetch('GET', '/api/targets');
      renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData);
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  async function removeTarget(symbol) {
    try {
      await apiFetch('DELETE', `/api/targets/${symbol}`);
      showToast(`${symbol} fixed target removed`, 'success');
      targetsData = await apiFetch('GET', '/api/targets');
      renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData);
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  async function setEntryPrice(symbol, coin) {
    const price = parseFloat(document.getElementById(`entry-${coin}`).value);
    if (!price || price <= 0) { showToast('Enter a valid price > 0', 'error'); return; }
    try {
      await apiFetch('POST', `/api/entryprices/${symbol}`, { entry_price: price });
      showToast(`${symbol} entry price set to $${price}`, 'success');
      entryPricesData = await apiFetch('GET', '/api/entryprices');
      renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData);
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  // ── Portfolio Data Fetching ───────────────────────────────────────────────

  async function refreshBalances() {
    const data = await apiFetch('GET', '/api/balances');
    balancesData = data?.balances || [];
    revolutTotalUSD = data?.totalUSD || 0;
    // Don't overwrite the big portfolio-value here — renderTangemCard() sets
    // the combined Revolut + Kraken + Tangem total when Tangem loads.
    // Only set it if the portfolio-totals breakdown isn't visible yet.
    const totalsEl = document.getElementById('portfolio-totals');
    if (!totalsEl || totalsEl.style.display === 'none') {
      document.getElementById('portfolio-value').textContent = fmt(data.totalUSD);
    }
    renderHoldings(balancesData);
    renderPnlSummary(balancesData);
    return balancesData;
  }

  async function refreshStatus() {
    const data = await apiFetch('GET', '/api/status');
    statusData = data;
    renderAlerts(data.activeAlerts);
    renderMonitorStatus(data.paused);
    renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData);
    return data;
  }

  async function loadSweepConfig() {
    try {
      const data = await apiFetch('GET', '/api/system/config');
      const configRows = data?.config || [];
      const sweepRow = configRows.find(r => r.config_key === 'usdt_sweep_config');
      const sweepRaw = sweepRow?.config_value;
      const config = sweepRaw ? (typeof sweepRaw === 'string' ? JSON.parse(sweepRaw) : sweepRaw) : null;

      document.getElementById('sweep-loading').style.display = 'none';
      document.getElementById('sweep-content').style.display = '';

      const enabled = config?.enabled ?? false;
      const toggle = document.getElementById('sweep-enabled-toggle');
      toggle.checked = enabled;
      document.getElementById('sweep-status-label').textContent = enabled ? 'ON' : 'OFF';
      document.getElementById('sweep-status-label').style.color = enabled ? 'var(--accent)' : 'var(--text-muted)';
      toggle.addEventListener('change', () => {
        const on = toggle.checked;
        document.getElementById('sweep-status-label').textContent = on ? 'ON' : 'OFF';
        document.getElementById('sweep-status-label').style.color = on ? 'var(--accent)' : 'var(--text-muted)';
      });

      document.getElementById('sweep-pct-input').value = config?.sweep_pct ?? 20;
      document.getElementById('sweep-min-input').value = config?.min_trade_value_usd ?? 50;

      // Show current USDT balance
      try {
        const balData = await apiFetch('GET', '/api/balances');
        const usdt = (balData.balances || []).find(b => b.currency === 'USDT');
        const usdtVal = usdt ? (parseFloat(usdt.available) * (usdt.price || 1)) : 0;
        document.getElementById('sweep-usdt-balance').textContent = usdtVal > 0 ? fmt(usdtVal) : '$0.00';
      } catch (e) { document.getElementById('sweep-usdt-balance').textContent = '—'; }

    } catch (e) {
      document.getElementById('sweep-loading').textContent = 'Failed to load sweep config';
    }
  }

  async function saveSweepConfig() {
    const btn = document.getElementById('sweep-save-btn');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    try {
      const config = {
        enabled: document.getElementById('sweep-enabled-toggle').checked,
        sweep_pct: parseFloat(document.getElementById('sweep-pct-input').value) || 20,
        min_trade_value_usd: parseFloat(document.getElementById('sweep-min-input').value) || 50,
        applies_to: 'all',
        excluded_symbols: [],
        updated_at: new Date().toISOString(),
      };
      await apiFetch('POST', '/api/system/config', { key: 'usdt_sweep_config', value: JSON.stringify(config) });
      showToast(`USDT sweep ${config.enabled ? 'enabled' : 'disabled'} — ${config.sweep_pct}% of proceeds`, 'success');
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
    } catch (e) {
      showToast('Failed to save: ' + e.message, 'error');
      btn.textContent = 'Save';
      btn.disabled = false;
    }
  }

  async function refreshAll() {
    setLoading(true);
    showError('');
    try {
      // Quick health check — if this fails, server is down
      const health = await apiFetch('GET', '/api/health').catch(() => null);
      if (!health?.ok) {
        showError('Server unreachable — check Railway deployment');
        document.getElementById('last-updated').textContent = 'Server offline';
        setLoading(false);
        return;
      }
      await refreshBalances().catch(e => { console.error('refreshBalances failed:', e); });
      const [status, targets, entries, entryDetail, capital, tangem, tsData, histBasis] = await Promise.all([
        apiFetch('GET', '/api/status').catch(() => ({})),
        apiFetch('GET', '/api/targets').catch(() => ({})),
        apiFetch('GET', '/api/entryprices').catch(() => ({})),
        apiFetch('GET', '/api/entryprices/detail').catch(() => ({})),
        apiFetch('GET', '/api/capital').catch(() => null),
        apiFetch('GET', '/api/tangem').catch(() => null),
        apiFetch('GET', '/api/trailing-stops').catch(() => ({})),
        apiFetch('GET', '/api/historical-basis').catch(() => ({})),
      ]);
      statusData = status || {};
      targetsData = targets || {};
      entryPricesData = entries || {};
      entryDetailData = entryDetail || {};
      trailingStopsData = tsData || {};
      historicalBasisData = histBasis || {};
      try { renderAlerts(statusData.activeAlerts); } catch(e) { console.error('renderAlerts:', e); }
      try { renderMonitorStatus(statusData.paused); } catch(e) { console.error('renderMonitorStatus:', e); }
      try { renderThresholds(balancesData, statusData, targetsData, entryPricesData, trailingStopsData, entryDetailData); } catch(e) { console.error('renderThresholds:', e); }
      try { renderTrailSummary(trailingStopsData); } catch(e) { console.error('renderTrailSummary:', e); }
      try { if (capital) renderCapitalBar(capital); } catch(e) { console.error('renderCapitalBar:', e); }
      try { renderPnlSummary(balancesData); } catch(e) { console.error('renderPnlSummary:', e); }
      try { if (tangem) renderTangemCard(tangem).catch(e => console.error('renderTangemCard:', e)); } catch(e) { console.error('renderTangemCard sync:', e); }
      loadSweepConfig().catch(() => {});
      const now = new Date();
      document.getElementById('last-updated').textContent =
        'Updated ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      showError('Failed to load data: ' + e.message + '. Is the server running?');
      document.getElementById('last-updated').textContent = 'Update failed';
    } finally {
      setLoading(false);
    }
  }

  // ── Journal Form State ────────────────────────────────────────────────────

  let selectedAction = null;
  let selectedEmotion = null;
  let selectedFollowed = 'na';

  function selectAction(action) {
    selectedAction = action;
    document.querySelectorAll('#j-action-group .action-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.textContent.toLowerCase() === action);
    });
  }

  function selectEmotion(emotion) {
    selectedEmotion = emotion;
    document.querySelectorAll('#j-emotion-group .emotion-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.textContent.toLowerCase() === emotion);
    });
  }

  function selectFollowed(val) {
    selectedFollowed = val;
    document.querySelectorAll('#j-followed-group .action-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.textContent.toLowerCase() === val);
    });
  }

  // ── Journal Functions ─────────────────────────────────────────────────────

  async function loadJournalStats() {
    try {
      const stats = await apiFetch('GET', '/api/journal/stats');
      const winRateEl = document.getElementById('j-win-rate');
      winRateEl.textContent = stats.win_rate != null ? stats.win_rate + '%' : '—';
      winRateEl.style.color = stats.win_rate >= 50 ? 'var(--accent)' : 'var(--danger)';
      document.getElementById('j-total-trades').textContent = stats.total_trades ?? '—';
      const profitEl = document.getElementById('j-avg-profit');
      profitEl.textContent = stats.avg_profit != null ? '+' + stats.avg_profit + '%' : '—';
      const accEl = document.getElementById('j-claude-acc');
      const fw = stats.recommendation_accuracy?.followed_win_rate;
      accEl.textContent = fw != null ? fw + '%' : '—';
    } catch (e) {
      console.error('loadJournalStats:', e.message);
    }
  }

  async function loadLearning() {
    try {
      const data = await apiFetch('GET', '/api/learning');
      const el = document.getElementById('learning-text');
      if (data.summary) {
        el.textContent = data.summary;
      } else {
        el.textContent = 'No learning data yet — log some trades with outcomes first.';
        el.style.color = 'var(--text-muted)';
      }
    } catch (e) {
      document.getElementById('learning-text').textContent = 'Failed to load learning model.';
    }
  }

  async function loadJournal() {
    try {
      const entries = await apiFetch('GET', '/api/journal');
      renderJournalEntries(entries);
    } catch (e) {
      document.getElementById('journal-entries-list').innerHTML = '<div class="empty-state">Failed to load journal.</div>';
    }
  }

  function renderJournalEntries(entries) {
    const el = document.getElementById('journal-entries-list');
    if (!entries || entries.length === 0) {
      el.innerHTML = '<div class="empty-state">No trades logged yet. Use the form above or Telegram commands.</div>';
      return;
    }
    el.innerHTML = entries.map(e => {
      const coin = e.symbol ? e.symbol.replace('-USD', '') : '?';
      const actionClass = (e.action || 'hold').toLowerCase();
      const price = e.price ? '$' + parseFloat(e.price).toFixed(4) : '—';
      const emotion = e.emotion ? `<span class="je-emotion">${e.emotion}</span>` : '';
      let pnlBadge = '';
      if (e.outcome_pnl != null) {
        const pnl = parseFloat(e.outcome_pnl);
        pnlBadge = `<span class="je-pnl ${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</span>`;
      }
      const outcomeBtn = e.outcome == null
        ? `<button class="btn-outline btn-sm" onclick="toggleOutcomeForm(${e.id})">Log Outcome</button>`
        : `<span style="font-size:0.75rem;color:var(--text-muted)">${e.outcome}</span>`;
      const date = e.created_at ? new Date(e.created_at).toLocaleDateString() : '';
      return `
        <div class="journal-entry" id="je-${e.id}">
          <div class="je-header">
            <span class="je-action ${actionClass}">${e.action || '?'}</span>
            <span class="je-coin">${coin}</span>
            <span class="je-price">${price}</span>
            ${emotion}
            ${pnlBadge}
            <span style="margin-left:auto;font-size:0.72rem;color:var(--text-muted)">${date}</span>
            ${outcomeBtn}
          </div>
          ${e.reasoning ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px">${e.reasoning}</div>` : ''}
          <div class="outcome-form" id="outcome-form-${e.id}">
            <div class="outcome-row">
              <input class="form-input" type="number" id="op-${e.id}" placeholder="Exit price" step="any" min="0" style="width:130px" />
              <select class="form-input" id="oo-${e.id}" style="width:130px">
                <option value="">Outcome…</option>
                <option value="profit">Profit</option>
                <option value="loss">Loss</option>
                <option value="break-even">Break-even</option>
              </select>
              <input class="form-input" type="text" id="on-${e.id}" placeholder="Notes (optional)" style="flex:1;min-width:120px" />
              <button class="btn-accent btn-sm" onclick="logOutcome(${e.id})">Save</button>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function toggleOutcomeForm(id) {
    const form = document.getElementById('outcome-form-' + id);
    form.classList.toggle('open');
  }

  async function logOutcome(id) {
    const outcomePrice = parseFloat(document.getElementById('op-' + id).value);
    const outcome = document.getElementById('oo-' + id).value;
    const notes = document.getElementById('on-' + id).value;
    if (!outcomePrice || outcomePrice <= 0) { showToast('Enter a valid exit price', 'error'); return; }
    try {
      await apiFetch('POST', `/api/journal/${id}/outcome`, { outcome_price: outcomePrice, outcome, outcome_notes: notes });
      showToast('Outcome saved!', 'success');
      await loadJournal();
      await loadJournalStats();
      await loadLearning();
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  async function submitJournalEntry() {
    const coin = document.getElementById('j-coin').value.trim().toUpperCase();
    if (!coin) { showToast('Enter a coin symbol', 'error'); return; }
    if (!selectedAction) { showToast('Select an action', 'error'); return; }
    const price = parseFloat(document.getElementById('j-price').value) || null;
    const qty = parseFloat(document.getElementById('j-qty').value) || null;
    const reasoning = document.getElementById('j-reasoning').value.trim() || null;
    const followed = selectedFollowed === 'yes' ? true : selectedFollowed === 'no' ? false : null;
    try {
      await apiFetch('POST', '/api/journal/entry', {
        symbol: coin,
        action: selectedAction,
        price,
        quantity: qty,
        reasoning,
        emotion: selectedEmotion,
        followed_recommendation: followed
      });
      showToast('Trade logged!', 'success');
      // Reset form
      document.getElementById('j-coin').value = '';
      document.getElementById('j-price').value = '';
      document.getElementById('j-qty').value = '';
      document.getElementById('j-reasoning').value = '';
      selectedAction = null;
      selectedEmotion = null;
      selectedFollowed = 'na';
      document.querySelectorAll('.action-btn, .emotion-btn').forEach(b => b.classList.remove('selected'));
      document.querySelectorAll('#j-followed-group .action-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.textContent.toLowerCase() === 'na');
      });
      await loadJournal();
      await loadJournalStats();
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  // ── Profile Functions ─────────────────────────────────────────────────────

  async function loadProfile() {
    try {
      const rows = await apiFetch('GET', '/api/profile');
      const el = document.getElementById('profile-list');
      if (!rows || rows.length === 0) {
        el.innerHTML = '<div class="empty-state">No preferences saved yet.</div>';
        return;
      }
      el.innerHTML = rows.map(r => `
        <div class="profile-item">
          <span>${r.preference_value}</span>
        </div>
      `).join('');
    } catch (e) {
      console.error('loadProfile:', e.message);
    }
  }

  async function addPreference() {
    const val = document.getElementById('pref-input').value.trim();
    if (!val) { showToast('Enter a preference', 'error'); return; }
    try {
      await apiFetch('POST', '/api/profile', { key: 'pref_' + Date.now(), value: val });
      document.getElementById('pref-input').value = '';
      showToast('Preference saved!', 'success');
      await loadProfile();
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
    }
  }

  // ── Rebalancing Tab ───────────────────────────────────────────────────────

  window.rebalancingLoaded = false;
  let rbPositions = [];

  function drawDonut(canvas, counts) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const total = counts.winning + counts.small_loss + counts.moderate_loss + counts.severe_loss + counts.no_entry;
    if (total === 0) { ctx.fillStyle = '#333'; ctx.beginPath(); ctx.arc(W/2,H/2,50,0,Math.PI*2); ctx.fill(); return; }
    const slices = [
      { val: counts.winning,      color: '#00ffc8' },
      { val: counts.small_loss,   color: '#ffcc00' },
      { val: counts.moderate_loss,color: '#ff7800' },
      { val: counts.severe_loss,  color: '#ff4d6a' },
      { val: counts.no_entry,     color: '#444' },
    ].filter(s => s.val > 0);
    let angle = -Math.PI / 2;
    const cx = W/2, cy = H/2, outer = 54, inner = 32;
    for (const s of slices) {
      const sweep = (s.val / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + outer * Math.cos(angle), cy + outer * Math.sin(angle));
      ctx.arc(cx, cy, outer, angle, angle + sweep);
      ctx.arc(cx, cy, inner, angle + sweep, angle, true);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      angle += sweep;
    }
    ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI*2);
    ctx.fillStyle = '#1a1a1a'; ctx.fill();
    ctx.fillStyle = '#e8e8e8'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(total, cx, cy);
  }

  function getVerdict(pos) {
    if (pos.category === 'no_entry') return null;
    if (pos.category === 'winning') return 'HOLD';
    if (pos.category === 'severe_loss') return 'CUT';
    return 'WATCH';
  }

  function renderRbPositions(positions) {
    rbPositions = positions;
    const tbody = document.getElementById('rb-positions-body');
    if (!positions || positions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:20px">No positions found. Set entry prices in Portfolio tab.</td></tr>';
      return;
    }
    tbody.innerHTML = positions.map(p => {
      const pnlClass = p.unrealisedPnlPct == null ? '' : p.unrealisedPnlPct >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlPctStr = p.unrealisedPnlPct != null ? `${p.unrealisedPnlPct >= 0 ? '+' : ''}${p.unrealisedPnlPct.toFixed(1)}%` : '—';
      const pnlUsdStr = p.unrealisedPnlUsd != null ? `${p.unrealisedPnlUsd >= 0 ? '+' : ''}$${Math.abs(p.unrealisedPnlUsd).toFixed(0)}` : '—';
      const pnlUsdClass = p.unrealisedPnlUsd == null ? '' : p.unrealisedPnlUsd >= 0 ? 'pnl-positive' : 'pnl-negative';
      const recPct = p.recoveryNeededPct > 0 ? `${p.recoveryNeededPct.toFixed(0)}%` : '—';
      const verdict = getVerdict(p);
      const verdictHtml = verdict ? `<span class="verdict-badge ${verdict}" onclick="quickAnalyse('${p.coin}')">${verdict}</span>` : '<span style="color:var(--text-muted);font-size:0.75rem">no entry</span>';
      const entryStr = p.entryPrice ? fmtPrice(p.entryPrice) : '<span style="color:var(--text-muted)">—</span>';
      return `<tr>
        <td><strong>${p.coin}</strong></td>
        <td>$${p.currentValue.toFixed(0)}</td>
        <td>${entryStr}</td>
        <td class="${pnlClass}" style="font-weight:600">${pnlPctStr}</td>
        <td class="${pnlUsdClass}">${pnlUsdStr}</td>
        <td style="color:var(--warn)">${recPct}</td>
        <td><span class="cat-badge ${p.category}">${p.category.replace('_',' ')}</span></td>
        <td>${verdictHtml}</td>
      </tr>`;
    }).join('');
  }

  function renderCapCalc(positions) {
    const el = document.getElementById('cap-calc-list');
    const eligible = positions.filter(p => p.unrealisedPnlPct != null);
    if (eligible.length === 0) { el.innerHTML = '<div class="empty-state">Set entry prices to use this calculator.</div>'; return; }
    el.innerHTML = eligible.map(p => {
      const pnlStr = `${p.unrealisedPnlPct >= 0 ? '+' : ''}${p.unrealisedPnlPct.toFixed(1)}%`;
      const pnlClass = p.unrealisedPnlPct >= 0 ? 'pnl-positive' : 'pnl-negative';
      return `<div class="cap-row">
        <label>
          <input type="checkbox" class="cap-checkbox" data-value="${p.currentValue.toFixed(2)}" data-coin="${p.coin}" onchange="recalcFreed()">
          <span class="cap-coin">${p.coin}</span>
          <span class="cap-value">$${p.currentValue.toFixed(0)}</span>
          <span class="cap-pnl ${pnlClass}">${pnlStr}</span>
        </label>
      </div>`;
    }).join('');
    document.getElementById('freed-total-box').style.display = 'flex';
    recalcFreed();
  }

  function recalcFreed() {
    const checkboxes = document.querySelectorAll('.cap-checkbox:checked');
    const total = [...checkboxes].reduce((s, cb) => s + parseFloat(cb.dataset.value), 0);
    const count = checkboxes.length;
    document.getElementById('freed-amount').textContent = '$' + total.toFixed(0);
    document.getElementById('freed-count').textContent = `${count} position${count !== 1 ? 's' : ''} selected`;
  }

  async function loadRebalancingTracker() {
    try {
      const data = await apiFetch('GET', '/api/rebalancing-tracker');
      const meta = document.getElementById('rebal-tracker-meta');

      if (data.total > 0) {
        const bar = document.getElementById('rebal-accuracy-bar');
        bar.style.display = 'flex';
        document.getElementById('rebal-accuracy-pct').textContent = data.accuracy != null ? data.accuracy + '%' : '—';
        document.getElementById('rebal-accuracy-label').textContent = 'ACCURACY';
        document.getElementById('rebal-accuracy-sub').textContent = `${data.good}/${data.total} decisions`;
        document.getElementById('rebal-avg-pnl').textContent = data.avg_pnl_7d != null
          ? (parseFloat(data.avg_pnl_7d) >= 0 ? '+' : '') + data.avg_pnl_7d + '%'
          : '—';
        meta.textContent = `${data.history.length} rebalance${data.history.length !== 1 ? 's' : ''} logged`;
      } else {
        meta.textContent = 'No rebalances logged yet';
      }

      const tbody = document.getElementById('rebal-tracker-body');
      if (!data.history || data.history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px">No rebalances logged yet — use Telegram to log rebalancing moves</td></tr>';
        return;
      }
      tbody.innerHTML = data.history.map(r => {
        const date = new Date(r.rebalance_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const outPrice = parseFloat(r.out_price);
        const inPrice  = parseFloat(r.in_price);
        const pnl7 = r.pnl_7d != null ? parseFloat(r.pnl_7d) : null;
        const pnl30 = r.pnl_30d != null ? parseFloat(r.pnl_30d) : null;

        const fmt7 = pnl7 != null
          ? `<span style="color:${pnl7 >= 0 ? 'var(--accent)' : 'var(--danger)'}">${pnl7 >= 0 ? '+' : ''}${pnl7.toFixed(1)}%</span>`
          : '<span style="color:var(--text-muted)">Pending</span>';
        const fmt30 = pnl30 != null
          ? `<span style="color:${pnl30 >= 0 ? 'var(--accent)' : 'var(--danger)'}">${pnl30 >= 0 ? '+' : ''}${pnl30.toFixed(1)}%</span>`
          : '<span style="color:var(--text-muted)">Pending</span>';

        const outcome = r.outcome || 'pending';
        const outcomeBadge = `<span class="rebal-outcome-badge ${outcome}">${outcome === 'good' ? '✅ Good' : outcome === 'bad' ? '❌ Bad' : '⏳ Pending'}</span>`;
        const rowClass = outcome === 'good' ? 'row-good' : outcome === 'bad' ? 'row-bad' : '';

        return `<tr class="${rowClass}">
          <td style="white-space:nowrap">${date}</td>
          <td><strong>${r.out_symbol}</strong><br><span style="font-size:0.72rem;color:var(--text-muted)">$${outPrice.toFixed(4)}</span></td>
          <td><strong>${r.in_symbol}</strong><br><span style="font-size:0.72rem;color:var(--text-muted)">$${inPrice.toFixed(4)}</span></td>
          <td>${fmt7}</td>
          <td>${fmt30}</td>
          <td>${outcomeBadge}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      document.getElementById('rebal-tracker-meta').textContent = 'Failed to load';
      console.error('loadRebalancingTracker:', e.message);
    }
  }

  async function loadRebalancingData() {
    loadRebalancingTracker();
    try {
      const { positions, summary } = await apiFetch('GET', '/api/rebalancing/positions');

      // Draw donut
      drawDonut(document.getElementById('health-donut'), summary.categoryCount);

      // Update legend
      document.getElementById('leg-winning').textContent   = `Winning — ${summary.categoryCount.winning}`;
      document.getElementById('leg-small').textContent     = `Small loss (0–20%) — ${summary.categoryCount.small_loss}`;
      document.getElementById('leg-moderate').textContent  = `Moderate loss (20–50%) — ${summary.categoryCount.moderate_loss}`;
      document.getElementById('leg-severe').textContent    = `Severe loss (50%+) — ${summary.categoryCount.severe_loss}`;
      document.getElementById('leg-none').textContent      = `No entry set — ${summary.categoryCount.no_entry}`;

      // Stats
      document.getElementById('rb-total-value').textContent = fmt(summary.totalValue);
      document.getElementById('rb-total-loss').textContent = summary.totalLoss < 0 ? '-' + fmt(Math.abs(summary.totalLoss)) : fmt(summary.totalLoss);
      document.getElementById('rb-recovery-pct').textContent = summary.totalLossPct > 0 ? summary.totalLossPct.toFixed(1) + '%' : '—';

      renderRbPositions(positions);
      renderCapCalc(positions);

      // Load latest stored analysis
      const latest = await apiFetch('GET', '/api/rebalancing/latest').catch(() => null);
      if (latest && latest.analysis) {
        document.getElementById('rb-analysis-text').textContent = latest.analysis;
        document.getElementById('rb-analysis-date').textContent =
          'Last analysis: ' + new Date(latest.created_at).toLocaleString();
      }
    } catch (e) {
      console.error('loadRebalancingData:', e.message);
    }
  }

  async function runRebalancingAnalysis() {
    const btn = document.getElementById('rb-refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Analysing…';
    document.getElementById('rb-analysis-text').textContent = '🔍 Asking Claude for rebalancing recommendations… this may take 30-60 seconds.';
    try {
      const result = await apiFetch('POST', '/api/rebalancing', {});
      document.getElementById('rb-analysis-text').textContent = result.analysis;
      document.getElementById('rb-analysis-date').textContent = 'Last analysis: ' + new Date().toLocaleString();
      showToast('Analysis complete!', 'success');
    } catch (e) {
      document.getElementById('rb-analysis-text').textContent = 'Analysis failed: ' + e.message;
      showToast('Analysis failed', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh Analysis';
    }
  }

  async function quickAnalyse(coin) {
    showToast(`Sending '${coin}' analysis to Telegram…`, 'success');
    // Telegram command handled server-side — just inform user to type it
    showToast(`Type 'rebalance ${coin}' in Telegram for deep analysis`, '');
  }

  // ── Kraken Tab ────────────────────────────────────────────────────────────

  async function loadKrakenTab() {
    document.getElementById('kraken-status').textContent = 'Fetching…';
    try {
      const data = await apiFetch('GET', '/api/kraken/balances');
      const totalEl = document.getElementById('kraken-total');
      const statusEl = document.getElementById('kraken-status');
      const holdingsEl = document.getElementById('kraken-holdings');

      if (!data || data.balances.length === 0) {
        totalEl.textContent = '$0.00';
        statusEl.textContent = 'No assets found on Kraken';
        holdingsEl.innerHTML = '<div class="empty-state">No Kraken holdings detected.</div>';
        return;
      }

      totalEl.textContent = '$' + (data.totalUSD || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      statusEl.textContent = `${data.balances.length} asset(s) · Updated ${new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}`;

      holdingsEl.innerHTML = data.balances.map(a => {
        const pnlPct = a.unrealisedPnlPct;
        const pnlClass = pnlPct != null ? (pnlPct >= 0 ? 'pnl-pos' : 'pnl-neg') : '';
        const pnlStr = pnlPct != null
          ? `<span class="${pnlClass}" style="font-size:0.8rem">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ${pnlPct >= 0 ? '🟢' : '🔴'}</span>`
          : '';
        const entryStr = a.entryPrice
          ? `<div style="font-size:0.75rem;color:var(--text-muted)">Entry: ${fmtPrice(a.entryPrice)} ${pnlStr}</div>`
          : '';
        return `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
            <div>
              <div style="font-weight:700;font-size:1rem">${a.standard}</div>
              <div style="font-size:0.8rem;color:var(--text-muted)">${a.quantity.toFixed(4)} @ ${fmtPrice(a.price)}</div>
              ${entryStr}
            </div>
            <div style="text-align:right">
              <div style="font-weight:600">${a.valueUSD ? '$' + a.valueUSD.toFixed(2) : '—'}</div>
              <div style="font-size:0.75rem;color:var(--text-muted)">Kraken</div>
            </div>
          </div>`;
      }).join('');
    } catch (e) {
      document.getElementById('kraken-status').textContent = 'Error: ' + e.message;
      document.getElementById('kraken-holdings').innerHTML = '<div class="empty-state">Could not load Kraken data.</div>';
    }
  }

  async function submitKrakenTrade() {
    const side      = document.getElementById('k-side').value;
    const symbol    = document.getElementById('k-symbol').value.trim().toUpperCase();
    const volume    = parseFloat(document.getElementById('k-volume').value);
    const orderType = document.getElementById('k-ordertype').value;
    const priceVal  = parseFloat(document.getElementById('k-price').value) || null;

    if (!symbol) { showToast('Enter a symbol e.g. ZK', 'error'); return; }
    if (!volume || volume <= 0) { showToast('Enter a valid volume > 0', 'error'); return; }
    if (orderType === 'limit' && !priceVal) { showToast('Enter a limit price', 'error'); return; }

    const sym = symbol.includes('-USD') ? symbol : `${symbol}-USD`;
    document.getElementById('k-trade-preview').textContent = 'Sending approval request to Telegram…';
    try {
      await apiFetch('POST', '/api/kraken/trade', {
        symbol: sym, side, orderType, volume, price: priceVal, approved: true
      });
      showToast('Trade sent for Telegram approval — reply "approve trade" to execute', 'success');
      document.getElementById('k-trade-preview').textContent = '✅ Approval request sent to Telegram';
    } catch (e) {
      showToast('Failed: ' + e.message, 'error');
      document.getElementById('k-trade-preview').textContent = '';
    }
  }

  // Live trade preview
  ['k-side','k-symbol','k-volume','k-ordertype','k-price'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      const side   = document.getElementById('k-side').value;
      const symbol = document.getElementById('k-symbol').value.trim().toUpperCase() || '?';
      const volume = document.getElementById('k-volume').value || '?';
      const ot     = document.getElementById('k-ordertype').value;
      const price  = document.getElementById('k-price').value;
      const priceStr = price ? ` @ $${price}` : (ot === 'market' ? ' @ market price' : '');
      document.getElementById('k-trade-preview').textContent =
        volume !== '?' ? `Preview: ${side.toUpperCase()} ${volume} ${symbol}${priceStr}` : '';
    });
  });

  // ── Activity Feed ─────────────────────────────────────────────────────────

  let currentFilter = 'all';

  const ACTION_COLORS = {
    buy: '#00ff88', sell: '#ff4444', payment: '#ffaa00',
    transfer: '#888888', sweep: '#4488ff'
  };

  function formatQty(qty, symbol) {
    const q = Math.abs(parseFloat(qty));
    if (!q) return '';
    if (q >= 1000000) return (q / 1000000).toFixed(2) + 'M';
    if (q >= 1000)    return (q / 1000).toFixed(2) + 'K';
    if (q < 0.001)    return q.toExponential(4);
    return q.toFixed(4);
  }

  function formatPriceDisplay(price) {
    const p = parseFloat(price);
    if (!p) return '';
    if (p < 0.000001) return '$' + p.toFixed(10);
    if (p < 0.0001)   return '$' + p.toFixed(8);
    if (p < 0.01)     return '$' + p.toFixed(6);
    if (p < 1)        return '$' + p.toFixed(4);
    return '$' + p.toFixed(2);
  }

  async function loadActivity(filter = 'all') {
    const feedEl = document.getElementById('activity-feed');
    if (!feedEl) return;
    feedEl.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
      // Bypass apiFetch so we can read the actual error body on non-2xx responses
      const url = `/api/activity?limit=50&filter=${encodeURIComponent(filter)}`;
      const response = await fetch(BASE + url);
      const text = await response.text();

      if (!response.ok) {
        // Show the actual server error, not just the status code
        feedEl.innerHTML = `<p style="color:var(--danger);text-align:center;padding:16px;font-size:0.8rem">
          HTTP ${response.status}: ${text.substring(0, 300)}</p>`;
        console.error('[activity] Server error', response.status, text.substring(0, 300));
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        feedEl.innerHTML = `<p style="color:var(--danger);text-align:center;padding:16px;font-size:0.8rem">
          JSON parse error: ${text.substring(0, 200)}</p>`;
        console.error('[activity] JSON parse error:', parseErr.message, text.substring(0, 200));
        return;
      }

      if (!data.trades?.length) {
        feedEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px">No activity yet</p>';
        return;
      }

      feedEl.innerHTML = data.trades.map(t => {
        const date    = new Date(t.created_at);
        const timeStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                      + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const color   = ACTION_COLORS[t.action] || '#888';
        const pnl     = t.outcome_pnl ? parseFloat(t.outcome_pnl) : null;

        const pnlBadge = pnl != null
          ? `<span class="pnl-badge" style="color:${pnl >= 0 ? 'var(--accent)' : 'var(--danger)'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>`
          : '';
        const qtyStr  = t.quantity ? formatQty(t.quantity, t.symbol) : '';
        const priceStr = t.price   ? formatPriceDisplay(t.price)     : '';
        const valStr  = t.value_usd ? ` = $${parseFloat(t.value_usd).toFixed(2)}` : '';
        const detailParts = [qtyStr, priceStr ? `@ ${priceStr}` : '', valStr].filter(Boolean);
        const sourceTag = t.source && t.source !== 'auto_detected'
          ? `<span style="color:#555;font-size:0.68rem;margin-left:6px">[${t.source.replace('_',' ')}]</span>` : '';
        return `<div class="activity-item" id="activity-${t.id}" style="border-left-color:${color}">
          <div class="activity-header">
            <div><span class="activity-action" style="color:${color}">${t.action}</span><span class="activity-symbol">${t.symbol}</span>${pnlBadge}${sourceTag}</div>
            <span class="activity-time">${timeStr}</span>
          </div>
          ${detailParts.length ? `<div class="activity-details">${detailParts.join(' ')}</div>` : ''}
          <div class="activity-reason" id="reason-display-${t.id}">
            <span class="activity-reason-text">📋 ${t.reasoning || '<em>No reason logged</em>'}</span>
            <button class="activity-edit-btn" onclick="editActivity(${t.id})">Edit</button>
          </div>
          <div class="activity-edit-form" id="reason-edit-${t.id}">
            <select id="action-edit-${t.id}">${['buy','sell','payment','transfer','sweep'].map(a=>`<option value="${a}"${t.action===a?' selected':''}>${a.charAt(0).toUpperCase()+a.slice(1)}</option>`).join('')}</select>
            <textarea id="reason-input-${t.id}" rows="2">${t.reasoning || ''}</textarea>
            <div class="activity-edit-actions"><button class="activity-save-btn" onclick="saveActivity(${t.id})">Save</button><button class="activity-cancel-btn" onclick="cancelEdit(${t.id})">Cancel</button></div>
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      console.error('[activity] JS error:', e);
      feedEl.innerHTML = `<p style="color:var(--danger);text-align:center;padding:16px">JS Error: ${e.message}</p>`;
    }
  }
  
  // ── Bootstrap ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function() {
    refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  });
/option>`).join('')}</select>
            <textarea id="reason-input-${t.id}" rows="2">${t.reasoning || ''}</textarea>
            <div class="activity-edit-actions"><button class="activity-save-btn" onclick="saveActivity(${t.id})">Save</button><button class="activity-cancel-btn" onclick="cancelEdit(${t.id})">Cancel</button></div>
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      console.error('[activity] JS error:', e);
      feedEl.innerHTML = '<p style="color:var(--danger);text-align:center;padding:16px">JS Error: ' + e.message + '</p>';
    }
  }

  // Bootstrap
  document.addEventListener('DOMContentLoaded', function() {
    refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  });
