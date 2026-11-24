-- =====================================================================
-- Pickle X Matcher — migration 002: fixed partners + PX Live Board
-- Run in Supabase → SQL Editor → New query → Run. Safe to re-run.
-- (Already included in supabase/schema.sql for fresh installs.)
-- =====================================================================

-- Fixed partners: two players who always play on the same team.
alter table public.players add column if not exists partner_id text;

-- Board code: a separate, read-only code for the public Live Board.
-- (Different from join_code, which grants organizer access.)
alter table public.clubs add column if not exists board_code text
  default lower(substr(md5(gen_random_uuid()::text), 1, 10));
update public.clubs set board_code = lower(substr(md5(gen_random_uuid()::text), 1, 10)) where board_code is null;
alter table public.clubs alter column board_code set not null;
create unique index if not exists clubs_board_code_idx on public.clubs(board_code);

-- Public, read-only snapshot for the Live Board. Exposes only what players need:
-- club name, courts (who's playing), who's in line, and recent game lengths for ETAs.
create or replace function public.get_board(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', c.name,
    'team_size', coalesce((c.settings->>'teamSize')::int, 2),
    'mode', coalesce(c.settings->>'mode', 'balanced'),
    'now', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'players', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'status', p.status, 'qpos', p.qpos,
        'wait_since', p.wait_since, 'partner_id', p.partner_id)), '[]'::jsonb)
      from public.players p
      where p.club_id = c.id and not p.deleted and p.status <> 'out'),
    'courts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', k.id, 'name', k.name, 'active', k.active, 'match', k.match) order by k.position), '[]'::jsonb)
      from public.courts k where k.club_id = c.id),
    'recent', (
      select coalesce(jsonb_agg(x.d), '[]'::jsonb) from (
        select g.ended_at - g.started_at as d from public.games g
        where g.club_id = c.id and g.session_start = c.session_start
        order by g.ended_at desc limit 12) x)
  )
  from public.clubs c
  where c.board_code = lower(trim(p_code));
$$;

revoke all on function public.get_board(text) from public;
grant execute on function public.get_board(text) to anon, authenticated;
