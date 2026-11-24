/* PX Live Board — public, read-only view for players (no login).
 * Players find their name once; the board then shows their spot in line,
 * a live ETA, and buzzes when they're called to a court.
 */
'use strict';
(() => {
  const cfg = window.PXM_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const code = (params.get('c') || '').trim().toLowerCase();
  const tv = params.get('tv') === '1';
  const ME_KEY = 'pxb:me:' + code;
  const POLL_MS = 8000;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  const mins = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };

  let data = null, skew = 0, lastOk = 0, failCount = 0;
  let me = store.get(ME_KEY);
  let lastStatus = null, search = '';
  let audio = null;

  if (tv) document.body.classList.add('tv');

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  async function fetchBoard() {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/get_board`, {
      method: 'POST',
      headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: code }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
    return res.json();
  }

  async function poll() {
    try {
      const d = await fetchBoard();
      failCount = 0;
      if (!d) { data = null; renderMissing(); return; }
      skew = d.now - Date.now();
      lastOk = Date.now();
      data = d;
      render();
    } catch (e) {
      failCount++;
      setLive(false, failCount > 2 ? 'Reconnecting…' : null);
    }
  }

  const now = () => Date.now() + skew;

  function derive() {
    const players = data.players || [];
    const byId = new Map(players.map((p) => [p.id, p]));
    const queue = players.filter((p) => p.status === 'queue').sort((a, b) => a.qpos - b.qpos);
    const need = (data.team_size === 1 ? 1 : 2) * 2;
    const courts = data.courts || [];
    const avg = PXEta.avgGame(data.recent || []);
    const etas = PXEta.forQueue(courts.map((c) => ({ active: c.active, start: c.match ? c.match.start : null })), queue.length, need, avg, now());
    const courtOf = (id) => courts.find((c) => c.match && [...c.match.a, ...c.match.b].includes(id));
    const mateOf = (p) => { const m = p && p.partner_id && byId.get(p.partner_id); return m && m.partner_id === p.id && data.team_size !== 1 ? m : null; };
    return { players, byId, queue, courts, etas, avg, courtOf, mateOf };
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function setLive(ok, text) {
    $('#live').classList.toggle('off', !ok);
    $('#updated').textContent = text || (ok ? 'Live' : 'Offline');
  }

  function renderMissing() {
    $('#club-name').textContent = 'Live Board';
    setLive(false, 'Not found');
    $('#board').innerHTML = `<div class="card empty"><h3>Board not found</h3><p>This link may be old or mistyped. Ask the organizer to show the QR code again.</p></div>`;
  }

  function render() {
    const D = derive();
    document.title = `${data.name} · Live Board`;
    $('#club-name').textContent = data.name;
    setLive(true, 'Live');
    const meP = me ? D.byId.get(me) : null;
    checkCalled(meP, D);

    let h = '';
    if (!tv) h += meCard(meP, D);

    h += `<div class="board-grid"><section>
      <h2 class="section-h">Courts</h2>
      <div class="courts">${D.courts.filter((c) => c.active).map((c) => courtTile(c, D, meP)).join('') || '<p class="muted">No courts open.</p>'}</div>
    </section><section>
      <h2 class="section-h">In line <small>${D.queue.length} waiting · games ~${Math.round(D.avg / 60000)} min</small></h2>
      ${D.queue.length ? `<div class="list">${D.queue.map((p, i) => {
        const mate = D.mateOf(p);
        return `<div class="li ${meP && p.id === meP.id ? 'soon' : ''}">
          <span class="pos">${i + 1}</span>
          <span class="main"><span class="t">${esc(p.name)}</span>${mate ? `<span class="s">with ${esc(mate.name)}</span>` : ''}</span>
          <span class="eta"><b>${esc(PXEta.label(D.etas[i]))}</b><small>${mins(now() - p.wait_since)}</small></span>
        </div>`;
      }).join('')}</div>` : '<div class="card empty"><p>Nobody waiting. Courts are open!</p></div>'}
    </section>
    ${tv ? tvQr() : ''}</div>`;

    if (!tv) h += `<p class="foot">Updates every few seconds · Powered by Pickle <b>X</b> Matcher</p>`;
    $('#board').innerHTML = h;
  }

  function courtTile(c, D, meP) {
    if (!c.match) return `<article class="court open"><div class="court-h"><b>${esc(c.name)}</b><span class="streak">Open</span></div></article>`;
    const mine = meP && [...c.match.a, ...c.match.b].includes(meP.id);
    const team = (ids, side) => `<div class="team team-${side}">${ids.map((id) => `<span class="chip"><span class="nm">${esc((D.byId.get(id) || {}).name || 'Player')}</span></span>`).join('')}</div>`;
    return `<article class="court live ${mine ? 'mine' : ''}">
      <div class="court-h"><b>${esc(c.name)}</b><span class="timer">${mins(now() - c.match.start)}</span></div>
      <div class="match">${team(c.match.a, 'a')}<span class="vs">VS</span>${team(c.match.b, 'b')}</div>
    </article>`;
  }

  function meCard(meP, D) {
    if (!me) return pickCard(D);
    if (!meP) {
      return `<section class="me-card"><h2>You're not checked in</h2><p class="muted">Ask the organizer to check you in, then you'll appear here.</p>
        <button class="btn block" data-act="change">Not you? Pick your name</button></section>`;
    }
    const mate = D.mateOf(meP);
    let body;
    if (meP.status === 'playing') {
      const c = D.courtOf(meP.id);
      body = `<div class="me-status playing"><span class="big">Go to ${esc(c ? c.name : 'your court')}!</span><span>You're playing now. Have fun!</span></div>`;
    } else if (meP.status === 'queue') {
      const i = D.queue.findIndex((p) => p.id === meP.id);
      const eta = D.etas[i];
      const nextUp = eta != null && eta < 60000;
      body = `<div class="me-status ${nextUp ? 'next' : ''}">
        <span class="kicker">#${i + 1} in line</span>
        <span class="big">${nextUp ? "You're next. Get ready!" : `Up in ${esc(PXEta.label(eta))}`}</span>
        <span>Waiting ${mins(now() - meP.wait_since)}${mate ? ` · playing with ${esc(mate.name)}` : ''}</span></div>`;
    } else {
      body = `<div class="me-status"><span class="big">You're resting</span><span>Tell the organizer when you want back in line.</span></div>`;
    }
    const canNotify = 'Notification' in window && Notification.permission === 'default';
    return `<section class="me-card"><div class="me-h"><span class="avatar">${esc(meP.name.slice(0, 2).toUpperCase())}</span><b>${esc(meP.name)}</b>
      <button class="btn ghost sm" data-act="change">Not you?</button></div>${body}
      ${canNotify ? '<button class="btn block" data-act="notify">Alert me when I\'m called</button>' : ''}</section>`;
  }

  function pickCard(D) {
    const qs = search.trim().toLowerCase();
    const list = D.players.slice().sort((a, b) => a.name.localeCompare(b.name)).filter((p) => !qs || p.name.toLowerCase().includes(qs));
    return `<section class="me-card"><h2>Find your name</h2><p class="muted">See your spot in line and when you're up. We'll buzz your phone when you're called.</p>
      <input class="input" id="find" type="search" placeholder="Type your name" value="${esc(search)}" autocomplete="off">
      <div class="name-grid">${list.slice(0, 30).map((p) => `<button class="btn sm" data-act="me" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('') || '<p class="muted">No match. Are you checked in?</p>'}</div>
    </section>`;
  }

  function tvQr() {
    if (typeof window.qrcode !== 'function') return '';
    const url = location.origin + location.pathname + '?c=' + encodeURIComponent(code);
    const q = window.qrcode(0, 'M'); q.addData(url); q.make();
    return `<section class="tv-qr"><div class="qr-box">${q.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>
      <p><b>Scan to track your spot</b><br>See your place in line and get buzzed when it's your turn.</p></section>`;
  }

  // ------------------------------------------------------------------
  // "You're up!" alert
  // ------------------------------------------------------------------
  function checkCalled(meP, D) {
    const status = meP ? meP.status : null;
    if (lastStatus === 'queue' && status === 'playing') {
      const c = D.courtOf(meP.id);
      alertMe(`You're up on ${c ? c.name : 'court'}!`);
    }
    lastStatus = status;
  }

  function alertMe(msg) {
    try { navigator.vibrate && navigator.vibrate([300, 120, 300, 120, 500]); } catch (e) { /* ignore */ }
    try {
      if (audio) {
        [0, 0.25, 0.5].forEach((t) => {
          const o = audio.createOscillator(), g = audio.createGain();
          o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
          g.gain.setValueAtTime(0.25, audio.currentTime + t);
          g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + t + 0.2);
          o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.22);
        });
      }
    } catch (e) { /* ignore */ }
    if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
      navigator.serviceWorker.ready.then((r) => r.showNotification(msg, { body: data.name, icon: 'icon.svg', vibrate: [300, 120, 300], tag: 'pxm-called' })).catch(() => {});
    }
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>`; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 8000);
    let n = 0; const orig = document.title;
    const iv = setInterval(() => { document.title = n++ % 2 ? orig : '🔔 ' + msg; if (n > 12) { clearInterval(iv); document.title = orig; } }, 800);
  }

  function unlockAudio() {
    try { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    unlockAudio();
    const act = el.dataset.act;
    if (act === 'me') { me = el.dataset.id; store.set(ME_KEY, me); lastStatus = null; search = ''; render(); window.scrollTo(0, 0); }
    if (act === 'change') { me = null; store.set(ME_KEY, null); lastStatus = null; render(); setTimeout(() => $('#find')?.focus(), 50); }
    if (act === 'notify') { try { await Notification.requestPermission(); } catch (err) { /* ignore */ } render(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'find') return;
    search = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const f = $('#find'); if (f) { f.focus(); f.setSelectionRange(pos, pos); }
  });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  if (!cfg.supabaseUrl || !code) {
    $('#board').innerHTML = `<div class="card empty"><h3>No board selected</h3><p>Scan the QR code from your organizer to open your club's Live Board.</p></div>`;
    setLive(false, 'No board');
    return;
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

  poll();
  setInterval(() => { if (document.visibilityState === 'visible' || !tv) poll(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  // Keep "updated" honest if polling stalls.
  setInterval(() => { if (lastOk && Date.now() - lastOk > POLL_MS * 4) setLive(false, 'Reconnecting…'); }, 5000);
})();
