/* Pickle X Matcher — Interactive Landing Page Controller
 * Runs the real Smart ETA engine (window.PXEta) and matchmaking fairness preview.
 */
'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MIN = 60000;

  // ======================================================================
  // Theme (synced with organizer app's theme key)
  // ======================================================================
  const THEME_KEY = 'pxm:landing-theme';
  function getTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (e) { /* ignore */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* ignore */ }
    const btn = $('#theme-toggle');
    if (btn) btn.textContent = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  applyTheme(getTheme());
  $('#theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  // ======================================================================
  // Mobile Menu Toggle
  // ======================================================================
  const menuBtn = $('#mobile-menu-btn');
  const drawer = $('#mobile-drawer');
  if (menuBtn && drawer) {
    menuBtn.addEventListener('click', () => {
      const open = drawer.hidden;
      drawer.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    $$('a', drawer).forEach((link) => {
      link.addEventListener('click', () => {
        drawer.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ======================================================================
  // Interactive Courtside Matchmaking & Smart ETA Simulator
  // ======================================================================
  const MODE_INFO = {
    balanced: {
      name: 'Smart Balanced',
      rule: 'Longest-waiting player (#1) is guaranteed the next court. Look-ahead window minimizes team rating gap and repeat partners.',
    },
    tiered: {
      name: 'Skill Groups',
      rule: 'Groups players within similar rating brackets around the longest-waiting player while preventing anyone from being skipped.',
    },
    order: {
      name: 'First Come, First Serve',
      rule: 'Strict queue order (#1 through #4 take the next open court), with teams automatically balanced by rating.',
    },
    winners: {
      name: 'Winners Stay',
      rule: 'Winning team holds the court up to a 2-game streak cap while the top 2 waiting challengers rotate on.',
    },
  };

  let sim = null;

  function createSimState() {
    const now = Date.now();
    return {
      mode: 'balanced',
      lockPartners: true,
      seq: 14,
      gamesLogged: 4,
      durations: [11 * MIN, 13 * MIN, 12 * MIN, 12 * MIN],
      players: [
        { id: 'p1', name: 'Elena Rostova', level: 4.0, status: 'playing', qpos: 1, waitSince: 0 },
        { id: 'p2', name: 'Devon Brooks', level: 3.5, status: 'playing', qpos: 2, waitSince: 0 },
        { id: 'p3', name: 'Marcus Chen', level: 4.0, status: 'playing', qpos: 3, waitSince: 0 },
        { id: 'p4', name: 'Tessa Morales', level: 3.5, status: 'playing', qpos: 4, waitSince: 0 },
        { id: 'p5', name: 'Liam O\'Connor', level: 4.5, status: 'playing', qpos: 5, waitSince: 0 },
        { id: 'p6', name: 'Nadia Patel', level: 3.5, status: 'playing', qpos: 6, waitSince: 0 },
        { id: 'p7', name: 'Samir Haddad', level: 4.0, status: 'playing', qpos: 7, waitSince: 0 },
        { id: 'p8', name: 'Chloe Park', level: 4.0, status: 'playing', qpos: 8, waitSince: 0 },
        { id: 'p9', name: 'Priya Nair', level: 3.5, status: 'queue', qpos: 9, waitSince: now - 11 * MIN },
        { id: 'p10', name: 'Maya Lin', level: 4.0, status: 'queue', qpos: 10, waitSince: now - 9 * MIN, fixedPair: 'p11' },
        { id: 'p11', name: 'Eli Vance', level: 3.5, status: 'queue', qpos: 11, waitSince: now - 9 * MIN, fixedPair: 'p10' },
        { id: 'p12', name: 'Jordan Cole', level: 3.0, status: 'queue', qpos: 12, waitSince: now - 7 * MIN },
        { id: 'p13', name: 'Hannah Kim', level: 4.0, status: 'queue', qpos: 13, waitSince: now - 5 * MIN },
        { id: 'p14', name: 'Carlos Vega', level: 3.5, status: 'queue', qpos: 14, waitSince: now - 3 * MIN },
      ],
      courts: [
        { id: 'c1', name: 'Court 1', active: true, streak: 0, winnerSide: null, match: { a: ['p1', 'p2'], b: ['p3', 'p4'], start: now - 8 * MIN } },
        { id: 'c2', name: 'Court 2', active: true, streak: 0, winnerSide: null, match: { a: ['p5', 'p6'], b: ['p7', 'p8'], start: now - 4 * MIN } },
      ],
      partnersCount: {},
      oppsCount: {},
      lastEvent: 'Click either winner button on Court 1 or Court 2 to rotate players live.',
    };
  }

  const byId = (id) => sim.players.find((p) => p.id === id);
  const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const getQueue = () => sim.players.filter((p) => p.status === 'queue').sort((a, b) => a.qpos - b.qpos);

  function partnerOf(p) {
    if (!sim.lockPartners || !p || !p.fixedPair) return null;
    return byId(p.fixedPair) || null;
  }

  function isLockedPair(x, y) {
    const p = byId(x);
    return !!(p && partnerOf(p)?.id === y);
  }

  function validSplit(A, B) {
    return A.every((a) => B.every((b) => !isLockedPair(a, b)));
  }

  function splitCost(A, B) {
    const sum = (t) => t.reduce((s, id) => s + (byId(id)?.level || 3.5), 0);
    let cost = Math.abs(sum(A) - sum(B)) * 10;
    for (const t of [A, B]) {
      if (t.length === 2 && !isLockedPair(t[0], t[1])) {
        cost += (sim.partnersCount[pairKey(t[0], t[1])] || 0) * 8;
      }
    }
    for (const a of A) {
      for (const b of B) {
        cost += (sim.oppsCount[pairKey(a, b)] || 0) * 2.5;
      }
    }
    return cost;
  }

  function bestSplit(ids) {
    const [x, a, b, c] = ids;
    const all = [
      [[x, a], [b, c]],
      [[x, b], [a, c]],
      [[x, c], [a, b]],
    ];
    const ok = all.filter(([A, B]) => validSplit(A, B));
    let best = null;
    for (const [A, B] of (ok.length ? ok : all)) {
      const cVal = splitCost(A, B);
      if (!best || cVal < best.cost) best = { a: A, b: B, cost: cVal };
    }
    return best;
  }

  function queueUnits(q) {
    const inQ = new Set(q.map((p) => p.id));
    const seen = new Set();
    const out = [];
    for (const p of q) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const mate = partnerOf(p);
      if (mate && inQ.has(mate.id) && !seen.has(mate.id)) {
        seen.add(mate.id);
        out.push([p.id, mate.id]);
      } else {
        out.push([p.id]);
      }
    }
    return out;
  }

  function unitCombos(pool, targetSize) {
    const out = [];
    const walk = (start, cur, total) => {
      if (total === targetSize) { out.push(cur.slice()); return; }
      for (let i = start; i < pool.length; i++) {
        if (total + pool[i].length > targetSize) continue;
        cur.push(pool[i]);
        walk(i + 1, cur, total + pool[i].length);
        cur.pop();
      }
    };
    walk(0, [], 0);
    return out;
  }

  function pickNextMatch(fixedTeam = null) {
    const q = getQueue();
    const needed = fixedTeam ? 2 : 4;
    if (q.length < needed) return null;

    const u = queueUnits(q);
    if (!u.length) return null;

    const first = u[0];
    const posIndex = new Map(q.map((p, idx) => [p.id, idx]));

    if (sim.mode === 'order') {
      const pickedUnits = [first];
      let count = first.length;
      for (let i = 1; i < u.length && count < needed; i++) {
        if (count + u[i].length <= needed) {
          pickedUnits.push(u[i]);
          count += u[i].length;
        }
      }
      const ids = pickedUnits.flat();
      if (ids.length < needed) return null;
      if (fixedTeam) return { a: fixedTeam, b: ids, gap: teamGap(fixedTeam, ids) };
      const sp = bestSplit(ids);
      return { a: sp.a, b: sp.b, gap: teamGap(sp.a, sp.b) };
    }

    const windowUnits = u.slice(1, 7);
    const subsets = unitCombos(windowUnits, needed - first.length);
    let best = null;

    for (const sub of subsets) {
      const ids = [...first, ...sub.flat()];
      const skipPenalty = ids.reduce((s, id) => s + (posIndex.get(id) || 0), 0) * 1.1;
      let spreadPenalty = 0;
      if (sim.mode === 'tiered') {
        const levels = ids.map((id) => byId(id)?.level || 3.5);
        spreadPenalty = (Math.max(...levels) - Math.min(...levels)) * 14;
      }

      if (fixedTeam) {
        const score = splitCost(fixedTeam, ids) + skipPenalty + spreadPenalty;
        if (!best || score < best.score) best = { a: fixedTeam, b: ids, score, gap: teamGap(fixedTeam, ids) };
      } else {
        const sp = bestSplit(ids);
        const score = sp.cost + skipPenalty + spreadPenalty;
        if (!best || score < best.score) best = { a: sp.a, b: sp.b, score, gap: teamGap(sp.a, sp.b) };
      }
    }

    return best;
  }

  function teamAvg(ids) {
    const avg = ids.reduce((s, id) => s + (byId(id)?.level || 3.5), 0) / ids.length;
    return avg.toFixed(2);
  }

  function teamGap(a, b) {
    const sumA = a.reduce((s, id) => s + (byId(id)?.level || 3.5), 0);
    const sumB = b.reduce((s, id) => s + (byId(id)?.level || 3.5), 0);
    return Math.abs(sumA - sumB) / 2;
  }

  function formatElapsed(startMs) {
    const sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatWait(sinceMs) {
    const m = Math.max(0, Math.floor((Date.now() - sinceMs) / MIN));
    return m < 1 ? 'Just joined' : `Waited ${m}m`;
  }

  function finishSimCourt(courtId, winnerSide) {
    const court = sim.courts.find((c) => c.id === courtId);
    if (!court || !court.match) return;

    const { a, b, start } = court.match;
    const winners = winnerSide === 'a' ? a : b;
    const losers = winnerSide === 'a' ? b : a;

    // Record partner & opponent history for variety scoring
    for (const t of [a, b]) {
      const k = pairKey(t[0], t[1]);
      sim.partnersCount[k] = (sim.partnersCount[k] || 0) + 1;
    }
    for (const x of a) {
      for (const y of b) {
        const k = pairKey(x, y);
        sim.oppsCount[k] = (sim.oppsCount[k] || 0) + 1;
      }
    }

    sim.gamesLogged += 1;
    const dur = Math.max(7 * MIN, Math.min(20 * MIN, Date.now() - start + 3 * MIN));
    sim.durations.push(dur);

    const now = Date.now();
    const stayOnCourt = sim.mode === 'winners' && court.streak < 1;

    if (stayOnCourt) {
      for (const id of losers) {
        const p = byId(id);
        if (p) { p.status = 'queue'; p.qpos = ++sim.seq; p.waitSince = now; }
      }
      const next = pickNextMatch(winners);
      if (next) {
        for (const id of next.b) {
          const p = byId(id);
          if (p) { p.status = 'playing'; p.waitSince = 0; }
        }
        court.streak = (court.streak || 0) + 1;
        court.match = { a: next.a, b: next.b, start: now };
        sim.lastEvent = `${court.name}: ${winners.map((id) => byId(id).name.split(' ')[0]).join(' & ')} stay on court (1-win streak) vs ${next.b.map((id) => byId(id).name.split(' ')[0]).join(' & ')}.`;
      }
    } else {
      for (const id of [...winners, ...losers]) {
        const p = byId(id);
        if (p) { p.status = 'queue'; p.qpos = ++sim.seq; p.waitSince = now; }
      }
      court.streak = 0;
      const next = pickNextMatch(null);
      if (next) {
        for (const id of [...next.a, ...next.b]) {
          const p = byId(id);
          if (p) { p.status = 'playing'; p.waitSince = 0; }
        }
        court.match = { a: next.a, b: next.b, start: now };
        sim.lastEvent = `${court.name} rotated: ${next.a.map((id) => byId(id).name.split(' ')[0]).join(' & ')} vs ${next.b.map((id) => byId(id).name.split(' ')[0]).join(' & ')} (gap ${next.gap.toFixed(2)}).`;
      }
    }

    renderSim(courtId);
  }

  function renderSim(flashCourtId = null) {
    const courtsEl = $('#sim-courts');
    const upnextEl = $('#sim-upnext');
    const queueEl = $('#sim-queue');
    const statusEl = $('#sim-status');
    if (!courtsEl || !upnextEl || !queueEl) return;

    // Mode active buttons
    $$('[data-sim-mode]').forEach((btn) => {
      const active = btn.dataset.simMode === sim.mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    const lockBtn = $('#sim-lock-btn');
    if (lockBtn) {
      lockBtn.setAttribute('aria-pressed', String(sim.lockPartners));
      lockBtn.textContent = sim.lockPartners ? 'Fixed partners: Maya & Eli locked' : 'Fixed partners: Off';
    }

    // Render active courts
    courtsEl.innerHTML = sim.courts.map((c) => {
      const gap = teamGap(c.match.a, c.match.b);
      const streakTxt = sim.mode === 'winners' && c.streak > 0 ? ` · ${c.streak}W streak` : '';
      const renderSide = (ids, sideKey, sideLabel) => `
        <div class="sim-team-col">
          <div class="sim-team-lbl">
            <span><span class="team-marker ${sideKey}" aria-hidden="true"></span>${sideLabel}</span>
            <span class="mono">avg ${teamAvg(ids)}</span>
          </div>
          ${ids.map((id) => {
            const p = byId(id);
            const mate = partnerOf(p);
            const lockedNote = mate && ids.includes(mate.id) ? ' · paired' : '';
            return `<div class="sim-player-row">
              <span class="sim-player-name">${esc(p.name)}${lockedNote}</span>
              <span class="sim-player-lvl mono">${p.level.toFixed(1)}</span>
            </div>`;
          }).join('')}
        </div>
      `;
      return `
        <article class="sim-court ${flashCourtId === c.id ? 'flash' : ''}" data-court-id="${c.id}">
          <div class="sim-court-head">
            <div class="sim-court-title">
              <h3>${esc(c.name)}</h3>
              <span class="sim-court-meta">Skill gap <span class="mono">${gap.toFixed(2)}</span>${streakTxt}</span>
            </div>
            <span class="sim-court-meta mono" data-sim-clock="${c.match.start}">${formatElapsed(c.match.start)}</span>
          </div>
          <div class="sim-match-grid">
            ${renderSide(c.match.a, 'a', 'Team A')}
            <div class="sim-vs">VS</div>
            ${renderSide(c.match.b, 'b', 'Team B')}
          </div>
          <div class="sim-court-foot">
            <span class="sim-court-meta">Record score to rotate next match</span>
            <div class="sim-actions">
              <button type="button" class="btn btn-sm" data-finish="${c.id}" data-winner="a">Team A wins 11–8</button>
              <button type="button" class="btn btn-sm" data-finish="${c.id}" data-winner="b">Team B wins 11–9</button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    // Render Up Next projection
    const q = getQueue();
    const next = pickNextMatch(null);
    if (next) {
      const aNames = next.a.map((id) => byId(id).name.split(' ')[0]).join(' & ');
      const bNames = next.b.map((id) => byId(id).name.split(' ')[0]).join(' & ');
      const firstName = q[0] ? q[0].name.split(' ')[0] : '';
      upnextEl.innerHTML = `
        <div class="sim-subhead">
          <h3>Up next on open court</h3>
          <span class="mono">Gap ${next.gap.toFixed(2)}</span>
        </div>
        <div class="upnext-line">${esc(aNames)} <span class="sim-court-meta">vs</span> ${esc(bNames)}</div>
        <div class="upnext-reason">Includes #1 longest-waiting (${esc(firstName)}) · ${esc(MODE_INFO[sim.mode].name)}</div>
      `;
    }

    // Compute real Smart ETAs via window.PXEta
    const now = Date.now();
    const etaApi = window.PXEta;
    const avgMs = etaApi ? etaApi.avgGame(sim.durations) : 12 * MIN;
    const etas = etaApi
      ? etaApi.forQueue(sim.courts.map((c) => ({ active: c.active, start: c.match.start })), q.length, 4, avgMs, now)
      : q.map(() => null);

    const nextIds = new Set(next ? [...next.a, ...next.b] : []);
    queueEl.innerHTML = q.map((p, idx) => {
      const mate = partnerOf(p);
      const pairNote = mate ? ` · paired with ${mate.name.split(' ')[0]}` : '';
      const etaText = etaApi ? etaApi.label(etas[idx]) : `~${(Math.floor(idx / 4) + 1) * 5} min`;
      const isGuaranteed = idx === 0;
      const inNext = nextIds.has(p.id);
      return `
        <li class="queue-item ${isGuaranteed ? 'guaranteed' : ''}">
          <span class="queue-pos mono">#${idx + 1}</span>
          <div class="queue-main">
            <strong>${esc(p.name)}</strong>
            <span>DUPR <span class="mono">${p.level.toFixed(1)}</span>${esc(pairNote)}${inNext ? ' · Next court' : ''}</span>
          </div>
          <div class="queue-eta">
            <strong class="mono">${esc(etaText || 'Next up')}</strong>
            <span>${formatWait(p.waitSince)}</span>
          </div>
        </li>
      `;
    }).join('');

    if (statusEl) {
      const avgMin = Math.round(avgMs / MIN);
      statusEl.textContent = `${sim.lastEvent} · ${sim.gamesLogged} games logged · Avg game ${avgMin}m`;
    }
  }

  // Initialize simulator
  sim = createSimState();
  renderSim();

  // Simulator click wiring
  document.addEventListener('click', (e) => {
    const modeBtn = e.target.closest('[data-sim-mode]');
    if (modeBtn) {
      sim.mode = modeBtn.dataset.simMode;
      sim.lastEvent = MODE_INFO[sim.mode].rule;
      renderSim();
      return;
    }

    const finBtn = e.target.closest('[data-finish]');
    if (finBtn) {
      finishSimCourt(finBtn.dataset.finish, finBtn.dataset.winner);
      return;
    }

    if (e.target.closest('#sim-lock-btn')) {
      sim.lockPartners = !sim.lockPartners;
      sim.lastEvent = sim.lockPartners
        ? 'Maya Lin & Eli Vance are locked together and will wait and play on the same team.'
        : 'Fixed partner lock disabled — Maya & Eli can be split for tighter team balance.';
      renderSim();
      return;
    }

    if (e.target.closest('#sim-reset-btn')) {
      sim = createSimState();
      renderSim();
      return;
    }
  });

  // Live ticking timers for simulator & hero court
  const heroStart = Date.now() - (8 * 60 + 14) * 1000;
  setInterval(() => {
    $$('[data-sim-clock]').forEach((el) => {
      el.textContent = formatElapsed(Number(el.dataset.simClock));
    });
    const heroClock = $('#hero-clock');
    if (heroClock) heroClock.textContent = formatElapsed(heroStart);
  }, 1000);

  // ======================================================================
  // PX Live Board Preview Switcher (Phone vs Venue TV with real QR)
  // ======================================================================
  const qrContainer = $('#preview-qr');
  if (qrContainer && typeof window.qrcode === 'function') {
    const qr = window.qrcode(0, 'M');
    qr.addData(`${location.origin}/app?demo=1`);
    qr.make();
    qrContainer.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
  }

  $$('[data-board-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.boardTab;
      $$('[data-board-tab]').forEach((b) => {
        const on = b.dataset.boardTab === target;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      const phonePanel = $('#board-panel-phone');
      const tvPanel = $('#board-panel-tv');
      if (phonePanel) phonePanel.hidden = target !== 'phone';
      if (tvPanel) tvPanel.hidden = target !== 'tv';
    });
  });

  // ======================================================================
  // Interactive Quick-Start Club Builder (Validated Form -> Launches app.html)
  // ======================================================================
  let selectedCourts = 4;
  let selectedFormat = 2;

  $$('[data-court-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedCourts = Number(btn.dataset.courtChoice) || 4;
      $$('[data-court-choice]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  $$('[data-format-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedFormat = Number(btn.dataset.formatChoice) || 2;
      $$('[data-format-choice]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  const startForm = $('#quick-start-form');
  const formMsg = $('#start-form-msg');
  if (startForm) {
    startForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const clubInput = $('#club-name-input');
      const modeSelect = $('#start-mode-select');
      const clubName = (clubInput?.value || '').trim();

      if (clubName.length > 0 && clubName.length < 2) {
        if (formMsg) {
          formMsg.classList.remove('ok');
          formMsg.textContent = 'Enter at least 2 characters for your club name, or leave it blank.';
        }
        clubInput?.focus();
        return;
      }

      if (clubName.length > 60) {
        if (formMsg) {
          formMsg.classList.remove('ok');
          formMsg.textContent = 'Club name must be 60 characters or fewer.';
        }
        clubInput?.focus();
        return;
      }

      const params = new URLSearchParams({
        setup: '1',
        courts: String(selectedCourts),
        mode: modeSelect?.value || 'balanced',
        teamSize: String(selectedFormat),
      });
      if (clubName) params.set('club', clubName);

      if (formMsg) {
        formMsg.classList.add('ok');
        formMsg.textContent = `Opening ${clubName || 'your open-play session'} (${selectedCourts} courts)…`;
      }

      setTimeout(() => {
        window.location.href = `app?${params.toString()}`;
      }, 220);
    });
  }
})();
