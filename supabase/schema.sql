-- =====================================================================
-- Pickle X Matcher — Supabase schema
-- Run this whole file in Supabase → SQL Editor → New query → Run.
-- Safe to re-run (idempotent).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- A club = one venue / open-play group. Organizers are members of clubs.
create table if not exists public.clubs (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 60),
  join_code     text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  settings      jsonb not null default '{}'::jsonb,
  session_start bigint not null default (extract(epoch from now()) * 1000)::bigint, -- ms since epoch
  seq           bigint not null default 0,         -- queue position counter
  last_writer   text,                              -- device id of the last writer (to ignore our own realtime echoes)
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.club_members (
  club_id    uuid not null references public.clubs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'organizer' check (role in ('owner', 'organizer')),
  created_at timestamptz not null default now(),
  primary key (club_id, user_id)
);
create index if not exists club_members_user_idx on public.club_members(user_id);

-- Roster (persists across sessions)
create table if not exists public.players (
  id         text primary key,
  club_id    uuid not null references public.clubs(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  level      double precision not null default 3,
  status     text not null default 'out' check (status in ('out', 'queue', 'playing', 'rest')),
  qpos       double precision not null default 0,
  wait_since bigint not null default 0,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists players_club_idx on public.players(club_id);

create table if not exists public.courts (
  id         text primary key,
  club_id    uuid not null references public.clubs(id) on delete cascade,
  name       text not null,
  position   int not null default 0,
  active     boolean not null default true,
  match      jsonb,   -- { a: [playerId], b: [playerId], start: ms }
  king       jsonb,   -- Winners Stay streak: { ids: [playerId], streak: n }
  updated_at timestamptz not null default now()
);
create index if not exists courts_club_idx on public.courts(club_id);

-- Every finished game. Games from past sessions are kept for all-time history.
create table if not exists public.games (
  id            text primary key,
  club_id       uuid not null references public.clubs(id) on delete cascade,
  session_start bigint not null,
  court         text,
  team_a        text[] not null,
  team_b        text[] not null,
  score_a       int,
  score_b       int,
  winner        text not null check (winner in ('a', 'b')),
  started_at    bigint not null,
  ended_at      bigint not null,
  created_at    timestamptz not null default now()
);
create index if not exists games_club_session_idx on public.games(club_id, session_start);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.is_club_member(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.club_members where club_id = c and user_id = auth.uid());
$$;

create or replace function public.create_club(p_name text)
returns public.clubs language plpgsql security definer set search_path = public as $$
declare c public.clubs;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.clubs (name, created_by) values (trim(p_name), auth.uid()) returning * into c;
  insert into public.club_members (club_id, user_id, role) values (c.id, auth.uid(), 'owner');
  return c;
end $$;

create or replace function public.join_club(p_code text)
returns public.clubs language plpgsql security definer set search_path = public as $$
declare c public.clubs;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into c from public.clubs where join_code = upper(trim(p_code));
  if not found then raise exception 'No club found with that code'; end if;
  insert into public.club_members (club_id, user_id, role) values (c.id, auth.uid(), 'organizer')
    on conflict do nothing;
  return c;
end $$;

revoke all on function public.create_club(text) from public, anon;
revoke all on function public.join_club(text) from public, anon;
grant execute on function public.create_club(text) to authenticated;
grant execute on function public.join_club(text) to authenticated;
grant execute on function public.is_club_member(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security: organizers only see and edit their own clubs.
-- ---------------------------------------------------------------------
alter table public.clubs        enable row level security;
alter table public.club_members enable row level security;
alter table public.players      enable row level security;
alter table public.courts       enable row level security;
alter table public.games        enable row level security;

drop policy if exists clubs_select on public.clubs;
drop policy if exists clubs_update on public.clubs;
drop policy if exists clubs_delete on public.clubs;
create policy clubs_select on public.clubs for select to authenticated using (public.is_club_member(id));
create policy clubs_update on public.clubs for update to authenticated using (public.is_club_member(id)) with check (public.is_club_member(id));
create policy clubs_delete on public.clubs for delete to authenticated using (
  exists (select 1 from public.club_members m where m.club_id = id and m.user_id = auth.uid() and m.role = 'owner'));

drop policy if exists members_select on public.club_members;
drop policy if exists members_delete_self on public.club_members;
create policy members_select on public.club_members for select to authenticated using (user_id = auth.uid() or public.is_club_member(club_id));
create policy members_delete_self on public.club_members for delete to authenticated using (user_id = auth.uid());

drop policy if exists players_all on public.players;
drop policy if exists courts_all on public.courts;
drop policy if exists games_all on public.games;
create policy players_all on public.players for all to authenticated using (public.is_club_member(club_id)) with check (public.is_club_member(club_id));
create policy courts_all  on public.courts  for all to authenticated using (public.is_club_member(club_id)) with check (public.is_club_member(club_id));
create policy games_all   on public.games   for all to authenticated using (public.is_club_member(club_id)) with check (public.is_club_member(club_id));

-- ---------------------------------------------------------------------
-- Fixed partners + PX Live Board (same as migrations/002_partners_and_live_board.sql)
-- ---------------------------------------------------------------------
alter table public.players add column if not exists partner_id text;
alter table public.clubs add column if not exists board_code text
  default lower(substr(md5(gen_random_uuid()::text), 1, 10));
update public.clubs set board_code = lower(substr(md5(gen_random_uuid()::text), 1, 10)) where board_code is null;
alter table public.clubs alter column board_code set not null;
create unique index if not exists clubs_board_code_idx on public.clubs(board_code);

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

-- ---------------------------------------------------------------------
-- Realtime: devices listen for changes to their club row (bumped on every save).
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.clubs;
exception when duplicate_object then null;
end $$;
