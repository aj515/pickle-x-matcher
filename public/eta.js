/* Pickle X Matcher — Smart ETA engine (shared by the organizer app and the Live Board).
 *
 * Simulates the courts forward in time: each busy court frees up when its game is
 * expected to end (based on this session's real game lengths), and the queue fills
 * courts in order. The result is a per-player "you're up in ~N min" estimate.
 */
'use strict';
window.PXEta = (() => {
  const MIN = 60000;
  const DEFAULT_GAME = 13 * MIN;

  /** Typical game length: recency-weighted mean of recent games, ignoring outliers. */
  function avgGame(durations) {
    const d = (durations || []).filter((x) => x > 3 * MIN && x < 60 * MIN).slice(-12);
    if (!d.length) return DEFAULT_GAME;
    let sum = 0, w = 0;
    d.forEach((x, i) => { const wt = 1 + i / d.length; sum += x * wt; w += wt; }); // newer games count more
    return sum / w;
  }

  /**
   * @param courts  [{ active, start }]  start = ms when current game began, or null if open
   * @param count   number of players waiting
   * @param need    players per game (4 doubles, 2 singles)
   * @param avg     typical game length (ms)
   * @param now     current time (ms)
   * @returns array (length = count) of ms until each queued player's game starts (null = unknown)
   */
  function forQueue(courts, count, need, avg, now) {
    const free = courts.filter((c) => c.active).map((c) => (c.start ? Math.max(MIN, avg - (now - c.start)) : 0));
    if (!free.length || !count) return new Array(count).fill(null);
    const starts = [];
    for (let g = 0; g < Math.ceil(count / need); g++) {
      let i = 0;
      for (let j = 1; j < free.length; j++) if (free[j] < free[i]) i = j;
      starts.push(free[i]);
      free[i] += avg;
    }
    // Players left over after the last full game must wait for the next one.
    return Array.from({ length: count }, (_, i) => (Math.floor(i / need) < starts.length ? starts[Math.floor(i / need)] : null));
  }

  function label(ms) {
    if (ms == null) return '';
    if (ms < MIN) return 'Next up';
    const m = Math.round(ms / MIN);
    return m >= 60 ? `~${Math.floor(m / 60)}h ${m % 60}m` : `~${m} min`;
  }

  return { avgGame, forQueue, label, DEFAULT_GAME };
})();
