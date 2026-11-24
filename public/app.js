/* Pickle X Matcher — open-play queue & smart court matchmaking
 * Vanilla JS, no build step. State lives in localStorage on this device.
 */
'use strict';
(() => {
  // ======================================================================
  // Constants & helpers
  // ======================================================================
  const KEY = 'pxm:v1';
  const TAB_KEY = 'pxm:tab';
  const LEVELS = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5];
  const MODES = {
    balanced: { name: 'Smart Balanced', desc: 'Longest wait plays first. Even teams and new partners every game.' },
    tiered:   { name: 'Skill Groups',   desc: 'Puts players of similar ratings together while keeping the line fair.' },
    order:    { name: 'First Come, First Serve', desc: 'Strict queue order. Teams are still auto-balanced.' },
    winners:  { name: 'Winners Stay',   desc: 'The winning team keeps the court until it reaches the win cap.' },
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lvl = (n) => Number(n).toFixed(1);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const initials = (n) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const buzz = () => { try { navigator.vibrate && navigator.vibrate(8); } catch (e) { /* ignore */ } };

  function ago(t) {
    if (!t) return '';
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  const ICON = {
    caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    court: '<svg class="big-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18M12 4v5M12 15v5"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
  };

  function qrSvg(text) {
    if (typeof window.qrcode !== 'function') return '';
    const q = window.qrcode(0, 'M');
    q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  // ======================================================================
  // State
  // ======================================================================
  function defaults() {
    return {
      v: 1,
      seq: 0,
      settings: { mode: 'balanced', teamSize: 2, gameTo: 11, winBy: 2, autoFill: true, streakCap: 2, theme: 'auto', wake: false },
      players: [],
      courts: [1, 2, 3, 4].map(newCourt),
      history: [],
      sessionStart: Date.now(),
    };
  }
  function newCourt(n) { return { id: uid(), name: 'Court ' + n, active: true, match: null, king: null }; }

  function normalize(d) {
    const base = defaults();
    return Object.assign(base, d, { settings: Object.assign(base.settings, (d && d.settings) || {}) });
  }

  function load(key = KEY) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* fall through */ }
    return key === KEY ? defaults() : null;
  }

  // ----- Cloud (Supabase) -----
  const Cloud = window.PXCloud || { enabled: false };
  const MODE_KEY = 'pxm:mode'; // 'local' = user chose to stay offline on this device
  let localOnly = false;
  try { localOnly = localStorage.getItem(MODE_KEY) === 'local'; } catch (e) { /* ignore */ }
  const cloudOn = () => Cloud.enabled && !localOnly && !!Cloud.club;
  // gate: null = show the app; otherwise one of 'loading' | 'auth' | 'clubs' | 'error'
  let gate = Cloud.enabled && !localOnly ? 'loading' : null;
  let gateData = {};
  let storeKey = KEY;

  let S = gate ? defaults() : load();
  let tab = 'live';
  try { tab = localStorage.getItem(TAB_KEY) || 'live'; } catch (e) { /* ignore */ }
  let undoSnap = null;
  let statsCache = null;
  let search = '';
  let sheetState = {};

  function save() {
    try { localStorage.setItem(storeKey, JSON.stringify(S)); }
    catch (e) { toast('Could not save — storage is full or blocked'); }
  }
  function commit() {
    statsCache = null; save(); render();
    if (cloudOn()) Cloud.schedule();
  }
  function snap() { undoSnap = JSON.stringify(S); }

  // ======================================================================
  // Selectors
  // ======================================================================
  const P = (id) => S.players.find((p) => p.id === id);
  const nm = (id) => { const p = P(id); return p ? p.name : 'Unknown'; };
  const court = (id) => S.courts.find((c) => c.id === id);
  const matchIds = (m) => [...m.a, ...m.b];
  const courtOf = (pid) => S.courts.find((c) => c.match && matchIds(c.match).includes(pid));
  const roster = () => S.players.filter((p) => !p.deleted);
  const queue = () => S.players.filter((p) => p.status === 'queue').sort((a, b) => a.qpos - b.qpos);
  const need = () => S.settings.teamSize * 2;

  function enqueue(p, front = false) {
    const q = queue().filter((x) => x.id !== p.id);
    p.status = 'queue';
    p.qpos = front ? (q.length ? q[0].qpos : 0) - 1 : (S.seq = (S.seq || 0) + 1);
    p.waitSince = Date.now();
  }

  // Stats are always derived from game history, so deleting or undoing a game stays consistent.
  function stats() {
    if (statsCache) return statsCache;
    const m = new Map();
    const blank = () => ({ games: 0, wins: 0, losses: 0, pf: 0, pa: 0, partners: {}, opps: {} });
    const g = (id) => { if (!m.has(id)) m.set(id, blank()); return m.get(id); };
    for (const h of S.history) {
      for (const side of ['a', 'b']) {
        const team = h[side], other = h[side === 'a' ? 'b' : 'a'];
        const won = h.w === side;
        const mine = side === 'a' ? h.sa : h.sb, theirs = side === 'a' ? h.sb : h.sa;
        for (const id of team) {
          const s = g(id);
          s.games++; won ? s.wins++ : s.losses++;
          if (mine != null && theirs != null) { s.pf += mine; s.pa += theirs; }
          for (const t of team) if (t !== id) s.partners[t] = (s.partners[t] || 0) + 1;
          for (const o of other) s.opps[o] = (s.opps[o] || 0) + 1;
        }
      }
    }
    const empty = blank();
    statsCache = { get: (id) => m.get(id) || empty, map: m };
    return statsCache;
  }

  // ======================================================================
  // Matchmaking engine
  // ======================================================================
  function combos(arr, k) {
    const out = [];
    const rec = (start, cur) => {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
    };
    rec(0, []);
    return out;
  }

  // All ways to split a group into two teams (the first player is fixed on team A to avoid mirror duplicates).
  function splits(g) {
    if (g.length === 2) return [[[g[0]], [g[1]]]];
    const [x, a, b, c] = g;
    return [[[x, a], [b, c]], [[x, b], [a, c]], [[x, c], [a, b]]];
  }

  // ----- Fixed partners -----
  // Two players whose partnerId points at each other always play on the same team (doubles only).
  const partnerOf = (p) => {
    if (!p || !p.partnerId || S.settings.teamSize !== 2) return null;
    const m = P(p.partnerId);
    return m && !m.deleted && m.partnerId === p.id ? m : null;
  };
  const locked = (x, y) => { const p = P(x); return !!p && partnerOf(p)?.id === y; };
  // A split is valid if no locked pair ends up on opposite teams.
  const pairOk = (A, B) => A.every((a) => B.every((b) => !locked(a, b)));

  function setPartner(p, mate) {
    for (const x of [p, mate]) {
      const old = x && x.partnerId ? P(x.partnerId) : null;
      if (old && old.partnerId === x.id) old.partnerId = null;
    }
    p.partnerId = mate ? mate.id : null;
    if (mate) mate.partnerId = p.id;
  }

  // Group the queue into units: a locked pair (both waiting) moves as one unit, everyone else solo.
  function units(q, relaxed) {
    const inQ = new Set(q.map((p) => p.id)), seen = new Set(), out = [];
    for (const p of q) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const m = relaxed ? null : partnerOf(p);
      if (m && inQ.has(m.id) && !seen.has(m.id)) { seen.add(m.id); out.push([p.id, m.id]); }
      else out.push([p.id]);
    }
    return out;
  }

  // All subsets of units whose total player count is exactly k.
  function unitCombos(pool, k) {
    const out = [];
    const rec = (start, cur, size) => {
      if (size === k) { out.push(cur.slice()); return; }
      for (let i = start; i < pool.length; i++) {
        if (size + pool[i].length > k) continue;
        cur.push(pool[i]); rec(i + 1, cur, size + pool[i].length); cur.pop();
      }
    };
    rec(0, [], 0);
    return out;
  }

  // Lower is better: even teams, fresh partners, fresh opponents.
  function teamCost(A, B, st) {
    const sum = (t) => t.reduce((s, id) => s + (P(id)?.level || 3), 0);
    let cost = Math.abs(sum(A) - sum(B)) * 10;
    for (const t of [A, B]) if (t.length === 2 && !locked(t[0], t[1])) cost += (st.get(t[0]).partners[t[1]] || 0) * 8;
    for (const a of A) for (const b of B) cost += (st.get(a).opps[b] || 0) * 2.5;
    return cost;
  }

  function bestSplit(ids) {
    const st = stats();
    const all = splits(ids), ok = all.filter(([A, B]) => pairOk(A, B));
    let best = null;
    for (const [A, B] of ok.length ? ok : all) {
      const c = teamCost(A, B, st);
      if (!best || c < best.c) best = { a: A, b: B, c };
    }
    return { a: best.a, b: best.b };
  }

  /**
   * Pick the next match from the queue.
   * - The longest-waiting player (or locked pair) is always included, so nobody is skipped.
   * - The rest come from a look-ahead window to balance skill and variety, with a
   *   penalty for skipping over people who have waited longer.
   * - Locked partners move as a unit and always land on the same team.
   * @param {Set} exclude  player ids to ignore (used for "up next" projections)
   * @param {string[]|null} fixed  a team that stays on court (Winners Stay)
   */
  function pickMatch(exclude = new Set(), fixed = null, relaxed = false) {
    const ts = S.settings.teamSize, mode = S.settings.mode;
    const q = queue().filter((p) => !exclude.has(p.id));
    const n = fixed ? ts : ts * 2;
    if (q.length < n) return null;
    const U = units(q, relaxed);
    const res = mode === 'order' ? pickInOrder(U, n, fixed) : pickSmart(q, U, n, fixed, mode);
    // If locked pairs make a full game impossible, split pairs rather than leave a court empty.
    if (res || relaxed || !U.some((u) => u.length > 1)) return res;
    return pickMatch(exclude, fixed, true);
  }

  function pickInOrder(U, n, fixed) {
    const g = [];
    for (const u of U) { if (g.length + u.length <= n) g.push(...u); if (g.length === n) break; }
    if (g.length < n) return null;
    return fixed ? { a: fixed, b: g } : bestSplit(g);
  }

  function pickSmart(q, U, n, fixed, mode) {
    const st = stats();
    const idx = new Map(q.map((p, i) => [p.id, i]));
    const extra = mode === 'tiered' ? 7 : 4;
    // Normally the first unit anchors the game; if it can't form a valid game, try the next couple.
    for (let ai = 0; ai < Math.min(3, U.length); ai++) {
      const anchor = U[ai];
      if (anchor.length > n) continue;
      const pool = [];
      for (let j = ai + 1, cnt = 0; j < U.length && cnt < n - anchor.length + extra; j++) { pool.push(U[j]); cnt += U[j].length; }
      let best = null;
      for (const c of unitCombos(pool, n - anchor.length)) {
        const others = c.flat();
        const g = [...anchor, ...others];
        const waitPen = others.reduce((s, id) => s + idx.get(id), 0) * (mode === 'tiered' ? 0.9 : 1.8);
        let spread = 0;
        if (mode === 'tiered') {
          const lv = (fixed ? [...fixed, ...g] : g).map((id) => P(id).level);
          spread = (Math.max(...lv) - Math.min(...lv)) * 14;
        }
        const options = fixed ? [[fixed, g]] : splits(g).filter(([A, B]) => pairOk(A, B));
        for (const [A, B] of options) {
          const cost = teamCost(A, B, st) + waitPen + spread;
          if (!best || cost < best.cost) best = { a: A, b: B, cost };
        }
      }
      if (best) return { a: best.a, b: best.b };
    }
    return null;
  }

  // ----- Smart ETA -----
  function etaMap() {
    const q = queue(), now = Date.now();
    const avg = window.PXEta ? PXEta.avgGame(S.history.map((h) => h.end - h.start)) : 0;
    const courts = S.courts.map((c) => ({ active: c.active, start: c.match ? c.match.start : null }));
    const list = window.PXEta ? PXEta.forQueue(courts, q.length, need(), avg, now) : [];
    return new Map(q.map((p, i) => [p.id, list[i]]));
  }

  function startMatch(c, m) {
    c.match = { a: m.a.slice(), b: m.b.slice(), start: Date.now() };
    for (const id of matchIds(c.match)) { const p = P(id); if (p) p.status = 'playing'; }
  }

  function fillCourts() {
    let n = 0;
    for (const c of S.courts) {
      if (!c.active || c.match) continue;
      const m = pickMatch();
      if (!m) break;
      startMatch(c, m);
      n++;
    }
    return n;
  }

  function projectNext(count) {
    const out = [], ex = new Set();
    for (let i = 0; i < count; i++) {
      const m = pickMatch(ex);
      if (!m) break;
      out.push(m);
      matchIds(m).forEach((id) => ex.add(id));
    }
    return out;
  }

  const sameTeam = (x, y) => x.length === y.length && x.every((id) => y.includes(id));

  function finishMatch(c, sa, sb, winner) {
    const m = c.match;
    const w = winner || (sa > sb ? 'a' : 'b');
    S.history.push({ id: uid(), court: c.name, a: m.a, b: m.b, sa, sb, w, start: m.start, end: Date.now() });
    statsCache = null;
    const W = m[w], L = m[w === 'a' ? 'b' : 'a'];
    c.match = null;

    let stay = null;
    if (S.settings.mode === 'winners') {
      const streak = c.king && sameTeam(c.king.ids, W) ? c.king.streak + 1 : 1;
      if (streak < S.settings.streakCap) { stay = W.slice(); c.king = { ids: stay, streak }; }
      else c.king = null;
    } else c.king = null;

    // Losers go to the back first, then the winners (if they're not staying).
    for (const id of [...shuffle(L), ...(stay ? [] : shuffle(W))]) {
      const p = P(id); if (p && p.status === 'playing') enqueue(p);
    }
    if (stay) {
      const next = pickMatch(new Set(), stay);
      if (next) startMatch(c, next);
      else { stay.forEach((id) => { const p = P(id); if (p) enqueue(p); }); c.king = null; }
    }
    if (S.settings.autoFill) fillCourts();
    return W;
  }

  function cancelMatch(c) {
    const ids = matchIds(c.match);
    c.match = null; c.king = null;
    ids.slice().reverse().forEach((id) => { const p = P(id); if (p) enqueue(p, true); });
  }

  function addPlayer(name, level, checkIn) {
    name = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) return null;
    const dup = S.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (dup && !dup.deleted) { toast(`${name} is already on the roster`); return null; }
    let p = dup;
    if (p) { p.deleted = false; p.level = level; }
    else { p = { id: uid(), name, level: level || 3, status: 'out', qpos: 0, waitSince: 0 }; S.players.push(p); }
    if (checkIn) enqueue(p);
    return p;
  }

  function sanitize() {
    for (const c of S.courts) {
      if (!c.match) continue;
      const ids = matchIds(c.match);
      if (ids.some((id) => !P(id))) { ids.forEach((id) => { const p = P(id); if (p) enqueue(p, true); }); c.match = null; }
      else ids.forEach((id) => { P(id).status = 'playing'; });
    }
    for (const p of S.players) if (p.status === 'playing' && !courtOf(p.id)) enqueue(p);
  }

  // ======================================================================
  // UI primitives: toast, sheet
  // ======================================================================
  let toastTimer;
  function toast(msg, undoable = false) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${undoable ? '<button data-act="undo">UNDO</button>' : ''}`;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), undoable ? 5000 : 2400);
  }

  function openSheet(html, state = {}) {
    sheetState = state;
    const root = $('#sheet-root');
    root.innerHTML = `<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
    root.classList.add('open');
  }
  function closeSheet() {
    const root = $('#sheet-root');
    root.classList.remove('open');
    root.innerHTML = '';
    sheetState = {};
  }

  const levelPicker = (v) =>
    `<div class="levels" data-val="${v}">${LEVELS.map((l) => `<button type="button" class="lvl ${l === Number(v) ? 'on' : ''}" data-act="lvl" data-v="${l}">${lvl(l)}</button>`).join('')}</div>`;

  // ======================================================================
  // Views
  // ======================================================================
  function render() {
    if (S.settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = S.settings.theme;
    document.body.classList.toggle('gated', !!gate);
    $('#undo').hidden = !undoSnap || !!gate;
    renderSync();
    const v = $('#view');
    if (gate) { v.innerHTML = viewGate(); return; }
    $$('.tabbar [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    v.innerHTML = tab === 'players' ? viewPlayers() : tab === 'stats' ? viewStats() : tab === 'settings' ? viewSettings() : viewLive();
  }

  const SYNC_LABEL = { synced: 'Synced', syncing: 'Syncing…', pending: 'Saving…', offline: 'Offline · will sync', error: 'Sync problem · retrying', idle: '' };
  function renderSync() {
    const el = $('#sync');
    if (!el) return;
    const on = cloudOn() && !gate;
    el.hidden = !on;
    if (!on) return;
    const s = Cloud.status || 'idle';
    el.className = 'sync ' + s;
    el.title = SYNC_LABEL[s] || '';
    el.setAttribute('aria-label', SYNC_LABEL[s] || 'Sync status');
    const lbl = $('#sync-label');
    if (lbl) lbl.textContent = SYNC_LABEL[s] || '';
  }

  // ----- Gate screens: loading, sign in, choose club -----
  const LOGO = `<svg class="gate-logo" viewBox="0 0 512 512" aria-hidden="true"><circle cx="256" cy="256" r="240" fill="var(--accent)"/><path d="M180 180l152 152M332 180L180 332" stroke="var(--accent-ink)" stroke-width="56" stroke-linecap="round"/></svg>`;

  function viewGate() {
    if (gate === 'loading') {
      return `<div class="gate">${LOGO}<p class="muted">${esc(gateData.msg || 'Loading your club…')}</p></div>`;
    }
    if (gate === 'error') {
      return `<div class="gate">${LOGO}<h1>Can't reach the server</h1><p class="muted">${esc(gateData.msg || 'Check your connection and try again.')}</p>
        <div class="stack"><button class="btn primary block lg" data-act="gate-retry">Try again</button>
        <button class="btn ghost block" data-act="go-local">Use offline on this device</button></div></div>`;
    }
    if (gate === 'welcome') {
      return `<div class="gate">${LOGO}<h1>Pickle <span class="x">X</span> Matcher</h1>
        <p class="muted">Run open play in seconds. Live courts on every organizer's phone, and players track their spot from theirs.</p>
        <div class="stack">
          <button class="btn primary block lg" data-act="start">Get started · no account needed</button>
          <p class="gate-msg" id="w-msg">${esc(gateData.msg || '')}</p>
          <button class="btn block" data-act="show-email">I have an email login</button>
          <button class="btn ghost block" data-act="go-local">Use offline on this device only</button>
        </div></div>`;
    }
    if (gate === 'auth') {
      return `<div class="gate">${LOGO}<h1>Pickle <span class="x">X</span> Matcher</h1>
        <p class="muted">Optional: an email login keeps your clubs safe if you switch phones. You can always get back in with a club code too.</p>
        <div class="stack">
          <input class="input" id="a-email" type="email" placeholder="Email" autocomplete="email" inputmode="email" value="${esc(gateData.email || '')}">
          <input class="input" id="a-pass" type="password" placeholder="Password (6+ characters)" autocomplete="current-password" minlength="6">
          <p class="gate-msg" id="a-msg">${esc(gateData.msg || '')}</p>
          <button class="btn primary block lg" data-act="auth" data-mode="in">Sign in</button>
          <button class="btn block" data-act="auth" data-mode="up">Create account</button>
          ${gateData.resend ? '<button class="btn ghost block" data-act="resend">Resend confirmation email</button>' : ''}
          <button class="btn ghost block" data-act="welcome">← Back · continue without an account</button>
        </div></div>`;
    }
    if (gate === 'clubs') {
      const clubs = gateData.clubs || [];
      return `<div class="gate">${LOGO}<h1>Choose your club</h1>
        <p class="muted">A club is your venue or open-play group. Co-organizers join with its code.</p>
        ${clubs.length ? `<div class="list" style="width:100%">${clubs.map((c) => `
          <button class="li" data-act="open-club" data-id="${c.id}"><span class="avatar">${esc(initials(c.name))}</span>
          <span class="main"><span class="t">${esc(c.name)}</span><span class="s">Code ${esc(c.join_code)}</span></span></button>`).join('')}</div>` : ''}
        <div class="stack" style="width:100%">
          <span class="lbl">Create a new club</span>
          <div class="toolbar"><input class="input" id="g-club" placeholder="e.g. Sunset Park Open Play" maxlength="60" autocomplete="off"><button class="btn primary" data-act="create-club">Create</button></div>
          <span class="lbl">Join with a code</span>
          <div class="toolbar"><input class="input" id="g-code" placeholder="Club code" maxlength="8" autocomplete="off" autocapitalize="characters"><button class="btn" data-act="join-club">Join</button></div>
          <p class="gate-msg" id="g-msg">${esc(gateData.msg || '')}</p>
          <button class="btn ghost block" data-act="sign-out">${Cloud.isAnon ? 'Start over on this phone' : `Sign out ${Cloud.user && Cloud.user.email ? '(' + esc(Cloud.user.email) + ')' : ''}`}</button>
        </div></div>`;
    }
    return '';
  }

  function setGate(g, data = {}) { gate = g; gateData = data; closeSheet(); render(); window.scrollTo(0, 0); }

  async function showClubs(msg) {
    setGate('loading', { msg: 'Loading your clubs…' });
    try {
      const clubs = await Cloud.myClubs();
      setGate('clubs', { clubs, msg });
    } catch (e) {
      const last = Cloud.lastClub();
      if (last && load('pxm:club:' + last.id)) return openClub(last); // offline: use the cached club
      setGate('error', { msg: e.message });
    }
  }

  async function openClub(c, isNew = false) {
    storeKey = 'pxm:club:' + c.id;
    const cached = load(storeKey);
    undoSnap = null; statsCache = null;
    if (isNew) { S = defaults(); S.sessionStart = c.session_start || Date.now(); save(); }
    else S = cached || defaults();
    if (cached || isNew) { gate = null; render(); }
    else setGate('loading', { msg: `Opening ${c.name}…` });
    const ok = await Cloud.open(c, { isNew });
    if (!ok && !cached && !isNew) setGate('error', { msg: 'Could not load this club. Check your connection.' });
    else if (gate) { gate = null; render(); }
  }

  async function boot() {
    if (!gate) { sanitize(); render(); return; }
    Cloud.bind({
      getState: () => (gate ? null : S),
      onRemote: (st) => {
        S = normalize(st); statsCache = null; save();
        if (gate === 'loading') gate = null;
        render();
      },
      onStatus: () => renderSync(),
    });
    // Coming back from an email link that failed (expired / already used)?
    const hash = new URLSearchParams(location.hash.slice(1));
    let linkMsg = '';
    if (hash.get('error_description') || hash.get('error')) {
      linkMsg = hash.get('error_code') === 'otp_expired'
        ? 'That email link expired or was already used. If you already confirmed, just sign in. Otherwise enter your email and tap Resend.'
        : (hash.get('error_description') || 'That email link did not work.');
      history.replaceState(null, '', location.pathname + location.search);
    }
    render();
    let u = null;
    try { u = await Cloud.init(); } catch (e) { /* treat as signed out */ }
    if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
    if (!u) return linkMsg ? setGate('auth', { msg: linkMsg, resend: true }) : setGate('welcome');
    const last = Cloud.lastClub();
    if (last) return openClub(last);
    return showClubs();
  }

  const names = (ids) => ids.map((id) => esc(nm(id))).join(' & ');

  function viewLive() {
    const st = stats();
    const q = queue();
    const here = roster().filter((p) => p.status !== 'out');
    const playing = S.players.filter((p) => p.status === 'playing').length;
    const resting = roster().filter((p) => p.status === 'rest');
    const open = S.courts.filter((c) => c.active && !c.match).length;
    const fillable = Math.min(open, Math.floor(q.length / need()));
    const nexts = projectNext(2);
    const soon = new Set(nexts[0] ? matchIds(nexts[0]) : []);

    let h = `<section class="strip">
      <div><b>${here.length}</b><span>Here</span></div>
      <div><b>${q.length}</b><span>Waiting</span></div>
      <div><b>${playing}</b><span>Playing</span></div>
      <div><b>${S.history.length}</b><span>Games</span></div>
    </section>`;

    if (!here.length) {
      h += `<div class="card empty">${ICON.court}
        <h3>No one's checked in yet</h3>
        <p>Add players or check in your regulars to start the queue.</p>
        <div class="row"><button class="btn primary" data-act="add">Add player</button><button class="btn" data-act="tab" data-tab="players">Roster</button></div>
      </div>`;
    }

    if (fillable > 0) {
      h += `<button class="btn primary block lg" data-act="fill">Start ${plural(fillable, 'open court')}</button>`;
    }

    if (here.length) {
      h += `<button class="board-promo" data-act="board">
        <span class="bp-ico">${ICON.qr}</span>
        <span class="main"><b>PX Live Board</b><small>${cloudOn() ? 'Players scan to see their spot in line and their ETA' : 'Sign in to let players track their spot and ETA'}</small></span>
        <span class="bp-go">${cloudOn() ? 'Show QR' : 'Set up'}</span>
      </button>`;
    }

    h += `<h2 class="section-h">Courts <button class="pill" data-act="tab" data-tab="settings">${esc(MODES[S.settings.mode].name)} · ${S.settings.teamSize === 2 ? 'Doubles' : 'Singles'}</button></h2>
      <div class="courts">${S.courts.map(courtCard).join('')}</div>`;

    if (nexts.length) {
      h += `<h2 class="section-h">Up next</h2><div class="next">${nexts.map((m, i) => `
        <div class="next-card"><span class="next-tag">${i === 0 ? 'Next' : 'Then'}</span>
          <div class="next-teams"><span class="ta">${names(m.a)}</span><span class="vs">vs</span><span class="tb">${names(m.b)}</span></div>
        </div>`).join('')}</div>
        <p class="next-note">Projected. Final teams are picked when a court opens.</p>`;
    }

    h += `<h2 class="section-h">Queue <small>${q.length} waiting</small></h2>`;
    if (q.length) {
      const eta = etaMap();
      h += `<div class="list">${q.map((p, i) => {
        const s = st.get(p.id), mate = partnerOf(p);
        return `<button class="li ${soon.has(p.id) ? 'soon' : ''}" data-act="qmenu" data-pid="${p.id}">
          <span class="pos">${i + 1}</span>
          <span class="main"><span class="t">${esc(p.name)}${mate ? ` <span class="duo">${ICON.link}${esc(mate.name)}</span>` : ''}</span>
            <span class="s">${lvl(p.level)} · ${plural(s.games, 'game')}${s.games ? ` · ${s.wins}W` : ''}</span></span>
          <span class="eta"><b>${esc(window.PXEta ? PXEta.label(eta.get(p.id)) : '')}</b><small data-since="${p.waitSince}">${ago(p.waitSince)}</small></span>
        </button>`;
      }).join('')}</div>`;
    } else if (here.length) {
      h += `<div class="card empty"><p>Queue is empty. Everyone's on court or resting.</p></div>`;
    }

    if (resting.length) {
      h += `<h2 class="section-h">Resting <small>tap to rejoin</small></h2>
        <div class="rest-chips">${resting.map((p) => `<button class="btn sm" data-act="status" data-pid="${p.id}" data-to="queue">${esc(p.name)} ↩</button>`).join('')}</div>`;
    }
    return h;
  }

  function courtCard(c) {
    const kingBadge = S.settings.mode === 'winners' && c.king && c.match ? `<span class="streak">${plural(c.king.streak, 'win')}</span>` : '';
    const head = `<div class="court-h">
      <button class="court-name" data-act="court-menu" data-id="${c.id}">${esc(c.name)} ${ICON.caret}</button>
      ${c.match ? `<span class="timer">${kingBadge}<span data-since="${c.match.start}">${ago(c.match.start)}</span></span>` : ''}
    </div>`;
    if (!c.active) return `<article class="court off">${head}<p class="muted">Paused. Tap the name to reopen.</p></article>`;
    if (!c.match) {
      return `<article class="court open">${head}<div class="court-empty"><span class="open-lbl">Open court</span>
        <div class="row"><button class="btn primary" data-act="assign" data-id="${c.id}">Next up</button><button class="btn" data-act="manual" data-id="${c.id}">Pick players</button></div>
      </div></article>`;
    }
    const team = (side) => `<div class="team team-${side}">${c.match[side].map((id) =>
      `<button class="chip" data-act="sub" data-court="${c.id}" data-pid="${id}"><span class="nm">${esc(nm(id))}</span><span class="lv">${lvl(P(id)?.level || 0)}</span></button>`).join('')}</div>`;
    return `<article class="court live">${head}
      <div class="match">${team('a')}<span class="vs">VS</span>${team('b')}</div>
      <button class="btn primary block" data-act="score" data-id="${c.id}">Enter score</button>
    </article>`;
  }

  function viewPlayers() {
    return `<div class="toolbar">
        <input id="search" class="input" type="search" placeholder="Search roster" value="${esc(search)}" autocomplete="off">
        <button class="btn primary" data-act="add">+ Add</button>
      </div>
      <div class="row"><button class="btn ghost sm" data-act="bulk">Bulk add</button><button class="btn ghost sm" data-act="checkin-all">Check in all</button></div>
      <div id="plist">${playerList()}</div>`;
  }

  function playerList() {
    const st = stats();
    const qs = search.trim().toLowerCase();
    const list = roster().filter((p) => !qs || p.name.toLowerCase().includes(qs)).sort((a, b) => a.name.localeCompare(b.name));
    const inP = list.filter((p) => p.status !== 'out');
    const outP = list.filter((p) => p.status === 'out');
    const label = { queue: 'Waiting', playing: 'Playing', rest: 'Resting' };
    const row = (p) => {
      const s = st.get(p.id), here = p.status !== 'out';
      return `<div class="li" data-act="edit" data-pid="${p.id}" role="button" tabindex="0">
        <span class="avatar">${esc(initials(p.name))}</span>
        <span class="main"><span class="t">${esc(p.name)}</span><span class="s">${lvl(p.level)}${s.games ? ` · ${s.wins}-${s.losses}` : ''}${partnerOf(p) ? ` · <span class="duo">${ICON.link}${esc(partnerOf(p).name)}</span>` : ''}</span></span>
        ${here ? `<span class="status ${p.status}">${label[p.status]}</span>` : ''}
        ${p.status === 'playing' ? '' : `<button class="checkin ${here ? 'on' : ''}" data-act="toggle-in" data-pid="${p.id}">${here ? 'Here ✓' : 'Check in'}</button>`}
      </div>`;
    };
    if (!list.length) {
      return `<div class="card empty" style="margin-top:12px"><h3>${qs ? 'No matches' : 'Your roster is empty'}</h3><p>${qs ? 'Try another name.' : 'Players you add are saved for every session.'}</p>${qs ? '' : '<button class="btn primary" data-act="add">Add first player</button>'}</div>`;
    }
    let h = '';
    if (inP.length) h += `<h2 class="section-h">Checked in <small>${inP.length}</small></h2><div class="list">${inP.map(row).join('')}</div>`;
    if (outP.length) h += `<h2 class="section-h">Not here <small>${outP.length}</small></h2><div class="list">${outP.map(row).join('')}</div>`;
    return h;
  }

  function viewStats() {
    const st = stats();
    const rows = S.players.filter((p) => st.map.has(p.id)).map((p) => ({ p, s: st.get(p.id) }))
      .sort((x, y) => y.s.wins - x.s.wins || (y.s.wins / y.s.games) - (x.s.wins / x.s.games) || (y.s.pf - y.s.pa) - (x.s.pf - x.s.pa));
    const durs = S.history.map((h) => h.end - h.start);
    const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length / 60000) : 0;

    let h = `<section class="strip">
      <div><b>${ago(S.sessionStart) || '0m'}</b><span>Session</span></div>
      <div><b>${S.history.length}</b><span>Games</span></div>
      <div><b>${avg}m</b><span>Avg game</span></div>
      <div><b>${rows.length}</b><span>Played</span></div>
    </section>`;

    h += `<h2 class="section-h">Leaderboard</h2>`;
    if (!rows.length) h += `<div class="card empty"><p>Finish a game to see standings.</p></div>`;
    else {
      h += `<div class="list"><div class="lb-row head"><span>#</span><span>Player</span><span class="c">W-L</span><span class="c">Win%</span><span class="c">+/-</span></div>
        ${rows.map(({ p, s }, i) => {
          const d = s.pf - s.pa;
          return `<div class="lb-row"><span class="r ${i < 3 ? 'top' : ''}">${i + 1}</span>
            <span class="n">${esc(p.name)}<small>${lvl(p.level)} · ${plural(s.games, 'game')}</small></span>
            <span class="c">${s.wins}-${s.losses}</span>
            <span class="c">${Math.round((s.wins / s.games) * 100)}%</span>
            <span class="c ${d > 0 ? 'pos-diff' : d < 0 ? 'neg-diff' : ''}">${d > 0 ? '+' : ''}${d}</span></div>`;
        }).join('')}</div>`;
    }

    if (S.history.length) {
      h += `<h2 class="section-h">Game history</h2><div class="list">${S.history.slice().reverse().map((g) => {
        const side = (s) => `<div class="side ${g.w === s ? 'w' : ''}"><span class="${s === 'a' ? 'ta' : 'tb'}">${names(g[s])}</span><span class="sc">${g.sa == null ? (g.w === s ? 'W' : 'L') : (s === 'a' ? g.sa : g.sb)}</span></div>`;
        const t = new Date(g.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return `<div class="game"><div class="gm"><div class="meta">${esc(g.court)} · ${t} · ${Math.max(1, Math.round((g.end - g.start) / 60000))}m</div>${side('a')}${side('b')}</div>
          <button class="icon-btn" data-act="del-game" data-id="${g.id}" aria-label="Delete game">${ICON.trash}</button></div>`;
      }).join('')}</div>`;
    }
    return h;
  }

  function viewSettings() {
    const s = S.settings;
    const seg = (k, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(s[k]) === String(v) ? 'on' : ''}" data-act="set" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
    const sw = (k) => `<label class="switch"><input type="checkbox" data-set="${k}" ${s[k] ? 'checked' : ''}><span></span></label>`;
    return `
      <h2 class="section-h">Matchmaking</h2>
      <div class="modes">${Object.entries(MODES).map(([k, m]) => `
        <button class="mode ${s.mode === k ? 'on' : ''}" data-act="set" data-k="mode" data-v="${k}"><span class="radio"></span><span><b>${m.name}</b><small>${m.desc}</small></span></button>`).join('')}
      </div>
      ${s.mode === 'winners' ? `<div class="group" style="margin-top:8px"><div class="set-row"><span class="k">Win cap<small>Max straight wins before winners rotate off</small></span>
        <span class="num-step"><button data-act="streak" data-d="-1">−</button><b>${s.streakCap}</b><button data-act="streak" data-d="1">+</button></span></div></div>` : ''}

      <h2 class="section-h">Games</h2>
      <div class="group">
        <div class="set-row"><span class="k">Format</span>${seg('teamSize', [[2, 'Doubles'], [1, 'Singles']])}</div>
        <div class="set-row"><span class="k">Game to</span>${seg('gameTo', [[11, '11'], [15, '15'], [21, '21']])}</div>
        <div class="set-row"><span class="k">Win by</span>${seg('winBy', [[1, '1'], [2, '2']])}</div>
      </div>

      <h2 class="section-h">Courts</h2>
      <div class="group">
        <div class="set-row"><span class="k">Number of courts</span>
          <span class="num-step"><button data-act="courts" data-d="-1">−</button><b>${S.courts.length}</b><button data-act="courts" data-d="1">+</button></span></div>
        <div class="set-row"><span class="k">Auto-start next game<small>When a score is saved, refill open courts from the queue</small></span>${sw('autoFill')}</div>
      </div>

      <h2 class="section-h">Display</h2>
      <div class="group">
        <div class="set-row"><span class="k">Theme</span>${seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>
        <div class="set-row"><span class="k">Keep screen awake<small>Handy when the organizer's phone stays at the desk</small></span>${sw('wake')}</div>
      </div>

      ${cloudSettings()}

      <h2 class="section-h">Session & data</h2>
      <div class="group"><div class="data-btns">
        <button class="btn block" data-act="new-session">Start new session</button>
        <button class="btn block" data-act="export">Export backup (.json)</button>
        <button class="btn block" data-act="import">Import backup</button>
        <button class="btn block ghost danger" data-act="reset">Erase everything</button>
      </div></div>
      <p class="foot">Pickle X Matcher · v1.1<br>${cloudOn() ? 'Synced to the cloud. Works offline and catches up automatically.' : 'Data is saved on this device only.'}</p>`;
  }

  function cloudSettings() {
    if (!Cloud.enabled) return '';
    if (!cloudOn()) {
      return `<h2 class="section-h">Cloud sync</h2><div class="group"><div class="set-row"><span class="k">Off<small>Sign in to share courts and queue across phones</small></span>
        <button class="btn primary sm" data-act="go-cloud">Sign in</button></div></div>`;
    }
    const c = Cloud.club;
    return `<h2 class="section-h">Club</h2>
      <div class="group">
        <div class="set-row"><span class="k">${esc(c.name)}<small>${Cloud.isAnon ? 'No account · signed in on this phone' : esc(Cloud.user && Cloud.user.email || '')}</small></span><button class="btn sm" data-act="rename-club">Rename</button></div>
        <div class="set-row"><span class="k">Club code<small>${Cloud.isAnon ? 'Save it! It\'s how you get back in on any phone. Co-organizers join with it too.' : 'Share with co-organizers so they can run courts too'}</small></span>
          <button class="btn sm code" data-act="copy-code">${esc(c.join_code)}</button></div>
        <div class="set-row"><span class="k">Sync<small id="sync-label">${esc(SYNC_LABEL[Cloud.status] || '')}</small></span><button class="btn sm" data-act="sync-now">Sync now</button></div>
        <div class="data-btns"><button class="btn block" data-act="switch-club">Switch club</button><button class="btn ghost block" data-act="sign-out">Sign out</button></div>
      </div>`;
  }

  // ======================================================================
  // Sheets
  // ======================================================================
  function scoreSheet(cid) {
    const c = court(cid), m = c.match, s = S.settings;
    openSheet(`<h3>${esc(c.name)} · Final score</h3><p class="sub">Game to ${s.gameTo}, win by ${s.winBy}</p>
      <div class="score-grid">${['a', 'b'].map((t) => `
        <div class="score-team team-${t}">
          <div class="names">${names(m[t])}</div>
          <div class="stepper"><button data-act="sc" data-t="${t}" data-d="-1" aria-label="Minus">−</button>
            <input id="sc-${t}" type="number" inputmode="numeric" min="0" max="99" value="0" aria-label="Team ${t === 'a' ? 1 : 2} score">
            <button data-act="sc" data-t="${t}" data-d="1" aria-label="Plus">+</button></div>
          <button class="btn sm quick block" data-act="quick-win" data-t="${t}">Won ${s.gameTo}</button>
        </div>`).join('')}
      </div>
      <p class="hint" id="sc-hint">&nbsp;</p>
      <button class="btn primary block lg" data-act="save-score" data-id="${cid}">Save result</button>
      <div class="or">No score? Just tap the winner</div>
      <div class="row2"><button class="btn team-a-btn" data-act="win" data-id="${cid}" data-t="a">Team 1 won</button><button class="btn team-b-btn" data-act="win" data-id="${cid}" data-t="b">Team 2 won</button></div>
      <button class="btn ghost block" style="margin-top:8px" data-act="cancel-match" data-id="${cid}">Cancel game (players return to front of line)</button>`);
  }

  function readScores() {
    const a = parseInt($('#sc-a').value, 10), b = parseInt($('#sc-b').value, 10);
    return [Number.isFinite(a) ? Math.max(0, a) : 0, Number.isFinite(b) ? Math.max(0, b) : 0];
  }
  function updateHint() {
    const [a, b] = readScores(), s = S.settings, hi = Math.max(a, b);
    let msg = '';
    if (a === b) msg = a ? 'Scores are tied' : '';
    else if (hi < s.gameTo) msg = `Ended early? That's OK. Normal game is to ${s.gameTo}.`;
    else if (Math.abs(a - b) < s.winBy) msg = `Heads up: must win by ${s.winBy}.`;
    const el = $('#sc-hint'); if (el) el.innerHTML = msg ? esc(msg) : '&nbsp;';
  }

  function addSheet() {
    openSheet(`<h3>Add player</h3><p class="sub">Saved to your roster for future sessions.</p>
      <div class="stack">
        <input class="input" id="f-name" placeholder="Player name" autocomplete="off" autocapitalize="words" enterkeyhint="done" maxlength="40">
        <span class="lbl">Skill rating</span>${levelPicker(sheetState.lastLevel || 3)}
        <label class="check"><input type="checkbox" id="f-in" checked> Check in now</label>
        <div class="row2"><button class="btn" data-act="add-save" data-next="1">Add + another</button><button class="btn primary" data-act="add-save">Add</button></div>
      </div>`);
    setTimeout(() => $('#f-name')?.focus(), 60);
  }

  function editSheet(pid) {
    const p = P(pid); if (!p) return;
    const c = courtOf(pid);
    const st = stats().get(pid);
    const actions = {
      out: `<button class="btn primary block" data-act="status" data-pid="${pid}" data-to="queue">Check in</button>`,
      queue: `<div class="row2"><button class="btn" data-act="status" data-pid="${pid}" data-to="rest">Rest</button><button class="btn" data-act="status" data-pid="${pid}" data-to="out">Check out</button></div>`,
      rest: `<div class="row2"><button class="btn primary" data-act="status" data-pid="${pid}" data-to="queue">Back in line</button><button class="btn" data-act="status" data-pid="${pid}" data-to="out">Check out</button></div>`,
      playing: `<p class="sub">Playing on ${esc(c ? c.name : 'a court')}. Tap their name on the court card to sub them out.</p>`,
    }[p.status];
    openSheet(`<h3>${esc(p.name)}</h3><p class="sub">${st.games ? `${st.wins}-${st.losses} this session` : 'No games yet this session'}</p>
      <div class="stack">
        ${actions}
        <span class="lbl">Name</span><input class="input" id="e-name" value="${esc(p.name)}" maxlength="40" autocomplete="off">
        <span class="lbl">Skill rating</span>${levelPicker(p.level)}
        <span class="lbl">Fixed partner</span>
        <div class="partner-row">
          <span>${P(p.partnerId) && P(p.partnerId).partnerId === p.id && !P(p.partnerId).deleted
            ? `<span class="duo">${ICON.link}${esc(P(p.partnerId).name)}</span> <small class="muted">always on the same team${S.settings.teamSize === 1 ? ' (doubles only)' : ''}</small>`
            : '<span class="muted">None. Teams are mixed up each game.</span>'}</span>
          <button class="btn sm" data-act="partner-pick" data-pid="${pid}">${p.partnerId ? 'Change' : 'Lock partner'}</button>
        </div>
        <button class="btn primary block" data-act="edit-save" data-pid="${pid}">Save changes</button>
        ${p.status === 'playing' ? '' : `<button class="btn ghost danger block" data-act="remove" data-pid="${pid}">Remove from roster</button>`}
      </div>`);
  }

  // ======================================================================
  // Actions (event delegation via data-act)
  // ======================================================================
  const gateMsg = (id, msg) => { const el = $(id); if (el) el.textContent = msg; };
  async function busyBtn(el, fn) {
    if (el) { el.disabled = true; el.dataset.label = el.textContent; el.textContent = 'Please wait…'; }
    try { await fn(); }
    finally { if (el && el.isConnected) { el.disabled = false; el.textContent = el.dataset.label; } }
  }

  const A = {
    close: closeSheet,

    // ----- Cloud / account -----
    async auth(d, el) {
      const email = $('#a-email').value.trim(), pass = $('#a-pass').value;
      if (!/^\S+@\S+\.\S+$/.test(email)) return gateMsg('#a-msg', 'Enter a valid email.');
      if (pass.length < 6) return gateMsg('#a-msg', 'Password must be at least 6 characters.');
      await busyBtn(el, async () => {
        try {
          if (d.mode === 'up') {
            const r = await Cloud.signUp(email, pass);
            if (r.needsConfirm) return setGate('auth', { email, resend: true, msg: 'Check your email and tap the link to confirm, then sign in here.' });
          } else {
            await Cloud.signIn(email, pass);
          }
          await showClubs();
        } catch (e) {
          if (/not confirmed/i.test(e.message)) return setGate('auth', { email, resend: true, msg: 'Please confirm your email first. Check your inbox (and spam).' });
          gateMsg('#a-msg', e.message);
        }
      });
    },
    async resend(d, el) {
      const email = $('#a-email').value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return gateMsg('#a-msg', 'Enter your email above first.');
      await busyBtn(el, async () => {
        try { await Cloud.resendConfirmation(email); setGate('auth', { email, resend: true, msg: `New confirmation email sent to ${email}.` }); }
        catch (e) { gateMsg('#a-msg', e.message); }
      });
    },
    'go-local'() {
      try { localStorage.setItem(MODE_KEY, 'local'); } catch (e) { /* ignore */ }
      localOnly = true; storeKey = KEY;
      if (Cloud.close) Cloud.close();
      S = load(); undoSnap = null; statsCache = null; sanitize();
      setGate(null);
    },
    'go-cloud'() {
      try { localStorage.removeItem(MODE_KEY); } catch (e) { /* ignore */ }
      localOnly = false;
      gate = 'loading';
      boot();
    },
    'gate-retry'() { boot(); },
    'open-club'(d) {
      const c = (gateData.clubs || []).find((x) => x.id === d.id);
      if (c) openClub(c);
    },
    async 'create-club'(d, el) {
      const name = $('#g-club').value.trim();
      if (!name) return gateMsg('#g-msg', 'Give your club a name.');
      await busyBtn(el, async () => {
        try {
          const c = await Cloud.createClub(name);
          await openClub(c, true);
          openSheet(`<h3>${esc(c.name)} is ready</h3>
            <p class="sub">This is your <b>club code</b>. Co-organizers use it to join and run courts with you.${Cloud.isAnon ? ' Since you skipped an account, it\'s also how <b>you</b> get back in if you switch phones or clear your browser. Screenshot it or write it down.' : ''}</p>
            <div class="code-big">${esc(c.join_code)}</div>
            <div class="row2"><button class="btn" data-act="copy-code">Copy code</button><button class="btn primary" data-act="close">Got it</button></div>`);
        }
        catch (e) { gateMsg('#g-msg', e.message); }
      });
    },
    async 'join-club'(d, el) {
      const code = $('#g-code').value.trim();
      if (code.length < 4) return gateMsg('#g-msg', 'Enter the code from the club organizer.');
      await busyBtn(el, async () => {
        try { const c = await Cloud.joinClub(code); await openClub(c); toast(`Joined ${c.name}`); }
        catch (e) { gateMsg('#g-msg', e.message); }
      });
    },
    async start(d, el) {
      await busyBtn(el, async () => {
        try { await Cloud.signInAnon(); await showClubs(); }
        catch (e) {
          gateMsg('#w-msg', /anonymous/i.test(e.message)
            ? 'Quick start is switched off on the server. Use an email login for now.'
            : `Couldn't connect: ${e.message}`);
        }
      });
    },
    welcome() { setGate('welcome'); },
    'show-email'() { setGate('auth'); },
    async 'sign-out'() {
      if (Cloud.isAnon && !confirm('You don\'t have an account, so this phone forgets your clubs. You can get back in with each club\'s code. Continue?')) return;
      if (cloudOn()) await Cloud.push();
      await Cloud.signOut();
      storeKey = KEY; S = defaults(); undoSnap = null;
      setGate('welcome');
    },
    async 'switch-club'() {
      if (cloudOn()) await Cloud.push();
      Cloud.close();
      try { localStorage.removeItem('pxm:lastClub'); } catch (e) { /* ignore */ }
      showClubs();
    },
    'rename-club'() {
      openSheet(`<h3>Rename club</h3><div class="stack">
        <input class="input" id="rc-name" value="${esc(Cloud.club.name)}" maxlength="60" autocomplete="off">
        <button class="btn primary block" data-act="rename-club-save">Save</button></div>`);
    },
    async 'rename-club-save'(d, el) {
      const v = $('#rc-name').value.trim();
      if (!v) return toast('Name can’t be empty');
      await busyBtn(el, async () => {
        try { await Cloud.renameClub(v); closeSheet(); render(); toast('Club renamed'); }
        catch (e) { toast(e.message); }
      });
    },
    async 'copy-code'() {
      const code = Cloud.club.join_code;
      try { await navigator.clipboard.writeText(code); toast(`Code ${code} copied`); }
      catch (e) { toast(`Join code: ${code}`); }
    },
    async 'sync-now'() { await Cloud.push(); const ok = await Cloud.refresh(); toast(ok ? 'Up to date' : SYNC_LABEL[Cloud.status] || 'Sync queued'); },
    undo() {
      if (!undoSnap) return;
      S = JSON.parse(undoSnap); undoSnap = null;
      closeSheet(); commit(); toast('Undone');
    },
    tab(d) {
      tab = d.tab;
      try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* ignore */ }
      render(); window.scrollTo(0, 0);
    },

    // ----- Courts -----
    fill() {
      snap();
      const n = fillCourts();
      commit(); buzz();
      toast(n ? `${plural(n, 'court')} started` : `Need ${need()} players waiting`, n > 0);
    },
    assign(d) {
      const c = court(d.id), m = pickMatch();
      if (!m) return toast(`Need ${need()} players waiting`);
      snap(); startMatch(c, m); commit(); buzz();
      toast(`${c.name} is live`, true);
    },
    manual(d) {
      const q = queue();
      if (q.length < need()) return toast(`Need ${need()} players waiting`);
      openSheet(`<h3>Pick players</h3><p class="sub">Choose ${need()}. Teams are auto-balanced.</p>
        <div class="list">${q.map((p) => `<button class="li" data-act="pick" data-pid="${p.id}"><span class="pos">✓</span>
          <span class="main"><span class="t">${esc(p.name)}</span><span class="s">${lvl(p.level)}</span></span></button>`).join('')}</div>
        <button class="btn primary block lg" style="margin-top:12px" id="pick-go" data-act="manual-start" data-id="${d.id}" disabled>Select ${need()} players</button>`,
        { picked: new Set() });
      $$('#sheet-root .li .pos').forEach((el) => { el.style.opacity = '.25'; });
    },
    pick(d, el) {
      const set = sheetState.picked;
      if (set.has(d.pid)) set.delete(d.pid);
      else if (set.size < need()) set.add(d.pid);
      else return toast(`Only ${need()} players per game`);
      el.classList.toggle('soon', set.has(d.pid));
      el.querySelector('.pos').style.opacity = set.has(d.pid) ? '1' : '.25';
      const go = $('#pick-go'), left = need() - set.size;
      go.disabled = left !== 0;
      go.textContent = left ? `Select ${left} more` : 'Start game';
    },
    'manual-start'(d) {
      const ids = Array.from(sheetState.picked || []);
      if (ids.length !== need()) return;
      snap(); startMatch(court(d.id), bestSplit(ids)); closeSheet(); commit(); buzz();
      toast(`${court(d.id).name} is live`, true);
    },
    score(d) { scoreSheet(d.id); },
    sc(d) {
      const inp = $('#sc-' + d.t);
      inp.value = Math.max(0, Math.min(99, (parseInt(inp.value, 10) || 0) + Number(d.d)));
      updateHint();
    },
    'quick-win'(d) {
      const g = S.settings.gameTo, other = $('#sc-' + (d.t === 'a' ? 'b' : 'a'));
      const o = parseInt(other.value, 10) || 0;
      $('#sc-' + d.t).value = o >= g - 1 ? o + S.settings.winBy : g;
      updateHint();
    },
    'save-score'(d) {
      const [a, b] = readScores();
      if (a === b) return toast('Scores can’t be tied');
      saveResult(d.id, a, b, null);
    },
    win(d) { saveResult(d.id, null, null, d.t); },
    'cancel-match'(d) {
      snap(); cancelMatch(court(d.id)); closeSheet(); commit();
      toast('Game cancelled', true);
    },
    sub(d) {
      const c = court(d.court), p = P(d.pid);
      const nextUp = queue()[0];
      openSheet(`<h3>${esc(p.name)}</h3><p class="sub">On ${esc(c.name)}. ${nextUp ? `${esc(nextUp.name)} (next in line) will sub in.` : 'No one is waiting to sub in.'}</p>
        <div class="stack">
          <button class="btn block" data-act="sub-do" data-court="${c.id}" data-pid="${p.id}" data-to="queue" ${nextUp ? '' : 'disabled'}>Sub out · back of the line</button>
          <button class="btn block" data-act="sub-do" data-court="${c.id}" data-pid="${p.id}" data-to="rest" ${nextUp ? '' : 'disabled'}>Sub out · resting</button>
          <button class="btn block" data-act="sub-do" data-court="${c.id}" data-pid="${p.id}" data-to="out" ${nextUp ? '' : 'disabled'}>Sub out · leaving</button>
          <button class="btn ghost block" data-act="edit" data-pid="${p.id}">Edit player</button>
        </div>`);
    },
    'sub-do'(d) {
      const c = court(d.court), p = P(d.pid), nextUp = queue()[0];
      if (!c?.match || !nextUp) return;
      snap();
      for (const side of ['a', 'b']) { const i = c.match[side].indexOf(p.id); if (i >= 0) c.match[side][i] = nextUp.id; }
      nextUp.status = 'playing';
      if (d.to === 'queue') enqueue(p); else p.status = d.to;
      if (c.king) c.king = null;
      closeSheet(); commit();
      toast(`${nextUp.name} subbed in for ${p.name}`, true);
    },
    'court-menu'(d) {
      const c = court(d.id);
      openSheet(`<h3>${esc(c.name)}</h3><p class="sub">${c.match ? 'Game in progress' : c.active ? 'Open' : 'Paused'}</p>
        <div class="stack">
          <span class="lbl">Court name</span>
          <input class="input" id="c-name" value="${esc(c.name)}" maxlength="24" autocomplete="off">
          <button class="btn primary block" data-act="court-rename" data-id="${c.id}">Save name</button>
          ${c.match ? `<button class="btn block" data-act="cancel-match" data-id="${c.id}">Cancel current game</button>` : ''}
          ${c.match ? '' : `<button class="btn block" data-act="court-toggle" data-id="${c.id}">${c.active ? 'Pause court' : 'Reopen court'}</button>`}
          ${c.match ? '' : `<button class="btn ghost danger block" data-act="court-remove" data-id="${c.id}">Remove court</button>`}
        </div>`);
    },
    'court-rename'(d) {
      const v = $('#c-name').value.trim();
      if (!v) return toast('Name can’t be empty');
      court(d.id).name = v.slice(0, 24); closeSheet(); commit();
    },
    'court-toggle'(d) { const c = court(d.id); c.active = !c.active; closeSheet(); commit(); },
    'court-remove'(d) {
      if (S.courts.length <= 1) return toast('Keep at least one court');
      snap(); S.courts = S.courts.filter((c) => c.id !== d.id); closeSheet(); commit();
      toast('Court removed', true);
    },

    // ----- Queue -----
    qmenu(d) {
      const p = P(d.pid), q = queue(), i = q.findIndex((x) => x.id === p.id);
      openSheet(`<h3>${esc(p.name)}</h3><p class="sub">#${i + 1} in line · waiting ${ago(p.waitSince)}</p>
        <div class="stack">
          <div class="row2"><button class="btn" data-act="qmove" data-pid="${p.id}" data-front="1" ${i === 0 ? 'disabled' : ''}>Move to front</button>
          <button class="btn" data-act="qmove" data-pid="${p.id}" ${i === q.length - 1 ? 'disabled' : ''}>Move to back</button></div>
          <div class="row2"><button class="btn" data-act="status" data-pid="${p.id}" data-to="rest">Rest</button>
          <button class="btn" data-act="status" data-pid="${p.id}" data-to="out">Check out</button></div>
          ${S.settings.teamSize === 2 ? `<button class="btn block" data-act="partner-pick" data-pid="${p.id}">${partnerOf(p) ? `Partner: ${esc(partnerOf(p).name)} · change` : 'Lock a fixed partner'}</button>` : ''}
          <button class="btn ghost block" data-act="edit" data-pid="${p.id}">Edit player</button>
        </div>`);
    },
    qmove(d) { snap(); enqueue(P(d.pid), !!d.front); closeSheet(); commit(); },

    // ----- Fixed partners -----
    'partner-pick'(d) {
      const p = P(d.pid);
      const others = roster().filter((x) => x.id !== p.id).sort((a, b) => a.name.localeCompare(b.name));
      openSheet(`<h3>Lock ${esc(p.name)}'s partner</h3>
        <p class="sub">They'll always be on the same team and wait in line together.${S.settings.teamSize === 1 ? ' Only used in doubles.' : ''}</p>
        ${p.partnerId ? `<button class="btn ghost danger block" data-act="partner-set" data-pid="${p.id}" data-mate="">Remove fixed partner</button>` : ''}
        ${others.length ? `<div class="list" style="margin-top:8px">${others.map((x) => {
          const taken = partnerOf(x) && x.partnerId !== p.id;
          return `<button class="li ${x.id === p.partnerId ? 'soon' : ''}" data-act="partner-set" data-pid="${p.id}" data-mate="${x.id}">
            <span class="avatar">${esc(initials(x.name))}</span>
            <span class="main"><span class="t">${esc(x.name)}</span><span class="s">${lvl(x.level)}${taken ? ` · now with ${esc(P(x.partnerId).name)}` : ''}</span></span></button>`;
        }).join('')}</div>` : '<p class="muted">Add more players to the roster first.</p>'}`);
    },
    'partner-set'(d) {
      const p = P(d.pid), mate = d.mate ? P(d.mate) : null;
      snap();
      setPartner(p, mate);
      // If both are on different courts, nothing moves now. They're paired starting with their next game.
      closeSheet(); commit();
      toast(mate ? `${p.name} & ${mate.name} are locked partners` : `${p.name} has no fixed partner`, true);
    },

    // ----- PX Live Board -----
    board() {
      if (!cloudOn()) {
        openSheet(`<h3>PX Live Board</h3>
          <p class="sub">Players scan a QR code, find their name, and see their spot in line with a live ETA ("You're up in ~6 min"). Their phone buzzes when they're called to a court. No app or login is needed for players.</p>
          <p class="sub">It needs cloud sync so players' phones can see the queue.</p>
          ${Cloud.enabled ? '<button class="btn primary block lg" data-act="go-cloud">Sign in to turn it on</button>' : ''}`);
        return;
      }
      const code = Cloud.club.board_code;
      if (!code) return toast('Live Board needs the latest database update (migration 002).');
      const url = `${location.origin}/board.html?c=${encodeURIComponent(code)}`;
      openSheet(`<h3>PX Live Board</h3>
        <p class="sub">Players scan this, tap their name, and get a live ETA. Their phone buzzes when it's their turn.</p>
        <div class="qr-box">${qrSvg(url)}</div>
        <p class="board-url">${esc(url.replace(/^https?:\/\//, ''))}</p>
        <div class="row2"><button class="btn" data-act="board-copy" data-url="${esc(url)}">Copy link</button>
          <button class="btn primary" data-act="board-share" data-url="${esc(url)}">Share</button></div>
        <a class="btn ghost block" style="margin-top:8px" href="${esc(url)}&tv=1" target="_blank" rel="noopener">Open TV display</a>`);
    },
    async 'board-copy'(d) {
      try { await navigator.clipboard.writeText(d.url); toast('Board link copied'); } catch (e) { toast(d.url); }
    },
    async 'board-share'(d) {
      if (navigator.share) { try { await navigator.share({ title: `${Cloud.club.name} · Live Board`, text: 'See your spot in line and when you\'re up', url: d.url }); } catch (e) { /* cancelled */ } }
      else A['board-copy'](d);
    },

    // ----- Players -----
    add() { addSheet(); },
    lvl(d, el) {
      const w = el.parentElement; w.dataset.val = d.v;
      $$('.lvl', w).forEach((b) => b.classList.toggle('on', b === el));
    },
    'add-save'(d) {
      const inp = $('#f-name'); if (!inp) return;
      const level = Number($('#sheet-root .levels').dataset.val);
      const p = addPlayer(inp.value, level, $('#f-in').checked);
      if (!p) { if (!inp.value.trim()) inp.focus(); return; }
      commit(); buzz();
      if (d.next) {
        sheetState.lastLevel = level;
        inp.value = ''; inp.focus();
        toast(`Added ${p.name}`);
      } else { closeSheet(); toast(`Added ${p.name}`); }
    },
    bulk() {
      openSheet(`<h3>Bulk add</h3><p class="sub">One name per line. Add a rating after a comma, like <b>Maria, 3.5</b></p>
        <div class="stack">
          <textarea class="input" id="b-names" placeholder="Alex&#10;Jordan, 4.0&#10;Sam, 3.0"></textarea>
          <label class="check"><input type="checkbox" id="b-in" checked> Check everyone in now</label>
          <button class="btn primary block lg" data-act="bulk-save">Add players</button>
        </div>`);
      setTimeout(() => $('#b-names')?.focus(), 60);
    },
    'bulk-save'() {
      const lines = $('#b-names').value.split(/\n|;/).map((l) => l.trim()).filter(Boolean);
      const ci = $('#b-in').checked;
      let n = 0;
      for (const line of lines) {
        const [name, r] = line.split(/,|\t/);
        let level = parseFloat(r);
        level = Number.isFinite(level) ? Math.min(5.5, Math.max(2, Math.round(level * 2) / 2)) : 3;
        if (addPlayer(name || '', level, ci)) n++;
      }
      closeSheet(); commit();
      toast(`Added ${plural(n, 'player')}`);
    },
    'checkin-all'() {
      const outs = roster().filter((p) => p.status === 'out');
      if (!outs.length) return toast('Everyone is already checked in');
      snap(); shuffle(outs).forEach((p) => enqueue(p)); commit();
      toast(`Checked in ${plural(outs.length, 'player')}`, true);
    },
    'toggle-in'(d) {
      const p = P(d.pid);
      if (p.status === 'playing') return toast(`${p.name} is on court`);
      if (p.status === 'out') { enqueue(p); toast(`${p.name} checked in · #${queue().length} in line`); }
      else { p.status = 'out'; toast(`${p.name} checked out`); }
      buzz(); commit();
    },
    edit(d) { editSheet(d.pid); },
    'edit-save'(d) {
      const p = P(d.pid), name = $('#e-name').value.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) return toast('Name can’t be empty');
      if (S.players.some((x) => x.id !== p.id && !x.deleted && x.name.toLowerCase() === name.toLowerCase())) return toast('Another player has that name');
      p.name = name; p.level = Number($('#sheet-root .levels').dataset.val);
      closeSheet(); commit(); toast('Saved');
    },
    status(d) {
      const p = P(d.pid);
      if (p.status === 'playing') return toast(`${p.name} is on court. Sub them out first.`);
      snap();
      if (d.to === 'queue') enqueue(p); else p.status = d.to;
      closeSheet(); commit();
      toast({ queue: `${p.name} is in line`, rest: `${p.name} is resting`, out: `${p.name} checked out` }[d.to], true);
    },
    remove(d) {
      const p = P(d.pid);
      if (p.status === 'playing') return;
      snap(); setPartner(p, null); p.deleted = true; p.status = 'out'; closeSheet(); commit();
      toast(`${p.name} removed`, true);
    },

    // ----- Stats -----
    'del-game'(d) {
      snap(); S.history = S.history.filter((h) => h.id !== d.id); commit();
      toast('Game deleted · stats updated', true);
    },

    // ----- Settings -----
    set(d) {
      const num = Number(d.v);
      const val = d.v !== '' && Number.isFinite(num) ? num : d.v;
      S.settings[d.k] = val;
      if (d.k === 'mode' || d.k === 'teamSize') S.courts.forEach((c) => { c.king = null; });
      commit();
    },
    streak(d) { S.settings.streakCap = Math.min(6, Math.max(1, S.settings.streakCap + Number(d.d))); commit(); },
    courts(d) {
      if (Number(d.d) > 0) {
        if (S.courts.length >= 30) return toast('That’s a lot of courts!');
        S.courts.push(newCourt(S.courts.length + 1));
      } else {
        const last = S.courts[S.courts.length - 1];
        if (S.courts.length <= 1) return toast('Keep at least one court');
        if (last.match) return toast(`${last.name} has a game in progress`);
        S.courts.pop();
      }
      commit();
    },
    'new-session'() {
      if (!confirm('Start a new session? Games and stats are cleared and everyone is checked out. Your roster stays.')) return;
      snap();
      S.history = [];
      S.courts.forEach((c) => { c.match = null; c.king = null; });
      S.players = S.players.filter((p) => !p.deleted);
      S.players.forEach((p) => { p.status = 'out'; p.qpos = 0; p.waitSince = 0; });
      S.sessionStart = Date.now();
      commit(); toast('New session started', true);
    },
    export() {
      const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pickle-x-matcher-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    import() { $('#import-file').click(); },
    reset() {
      if (!confirm('Erase all players, courts, games and settings on this device?')) return;
      snap();
      const theme = S.settings.theme;
      S = defaults(); S.settings.theme = theme;
      commit(); toast('Everything erased', true);
    },
  };

  function saveResult(cid, sa, sb, winner) {
    const c = court(cid);
    if (!c?.match) return closeSheet();
    snap();
    const W = finishMatch(c, sa, sb, winner);
    closeSheet(); commit(); buzz();
    const score = sa == null ? '' : ` ${Math.max(sa, sb)}-${Math.min(sa, sb)}`;
    toast(`${W.map(nm).join(' & ')} win${W.length === 1 ? 's' : ''}${score}`, true);
  }

  // ======================================================================
  // Wiring
  // ======================================================================
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = A[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el.dataset, el, e); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#sheet-root').classList.contains('open')) closeSheet();
    if (e.key === 'Enter') {
      if (e.target.id === 'f-name') { e.preventDefault(); A['add-save']({ next: '1' }); }
      else if (e.target.id === 'a-email') { e.preventDefault(); $('#a-pass')?.focus(); }
      else if (e.target.id === 'a-pass') { e.preventDefault(); $('[data-act="auth"][data-mode="in"]')?.click(); }
      else if (e.target.id === 'g-club') { e.preventDefault(); $('[data-act="create-club"]')?.click(); }
      else if (e.target.id === 'g-code') { e.preventDefault(); $('[data-act="join-club"]')?.click(); }
      else if (e.target.id === 'rc-name') { e.preventDefault(); $('[data-act="rename-club-save"]')?.click(); }
      else if (e.target.id === 'c-name') { e.preventDefault(); $('[data-act="court-rename"]')?.click(); }
      else if (e.target.classList?.contains('li') && e.target.dataset.act) { e.preventDefault(); e.target.click(); }
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') { search = e.target.value; $('#plist').innerHTML = playerList(); }
    if (e.target.id === 'sc-a' || e.target.id === 'sc-b') updateHint();
  });

  document.addEventListener('change', (e) => {
    const k = e.target.dataset?.set;
    if (k) { S.settings[k] = e.target.checked; if (k === 'wake') applyWake(); commit(); }
  });

  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.players) || !Array.isArray(d.courts) || !Array.isArray(d.history)) throw new Error('bad');
      snap();
      const base = defaults();
      S = Object.assign(base, d, { settings: Object.assign(base.settings, d.settings || {}) });
      sanitize(); commit(); toast('Backup imported', true);
    } catch (err) { toast('That file isn’t a Pickle X Matcher backup'); }
  });

  // Keep timers fresh without re-rendering the whole page.
  setInterval(() => $$('[data-since]').forEach((el) => { el.textContent = ago(Number(el.dataset.since)); }), 15000);
  // Refresh ETAs on the Courts tab every 30s (skipped while a sheet is open or the user is typing).
  setInterval(() => {
    if (gate || tab !== 'live' || $('#sheet-root').classList.contains('open') || document.activeElement?.matches('input,textarea')) return;
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }, 30000);

  // Sync if the app is open in another tab on the same device.
  window.addEventListener('storage', (e) => {
    if (e.key === storeKey && e.newValue && !gate && !cloudOn()) { S = load(storeKey) || S; statsCache = null; render(); }
  });

  // Screen wake lock
  let wakeLock = null;
  async function applyWake() {
    try {
      if (S.settings.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* not supported or denied */ }
  }
  document.addEventListener('visibilitychange', applyWake);

  // Offline support (only works when served over http/https, not file://)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  boot();
  applyWake();
})();
