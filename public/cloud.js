/* Pickle X Matcher — Supabase sync layer.
 *
 * Model: the app keeps working on an in-memory state object (offline-first).
 * After every change we diff the state against the last version the server
 * confirmed and upsert/delete only the rows that changed. Every save bumps the
 * club row, which other devices hear over Realtime and then re-fetch.
 */
'use strict';
window.PXCloud = (() => {
  const cfg = window.PXM_CONFIG || {};
  const lib = window.supabase;
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && lib && lib.createClient);
  const sb = enabled
    ? lib.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pxm-auth' } })
    : null;
  const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  let user = null;
  let club = null;          // { id, name, join_code }
  let synced = null;        // snapshot of what the server has: { players:{id:json}, courts, games, club, sessionStart }
  let busy = false, again = false, remoteWanted = false;
  let pushTimer = null, retryTimer = null, refreshTimer = null;
  let channel = null, subscribedOnce = false;
  let status = 'idle';
  // If the database hasn't had migration 002 yet, sync everything except fixed partners instead of failing.
  let noPartnerCol = false;
  const hooks = { getState: () => null, onRemote: () => {}, onStatus: () => {} };

  function setStatus(s, msg) { status = s; hooks.onStatus(s, msg); }

  // ------------------------------------------------------------------
  // State <-> rows
  // ------------------------------------------------------------------
  function rowsFrom(S, clubId) {
    const players = {}, courts = {}, games = {};
    for (const p of S.players) {
      players[p.id] = {
        id: p.id, club_id: clubId, name: p.name, level: Number(p.level) || 3, status: p.status,
        qpos: Number(p.qpos) || 0, wait_since: Math.round(p.waitSince || 0), deleted: !!p.deleted,
      };
      if (!noPartnerCol) players[p.id].partner_id = p.partnerId || null;
    }
    S.courts.forEach((c, i) => {
      courts[c.id] = { id: c.id, club_id: clubId, name: c.name, position: i, active: !!c.active, match: c.match || null, king: c.king || null };
    });
    for (const h of S.history) {
      games[h.id] = {
        id: h.id, club_id: clubId, session_start: S.sessionStart, court: h.court, team_a: h.a, team_b: h.b,
        score_a: h.sa == null ? null : h.sa, score_b: h.sb == null ? null : h.sb, winner: h.w,
        started_at: Math.round(h.start), ended_at: Math.round(h.end),
      };
    }
    return { players, courts, games, club: { settings: S.settings, seq: S.seq || 0, session_start: S.sessionStart } };
  }

  function stateFrom(c, players, courts, games) {
    return {
      v: 1,
      seq: Number(c.seq) || 0,
      settings: c.settings || {},
      sessionStart: Number(c.session_start),
      players: players.map((r) => ({
        id: r.id, name: r.name, level: Number(r.level), status: r.status, qpos: Number(r.qpos),
        waitSince: Number(r.wait_since), deleted: !!r.deleted, partnerId: r.partner_id || null,
      })),
      courts: courts.slice().sort((a, b) => a.position - b.position)
        .map((r) => ({ id: r.id, name: r.name, active: r.active, match: r.match, king: r.king })),
      history: games.slice().sort((a, b) => a.ended_at - b.ended_at).map((r) => ({
        id: r.id, court: r.court, a: r.team_a, b: r.team_b, sa: r.score_a, sb: r.score_b, w: r.winner,
        start: Number(r.started_at), end: Number(r.ended_at),
      })),
    };
  }

  function snapshotOf(rows) {
    const m = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]));
    return { players: m(rows.players), courts: m(rows.courts), games: m(rows.games), club: JSON.stringify(rows.club), sessionStart: rows.club.session_start };
  }

  function emptySnapshot(sessionStart) { return { players: {}, courts: {}, games: {}, club: '', sessionStart }; }

  function isDirty() {
    if (!club || !synced) return false;
    const S = hooks.getState();
    if (!S) return false;
    const cur = snapshotOf(rowsFrom(S, club.id));
    if (cur.club !== synced.club) return true;
    for (const t of ['players', 'courts', 'games']) {
      const a = cur[t], b = synced[t];
      if (Object.keys(a).length !== Object.keys(b).length) return true;
      for (const id in a) if (a[id] !== b[id]) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Push (local -> server)
  // ------------------------------------------------------------------
  async function pushOnce() {
    const S = hooks.getState();
    if (!S || !club || !synced) return;
    const clubId = club.id;
    const rows = rowsFrom(S, clubId);
    const cur = snapshotOf(rows);
    const prev = synced;
    const sessionChanged = prev.sessionStart !== cur.sessionStart;
    let changed = false;

    for (const t of ['courts', 'players', 'games']) {
      const up = Object.keys(cur[t]).filter((id) => cur[t][id] !== prev[t][id]).map((id) => rows[t][id]);
      // Starting a new session clears local history, but past games stay in the database.
      const del = t === 'games' && sessionChanged ? [] : Object.keys(prev[t]).filter((id) => !(id in cur[t]));
      if (up.length) {
        setStatus('syncing');
        let { error } = await sb.from(t).upsert(up);
        if (error && t === 'players' && !noPartnerCol && /partner_id/.test(error.message || '')) {
          noPartnerCol = true;
          console.warn('Pickle X Matcher: run supabase/migrations/002 to sync fixed partners.');
          up.forEach((r) => delete r.partner_id);
          ({ error } = await sb.from(t).upsert(up));
        }
        if (error) throw error;
        changed = true;
      }
      if (del.length) {
        setStatus('syncing');
        const { error } = await sb.from(t).delete().eq('club_id', clubId).in('id', del);
        if (error) throw error;
        changed = true;
      }
    }
    if (changed || cur.club !== prev.club) {
      const { error } = await sb.from('clubs')
        .update({ ...rows.club, last_writer: clientId, updated_at: new Date().toISOString() })
        .eq('id', clubId);
      if (error) throw error;
    }
    if (club && club.id === clubId) {
      synced = cur;
      LS.set('pxm:synced:' + clubId, synced);
    }
  }

  async function push() {
    clearTimeout(pushTimer);
    if (!club || !synced) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      do { again = false; await pushOnce(); } while (again);
      setStatus('synced');
    } catch (e) {
      setStatus(navigator.onLine === false ? 'offline' : 'error', e && e.message);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(push, 8000);
    } finally {
      busy = false;
      if (remoteWanted && !isDirty()) { remoteWanted = false; refresh(); }
    }
  }

  function schedule() {
    if (!club || !synced) return;
    setStatus('pending');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 350);
  }

  // ------------------------------------------------------------------
  // Pull (server -> local)
  // ------------------------------------------------------------------
  async function fetchState(id) {
    const c = await sb.from('clubs').select('*').eq('id', id).single();
    if (c.error) throw c.error;
    const [p, co, g] = await Promise.all([
      sb.from('players').select('*').eq('club_id', id),
      sb.from('courts').select('*').eq('club_id', id),
      sb.from('games').select('*').eq('club_id', id).eq('session_start', c.data.session_start).order('ended_at'),
    ]);
    for (const r of [p, co, g]) if (r.error) throw r.error;
    if (club && club.id === id) {
      club = { id, name: c.data.name, join_code: c.data.join_code, board_code: c.data.board_code || null };
      LS.set('pxm:clubmeta:' + id, club);
    }
    return stateFrom(c.data, p.data, co.data, g.data);
  }

  /** Re-fetch the club. Returns true if fresh server state was applied. */
  async function refresh() {
    if (!club) return false;
    if (busy || isDirty()) { remoteWanted = true; if (!busy) push(); return false; }
    const id = club.id;
    try {
      setStatus('syncing');
      const st = await fetchState(id);
      if (!club || club.id !== id) return false;
      if (isDirty()) { remoteWanted = true; push(); return false; }
      synced = snapshotOf(rowsFrom(st, id));
      LS.set('pxm:synced:' + id, synced);
      hooks.onRemote(st);
      setStatus('synced');
      return true;
    } catch (e) {
      setStatus(navigator.onLine === false ? 'offline' : 'error', e && e.message);
      return false;
    }
  }

  function subscribe() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    subscribedOnce = false;
    const id = club.id;
    channel = sb.channel('club-' + id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'clubs', filter: 'id=eq.' + id }, (payload) => {
        if (payload.new && payload.new.last_writer === clientId) return;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 250);
      })
      .subscribe((st) => {
        if (st === 'SUBSCRIBED') {
          if (subscribedOnce) refresh(); // reconnected: catch up on anything missed
          subscribedOnce = true;
        }
      });
  }

  window.addEventListener('online', () => { if (club) { push(); refresh(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && club) refresh();
  });

  // Root path -> bare origin, so it matches a Supabase Redirect URL entry like https://pickle-x-matcher.vercel.app
  const redirectUrl = () => location.origin + (location.pathname === '/' ? '' : location.pathname.replace(/index.html$/, ''));

  const fail = (error) => { if (error) throw new Error(error.message || String(error)); };

  return {
    enabled,
    get user() { return user; },
    get club() { return club; },
    get status() { return status; },
    clientId,

    bind(h) { Object.assign(hooks, h); },

    async init() {
      if (!enabled) return null;
      const { data } = await sb.auth.getSession();
      user = (data && data.session && data.session.user) || null;
      sb.auth.onAuthStateChange((_evt, session) => { user = (session && session.user) || null; });
      return user;
    },

    get isAnon() { return !!(user && (user.is_anonymous || !user.email)); },

    /** No-account start: Supabase anonymous sign-in. Access to clubs is via club codes. */
    async signInAnon() {
      const { data, error } = await sb.auth.signInAnonymously();
      fail(error);
      user = data.user;
      return user;
    },

    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      fail(error);
      user = data.user;
      return user;
    },

    async signUp(email, password) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectUrl() } });
      fail(error);
      user = data.session ? data.user : null;
      return { user, needsConfirm: !data.session };
    },

    async resendConfirmation(email) {
      const { error } = await sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirectUrl() } });
      fail(error);
    },

    async signOut() {
      this.close();
      LS.del('pxm:lastClub');
      try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
      user = null;
    },

    async myClubs() {
      const { data, error } = await sb.from('clubs').select('id,name,join_code,created_at').order('created_at');
      fail(error);
      return data;
    },

    async createClub(name) {
      const { data, error } = await sb.rpc('create_club', { p_name: name });
      fail(error);
      return { id: data.id, name: data.name, join_code: data.join_code, session_start: Number(data.session_start) };
    },

    async joinClub(code) {
      const { data, error } = await sb.rpc('join_club', { p_code: code });
      fail(error);
      return { id: data.id, name: data.name, join_code: data.join_code };
    },

    async renameClub(name) {
      if (!club) return;
      const { error } = await sb.from('clubs').update({ name, last_writer: clientId }).eq('id', club.id);
      fail(error);
      club = { ...club, name };
      LS.set('pxm:clubmeta:' + club.id, club);
    },

    /** Open a club. If the app already holds cached state with unsynced edits, push them first. */
    async open(c, { isNew = false } = {}) {
      this.close();
      club = { id: c.id, name: c.name, join_code: c.join_code };
      LS.set('pxm:lastClub', c.id);
      LS.set('pxm:clubmeta:' + c.id, club);
      synced = isNew ? emptySnapshot(c.session_start) : LS.get('pxm:synced:' + c.id);
      subscribe();
      if (isNew) { await push(); return true; }
      if (synced && isDirty()) await push();
      return refresh();
    },

    close() {
      clearTimeout(pushTimer); clearTimeout(retryTimer); clearTimeout(refreshTimer);
      if (channel) { sb.removeChannel(channel); channel = null; }
      club = null; synced = null; busy = false; again = false; remoteWanted = false;
      setStatus('idle');
    },

    lastClub() {
      const id = LS.get('pxm:lastClub');
      return id ? LS.get('pxm:clubmeta:' + id) : null;
    },

    schedule,
    push,
    refresh,
  };
})();
