-- =====================================================================
-- Pickle X Matcher — migration 003: no-account mode
-- Run in Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- With anonymous sign-ins, the club code is what grants organizer access,
-- so new clubs get longer, harder-to-guess codes (8 characters instead of 6).
-- Existing clubs keep their current code.
-- =====================================================================
alter table public.clubs alter column join_code
  set default upper(substr(md5(gen_random_uuid()::text), 1, 8));
