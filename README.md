# Pickle X Matcher

Smart open-play queue and court matchmaking for pickleball. A mobile-first web app (PWA) backed by **Supabase**, deployed on **Vercel**.

**Live:** https://pickle-x-matcher.vercel.app

## How it works

- Organizers sign in (email + password) and create or join a **club** (a venue / open-play group).
- Courts, queue, roster and games sync **live** between every organizer's phone (Supabase Realtime).
- **Offline-first:** the app keeps working with no signal and catches up automatically when back online.
- Without Supabase keys, the app runs in device-only mode (data in the browser's localStorage).

## Signature features

- **PX Live Board with Smart ETA:** players scan a QR code (Courts tab, then *PX Live Board*), tap their name,
  and see their spot in line with a live "You're up in ~6 min". The ETA simulates the courts forward using
  this session's real game lengths. Their phone buzzes and chimes when they're called to a court.
  No app or login for players. Add `&tv=1` to the link for a big-screen venue display with its own QR.
- **Fixed partners:** lock two players together (Players tab, then the player, then *Lock partner*). They wait in line
  as a unit and are always placed on the same team (doubles only).

## Project layout

| Path | Purpose |
|---|---|
| `public/index.html`, `styles.css`, `app.js` | The app (views, matchmaking engine, actions) |
| `public/cloud.js` | Supabase sync layer: auth, clubs, diff-based push, realtime pull |
| `public/sw.js` | Service worker (offline support) |
| `supabase/schema.sql` | Database tables, Row Level Security, RPCs, realtime |
| `scripts/build.mjs` | Generates `public/config.js` from env vars, vendors supabase-js |
| `vercel.json` | Vercel build/output config |

## Supabase setup (one time)

1. Create a free project at https://supabase.com.
2. **SQL Editor → New query →** paste all of `supabase/schema.sql` → **Run**.
   (Existing installs: run `supabase/migrations/002_partners_and_live_board.sql` for fixed partners and the Live Board.)
3. **Authentication → URL Configuration:** set **Site URL** to `https://pickle-x-matcher.vercel.app`.
4. Optional: **Authentication → Providers → Email:** turn off *Confirm email* so new organizers can sign in immediately.
5. **Project Settings → API:** copy the **Project URL** and the **anon public** key.

## Vercel

Set the two env vars, then redeploy:

```
npx vercel env add SUPABASE_URL production
npx vercel env add SUPABASE_ANON_KEY production
npx vercel deploy --prod
```

(The anon key is designed to be public. Security comes from the Row Level Security policies in `schema.sql`.)

## Local development

```
npm install
cp .env.example .env     # fill in your Supabase URL + anon key (optional)
npm run dev              # builds and serves public/ at http://localhost:3000
```

## Database model

- `clubs`: settings, current session, join code
- `club_members`: which organizers can access which clubs (owner / organizer)
- `players`: roster and live status (queue position, resting, playing)
- `courts`: current match and Winners Stay streak
- `games`: every finished game; past sessions are kept for all-time history

## Matchmaking

1. The longest-waiting player is **always** in the next game, so nobody gets skipped.
2. The others are chosen from a look-ahead window to minimize team skill gap, repeat partners,
   repeat opponents, and skipping people who waited longer.
3. Modes: **Smart Balanced**, **Skill Groups**, **First Come First Serve**, **Winners Stay**.

## Roadmap to the native app

- Wrap `public/` with **Capacitor** for App Store / Play Store builds (no rewrite needed).
- Player self check-in by QR code, "you're up next" push notifications, TV board view.
- All-time leaderboards and Elo-style ratings from the `games` table.
