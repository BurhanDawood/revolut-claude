// Desk #59 (Bryan 15 Oct 14:56): the Rip alarm card's "Watch link" block, under its "Change ›" row (More → Notifications).
// The card is the shell's; the app adds this block after each shell load (WatchLinkCard), so the server is unchanged.
// It shows what the phone sees (RxWatch.status: the connected watches, the last forward) and sends a TEST alarm straight to
// the watch (RxWatch.sendTest). Text only (textContent), and its taps stop here: they never reach the card's own click handler.
(function () {
  'use strict';
  if (window !== window.top || window.__rxWatchLink) return;
  window.__rxWatchLink = true;
  function plugin() { var C = window.Capacitor; return C && C.Plugins ? C.Plugins.RxWatch || null : null; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function time(ms) {
    try { return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return ''; }
  }
  function render(box, r) {
    box.textContent = '';
    box.appendChild(el('div', 'rxw-h', '⌚ Watch link'));
    if (!r) { box.appendChild(el('div', 'rxw-l', 'Checking…')); return; }
    var nodes = r.nodes || [];
    if (!nodes.length) box.appendChild(el('div', 'rxw-l rxw-bad', 'No watch found' + (r.error ? ' (' + r.error + ')' : '')));
    nodes.forEach(function (n) {
      box.appendChild(el('div', 'rxw-l', (n.name || '?') + ' · ' + n.id + (n.nearby ? '' : ' · not nearby') +
        (n.app ? ' · watch app found' : ' · watch app not seen')));
    });
    var l = r.last;
    box.appendChild(l
      ? el('div', 'rxw-l ' + (l.ok ? 'rxw-ok' : 'rxw-bad'), 'Last forward ' + time(l.at) + ' · ' + l.path + ' · ' + (l.ok ? 'OK' : 'FAILED') +
          ' · ' + l.result + (l.to ? ' → ' + l.to : ''))
      : el('div', 'rxw-l', 'Last forward: none yet'));
    var b = el('span', 'rxw-b', 'Send test to watch');
    b.setAttribute('role', 'button');
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var p = plugin(); if (!p || b.getAttribute('data-busy')) return;
      b.setAttribute('data-busy', '1'); b.textContent = 'Sending…';
      Promise.resolve(p.sendTest()).then(function (r2) { render(box, r2); }, function () { b.textContent = 'Could not send'; b.removeAttribute('data-busy'); });
    });
    box.appendChild(b);
  }
  function refresh(box) {
    var p = plugin();
    if (!p || !p.status) { box.textContent = ''; box.appendChild(el('div', 'rxw-l', 'Watch link needs app-v42')); return; }
    Promise.resolve(p.status()).then(function (r) { if (box.isConnected) render(box, r); }, function () {});
  }
  function place() {
    var a = document.querySelector('button.nf-tone[data-tone="alarm"]');
    if (!a || !a.parentNode || (a.nextElementSibling && a.nextElementSibling.classList.contains('rxw'))) return;
    var box = el('div', 'rxw');
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    a.parentNode.insertBefore(box, a.nextSibling);
    render(box, null);
    refresh(box);
  }
  function start() {
    var st = el('style');
    st.textContent = '.rxw{margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.05);font-size:12px;line-height:1.45;color:#aaa;overflow-wrap:anywhere}' +
      '.rxw-h{font-weight:600;color:#ddd;margin-bottom:2px}.rxw-ok{color:#00ffc8}.rxw-bad{color:#ff4d6a}' +
      '.rxw-b{display:inline-block;margin-top:6px;padding:6px 12px;border-radius:8px;background:#00ffc8;color:#000;font-weight:600;cursor:pointer}';
    document.head.appendChild(st);
    new MutationObserver(place).observe(document.body, { childList: true, subtree: true });
    place();
    setInterval(function () { var b = document.querySelector('.rxw'); if (b && b.offsetParent) refresh(b); }, 15000);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
