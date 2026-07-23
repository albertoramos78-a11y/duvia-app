-- 0049_wheel_spins_security.sql
--
-- Wheel cosmetic-prize server-side security fix (backlog item 9c) — see
-- docs/superpowers/specs/2026-07-23-wheel-cosmetic-prize-security-design.md.
-- Moves the wheel's entire prize draw, cooldown, eligibility, and
-- persistence server-side. Idempotent (IF NOT EXISTS / OR REPLACE
-- throughout), safe to re-run.

-- ── 1. Table: one row per real spin (cooldown + ownership source of truth) ──

create table if not exists public.wheel_spins (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  family_id       uuid not null,
  spun_at         timestamptz not null default now(),
  prize_id        text not null,
  used_bonus_spin boolean not null default false
);

-- 🔧 Adds ON DELETE CASCADE that was missing from the original CREATE TABLE
-- above (review finding) — DROP+ADD because Postgres can't alter a FK's
-- delete action in place. Idempotent: safe whether the table was just
-- created fresh (with the fixed inline FK) or already existed (this fixes
-- the already-deployed constraint).
alter table public.wheel_spins drop constraint if exists wheel_spins_user_id_fkey;
alter table public.wheel_spins add constraint wheel_spins_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

create index if not exists wheel_spins_user_id_idx on public.wheel_spins(user_id);

alter table public.wheel_spins enable row level security;

drop policy if exists "wheel_spins_select_own" on public.wheel_spins;
create policy "wheel_spins_select_own" on public.wheel_spins
  for select using (user_id = auth.uid());

-- Deliberately NO insert/update/delete policy for authenticated/anon — only
-- spin_wheel() (SECURITY DEFINER, added in a later step of this file) writes
-- to this table, executing as the table owner regardless of these policies.
