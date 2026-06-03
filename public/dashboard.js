var DASHBOARD_VERSION = '2.0.0';
console.log('Dashboard v' + DASHBOARD_VERSION);

window.onerror = function(msg,src,line) {
  var b = document.getElementById('error-banner');
  if(b) { b.textContent='JS Error line '+line+': '+msg; b.style.display='block'; }
};

function fmt(p) {
  p = parseFloat(p||0);
  if(!p) return '$0';
  if(p<0.000001) return '$'+p.toFixed(10);
  if(p<0.0001) return '$'+p.toFixed(8);
  if(p<0.01) return '$'+p.toFixed(6);
  if(p<1) return '$'+p.toFixed(4);
  return '$'+p.toFixed(2);
}

function setEl(id, text, color) {
  var el = document.getElementById(id);
  if(!el) return;
  if(text!==undefined) el.textContent = text;
  if(color) el.style.color = color;
}

function fetchData(url) {
  return fetch(url).then(function(r) {
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }).catch(function(e) {
    console.error('Fetch error '+url+':', e.message);
    return null;
  });
}

function showTab(name) {
  ['portfolio','activity','journal','kraken','rebalancing'].forEach(function(t) {
    var tab = document.getElementById('tab-'+t);
    if(tab) tab.classList.remove('active');
  });
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  var pane = document.getElementById('tab-'+name);
  if(pane) pane.classList.add('active');
  if(typeof event !== 'undefined' && event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  }
  if(name==='activity') loadActivity('all');
  if(name==='portfolio') loadPortfolio();
  if(name==='kraken') loadKraken();
}

function filterActivity(f) {
  loadActivity(f);
}

function loadPortfolio() {
  fetchData('/portfolio/summary').then(function(d) {
    if(!d) { setEl('portfolio-value','Error'); return; }

    var revCrypto = parseFloat(d.total_value_usd||0);
    var cashUSD   = parseFloat(d.cash_usd||0);
    var cashUSDT  = parseFloat(d.cash_usdt||0);
    var revCash   = cashUSD + cashUSDT;
    var krakenCrypto = parseFloat(d.kraken_total_usd||0);
    var krakenCash   = 0;

    var tangemVal = 0, tangemXRP = 0, tangemEntry = 2.65;
    if(d.tangem) {
      tangemVal   = parseFloat(d.tangem.valueUSD||0);
      tangemXRP   = parseFloat(d.tangem.balance||0);
      tangemEntry = parseFloat(d.tangem.entryPrice||2.65);
    }
    var tangemUSD = parseFloat(d.tangem_value_usd||0);
    if(tangemUSD) tangemVal = tangemUSD;
    if(!tangemVal) tangemVal = 1008.43 * 1.2175;

    var totalCrypto = revCrypto + krakenCrypto + tangemVal;
    var totalCash   = revCash + krakenCash;
    var grandTotal  = totalCrypto + totalCash;

    setEl('portfolio-value',      '$'+grandTotal.toFixed(2));
    setEl('portfolio-total-sum',  '$'+grandTotal.toFixed(2));
    setEl('portfolio-crypto-sum', '$'+totalCrypto.toFixed(2));
    setEl('portfolio-cash-sum',   '$'+totalCash.toFixed(2));
    setEl('revolut-crypto-subtotal', '$'+revCrypto.toFixed(2));
    setEl('revolut-cash-subtotal',   '$'+revCash.toFixed(2));
    setEl('kraken-total',            krakenCrypto>0?'$'+krakenCrypto.toFixed(2):'$0');
    setEl('kraken-crypto-subtotal',  krakenCrypto>0?'$'+krakenCrypto.toFixed(2):'$0');
    setEl('kraken-cash-subtotal',    '$'+krakenCash.toFixed(2));
    setEl('tangem-value-usd',  '$'+tangemVal.toFixed(2));
    setEl('tangem-xrp-qty',    tangemXRP>0?tangemXRP.toFixed(2)+' XRP':'—');
    setEl('tangem-subtotal',   '$'+tangemVal.toFixed(2));
    if(tangemEntry>0 && tangemXRP>0) {
      var tangemPrice = tangemVal / tangemXRP;
      var tPl    = ((tangemPrice - tangemEntry) / tangemEntry * 100);
      var tPlUsd = tangemXRP * (tangemPrice - tangemEntry);
      setEl('tangem-pnl-pct', (tPl>=0?'+':'')+tPl.toFixed(1)+'%', tPl>=0?'#00ff88':'#ff4444');
      setEl('tangem-pnl-usd', (tPlUsd>=0?'+':'')+' $'+Math.abs(tPlUsd).toFixed(2), tPlUsd>=0?'#00ff88':'#ff4444');
    }

    var inv      = parseFloat(d.invested||0);
    var plUsd    = parseFloat(d.pl_usd||0);
    var plPct    = parseFloat(d.pl_pct||0);
    var breakEven = inv>0 && grandTotal>0 ? ((inv-grandTotal)/grandTotal*100) : 0;
    setEl('cap-invested',  '$'+inv.toFixed(2));
    setEl('cap-current',   '$'+grandTotal.toFixed(2));
    setEl('cap-pnl',
      (plUsd>=0?'+':'')+'$'+Math.abs(plUsd).toFixed(2)+' ('+(plPct>=0?'+':'')+plPct.toFixed(1)+'%)',
      plUsd>=0?'#00ff88':'#ff4444');
    setEl('cap-breakeven', '+'+breakEven.toFixed(1)+'% needed', '#ffaa00');

    var positions = d.positions||[];
    var winners=0, losers=0, totalUnreal=0;
    positions.forEach(function(p) {
      var ep=parseFloat(p.entry_price||0), cp=parseFloat(p.current_price||0), qty=parseFloat(p.quantity||0);
      var pu = (ep&&cp&&qty) ? (cp-ep)*qty : 0;
      totalUnreal += pu;
      if(pu>0) winners++; else if(pu<0) losers++;
    });
    setEl('pnl-winners',      winners+' winning');
    setEl('pnl-losers',       losers+' losing');
    setEl('pnl-total-unreal', (totalUnreal>=0?'+':'')+'$'+Math.abs(totalUnreal).toFixed(2), totalUnreal>=0?'#00ff88':'#ff4444');

    positions.sort(function(a,b) { return parseFloat(b.value_usd||0)-parseFloat(a.value_usd||0); });
    var html='';
    for(var i=0;i<positions.length;i++) {
      var pos=positions[i];
      var val=parseFloat(pos.value_usd||0);
      if(val<1) continue;
      var cp=parseFloat(pos.current_price||0), ep=parseFloat(pos.entry_price||0);
      var pl=ep>0?((cp-ep)/ep*100):0, plc=pl>=0?'#00ff88':'#ff4444';
      var hb=parseFloat(pos.historical_basis||0), histLine='';
      if(hb>0&&ep>0&&Math.abs(hb-ep)>0.000001) {
        var hpl=((cp-hb)/hb*100), hc=hpl>=0?'#00ff88':'#ff4444';
        histLine='<br><span style="color:#555;font-size:10px">Hist: '+fmt(hb)+' <span style="color:'+hc+'">'+(hpl>=0?'+':'')+hpl.toFixed(1)+'%</span></span>';
      }
      var cy=parseInt(pos.cycle_count||0);
      var cyLine=cy>0?'<br><span style="color:#444;font-size:10px">'+cy+' cycle(s)</span>':'';
      html+='<div style="border-left:3px solid '+plc+';padding:10px 12px;margin-bottom:8px;background:#1a1a1a;border-radius:4px">'
        +'<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        +'<span style="color:white;font-weight:bold">'+pos.currency+'</span>'
        +'<span style="color:white;font-weight:bold">$'+val.toFixed(2)+'</span></div>'
        +'<div style="font-size:11px;color:#888">'
        +(ep>0?'Entry: '+fmt(ep)+' | Now: '+fmt(cp)+' | <span style="color:'+plc+'">'+(pl>=0?'+':'')+pl.toFixed(1)+'%</span>':'Now: '+fmt(cp))
        +histLine+cyLine+'</div></div>';
    }
    var hEl=document.getElementById('holdings-list');
    if(hEl) hEl.innerHTML=html||'<p style="color:#888">No positions</p>';
    setEl('last-updated','Updated '+new Date().toLocaleTimeString('en-GB'));
  });
}

function loadKraken() {
  fetchData('/api/kraken/balances').then(function(data) {
    var el=document.getElementById('kraken-holdings');
    if(!el||!data||!data.balances) return;
    var bals=data.balances.filter(function(b) { return parseFloat(b.valueUSD||0)>=1; });
    bals.sort(function(a,b) { return parseFloat(b.valueUSD||0)-parseFloat(a.valueUSD||0); });
    var html='';
    for(var i=0;i<bals.length;i++) {
      var b=bals[i], val=parseFloat(b.valueUSD||0);
      var ep=parseFloat(b.entryPrice||0), cp=parseFloat(b.price||0);
      var pl=ep>0?((cp-ep)/ep*100):0, plc=pl>=0?'#00ff88':'#ff4444';
      html+='<div style="border-left:3px solid '+plc+';padding:8px 12px;margin-bottom:6px;background:#111;border-radius:4px">'
        +'<div style="display:flex;justify-content:space-between">'
        +'<span style="color:#aaa;font-weight:bold">'+b.standard+'</span>'
        +'<span style="color:#aaa">$'+val.toFixed(2)+'</span></div>'
        +(ep>0?'<div style="color:#666;font-size:10px">'+fmt(ep)+' entry | <span style="color:'+plc+'">'+(pl>=0?'+':'')+pl.toFixed(1)+'%</span></div>':'')
        +'</div>';
    }
    el.innerHTML=html||'<p style="color:#555;font-size:12px">No holdings</p>';
    setEl('kraken-status','Connected');
  });
}

function loadSweepConfig() {
  fetchData('/api/sweep/config').then(function(d) {
    if(!d) return;
    var pct=document.getElementById('sweep-pct-input');
    var min=document.getElementById('sweep-min-input');
    var tog=document.getElementById('sweep-enabled-toggle');
    var bal=document.getElementById('sweep-usdt-balance');
    var lbl=document.getElementById('sweep-status-label');
    if(pct) pct.value=d.sweep_pct||25;
    if(min) min.value=d.min_trade_value_usd||10;
    if(tog) tog.checked=d.enabled!==false;
    if(bal) bal.textContent='$'+parseFloat(d.usdt_reserve||0).toFixed(2);
    if(lbl) lbl.textContent=d.enabled?'ON':'OFF';
  });
}

function saveSweepConfig() {
  var pct=document.getElementById('sweep-pct-input');
  var min=document.getElementById('sweep-min-input');
  var tog=document.getElementById('sweep-enabled-toggle');
  if(!pct||!min) return;
  fetch('/api/sweep/config',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({sweep_pct:parseFloat(pct.value),min_trade_value_usd:parseFloat(min.value),enabled:tog?tog.checked:true})
  }).then(function(r) { if(r.ok) alert('Saved'); });
}

function loadActivity(filter) {
  filter=filter||'all';
  var el=document.getElementById('activity-feed');
  if(!el) return;
  el.innerHTML='<p style="color:#888">Loading...</p>';
  fetchData('/api/activity?limit=50&filter='+encodeURIComponent(filter)).then(function(data) {
    if(!data||!data.trades||!data.trades.length) { el.innerHTML='<p style="color:#888">No activity</p>'; return; }
    var colors={buy:'#00ff88',sell:'#ff4444',payment:'#ffaa00',transfer:'#888',sweep:'#4488ff',rebalance:'#aa44ff'};
    var html='';
    for(var i=0;i<data.trades.length;i++) {
      var t=data.trades[i], c=colors[t.action]||'#888';
      var ds=new Date(t.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
      var qty=parseFloat(t.quantity||0);
      var qs=qty>=1000000?(qty/1000000).toFixed(2)+'M':qty>=1000?(qty/1000).toFixed(2)+'K':qty.toFixed(4);
      var val=t.value_usd?'$'+parseFloat(t.value_usd).toFixed(2):'';
      var pnl=t.outcome_pnl?parseFloat(t.outcome_pnl):null;
      var pstr=pnl!==null?'<span style="color:'+(pnl>=0?'#00ff88':'#ff4444')+';margin-left:8px;font-size:11px">'+(pnl>=0?'+':'')+'$'+Math.abs(pnl).toFixed(2)+'</span>':'';
      html+='<div style="border-left:3px solid '+c+';padding:10px 12px;margin-bottom:8px;background:#1a1a1a;border-radius:4px">'
        +'<div style="display:flex;justify-content:space-between;margin-bottom:4px"><div>'
        +'<span style="color:'+c+';font-weight:bold;font-size:11px;text-transform:uppercase">'+t.action+'</span>'
        +'<span style="color:white;font-weight:bold;margin-left:6px">'+t.symbol+'</span>'+pstr
        +'</div><span style="color:#666;font-size:11px">'+ds+'</span></div>'
        +'<div style="color:#aaa;font-size:12px;margin-bottom:4px">'+qs+' @ '+fmt(t.price)+(val?' = '+val:'')+'</div>'
        +'<div style="color:#666;font-size:11px">'+(t.reasoning||'No reason logged')+'</div></div>';
    }
    el.innerHTML=html;
  });
}

document.addEventListener('DOMContentLoaded', function() {
  loadPortfolio();
  loadSweepConfig();
  setInterval(loadPortfolio, 300000);
});
