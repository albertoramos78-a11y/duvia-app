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

-- ── 2. Family-wide effective Premium — full replica of src/App.jsx's
--    subStatus()+isBeta()+planRankFor()+bestParentSub(). NOT granted to
--    authenticated — only spin_wheel() (Task 4) calls it internally.
--    Resync manually if the client-side logic changes.

drop function if exists public._wheel_plan_rank(uuid,text,timestamptz,text,int,timestamptz,timestamptz,int,timestamptz,boolean);

create or replace function public._wheel_plan_rank(
  p_user_id uuid,
  p_plan text,
  p_premium_since timestamptz,
  p_cycle text,
  p_ref_months int,
  p_trial_start timestamptz,
  p_account_created_at timestamptz,
  p_trial_extension_days int,
  p_acct_beta_end timestamptz,
  p_global_beta boolean,
  p_apply_admin_and_ref boolean default true
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_plan text := coalesce(p_plan, 'trial_premium'); -- no subscriptions row yet → fresh-trial default, mirrors bestParentSub()'s fallback
  v_created timestamptz := coalesce(p_account_created_at, p_trial_start, now());
  v_ext int := coalesce(p_trial_extension_days, 0);
  v_expiry timestamptz;
  v_max_days int;
  v_days numeric;
  v_status text;
begin
  if p_apply_admin_and_ref then
    select exists(select 1 from public.app_admins where user_id = p_user_id) into v_is_admin;
    if v_is_admin then
      return 2; -- mirrors subStatus(): if(sub._admin) return "premium"
    end if;
  end if;

  if v_plan = 'premium' then
    if p_premium_since is not null and p_cycle is not null then
      v_expiry := p_premium_since
        + (case when p_cycle = 'yearly' then interval '1 year' else interval '1 month' end)
        + ((case when p_apply_admin_and_ref then coalesce(p_ref_months, 0) else 0 end) * interval '30 days');
      v_status := case when now() > v_expiry then 'freemium' else 'premium' end;
    else
      v_status := 'premium';
    end if;
  elsif v_plan = 'beta' then
    if p_acct_beta_end is not null and now() < p_acct_beta_end then
      v_status := 'trial_premium';
    elsif p_acct_beta_end is null then
      -- Mirrors subStatus(): a null betaEnd makes the JS fall back to
      -- betaEndMs=0 (Unix epoch) — always in the past, so the elapsed-days
      -- check below always exceeds TRIAL_BASE_DAYS and JS always returns
      -- "freemium" in this case. Handled as its own branch rather than
      -- coalescing beta_end to now() (which would wrongly compute 0 elapsed
      -- days and return trial_premium instead — the bug this fixes).
      v_status := 'freemium';
    else
      v_days := extract(epoch from (now() - p_acct_beta_end)) / 86400;
      v_status := case when v_days <= 15 then 'trial_premium' else 'freemium' end; -- TRIAL_BASE_DAYS
    end if;
  elsif v_plan = 'freemium' then
    v_status := 'freemium';
  else
    -- organic path: trial_premium / earned_premium
    v_max_days := least(15 + v_ext, 30); -- TRIAL_BASE_DAYS + ext, capped at TRIAL_MAX_DAYS
    v_days := extract(epoch from (now() - v_created)) / 86400;
    if v_days <= v_max_days then
      v_status := case when v_plan = 'earned_premium' then 'earned_premium' else 'trial_premium' end;
    elsif p_global_beta then
      v_status := 'trial_premium';
    else
      v_status := 'freemium';
    end if;
  end if;

  return case
    when v_status = 'premium' then 2
    when v_status in ('trial_premium', 'earned_premium') then 1
    else 0
  end;
end;
$$;

revoke all on function public._wheel_plan_rank(uuid,text,timestamptz,text,int,timestamptz,timestamptz,int,timestamptz,boolean,boolean) from public;

drop function if exists public._wheel_family_is_premium(uuid);

create or replace function public._wheel_family_is_premium(p_family_id uuid, p_calling_uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_beta_enabled boolean;
  v_beta_end timestamptz;
  v_global_beta boolean;
  v_best_rank int := -1;
  v_rank int;
  rec record;
begin
  select beta_enabled, beta_end into v_beta_enabled, v_beta_end
    from public.app_config where id = 1;
  v_global_beta := coalesce(v_beta_enabled, false) and v_beta_end is not null and now() < v_beta_end;

  for rec in
    select fm.user_id,
           s.plan, s.premium_since, s.cycle, s.ref_months,
           s.trial_start, s.account_created_at, s.trial_extension_days,
           s.beta_end as acct_beta_end
      from public.family_members fm
      left join public.subscriptions s on s.user_id = fm.user_id
     where fm.family_id = p_family_id
       and fm.role = 'parent'
       and fm.status = 'active'
  loop
    v_rank := public._wheel_plan_rank(
      rec.user_id, rec.plan, rec.premium_since, rec.cycle, rec.ref_months,
      rec.trial_start, rec.account_created_at, rec.trial_extension_days,
      rec.acct_beta_end, v_global_beta,
      p_apply_admin_and_ref := (rec.user_id = p_calling_uid)
    );
    if v_rank > v_best_rank then v_best_rank := v_rank; end if;
  end loop;

  return v_best_rank >= 1; -- rank 1 (trial/earned) or 2 (premium) both count as family-premium
end;
$$;

revoke all on function public._wheel_family_is_premium(uuid,uuid) from public;

-- ── 3. Draw logic — individual-subscriber check (extracted verbatim from
--    the soon-to-be-retired spin_wheel_check_monetary_prize(), migration
--    0041) and the weighted draw (mirrors PROBS_SUBSCRIBER/PROBS_OTHERS in
--    src/App.jsx). Neither granted to authenticated — internal to
--    spin_wheel() (Task 4).

create or replace function public._wheel_is_individual_subscriber(p_uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text;
  v_premium_since timestamptz;
  v_cycle text;
  v_ref_months int;
  v_expiry timestamptz;
begin
  select plan, premium_since, cycle, coalesce(ref_months, 0)
    into v_plan, v_premium_since, v_cycle, v_ref_months
  from public.subscriptions
  where user_id = p_uid;

  if v_plan is distinct from 'premium' then
    return false;
  end if;
  if v_premium_since is not null and v_cycle is not null then
    v_expiry := v_premium_since
      + (case when v_cycle = 'yearly' then interval '1 year' else interval '1 month' end)
      + (v_ref_months * interval '30 days');
    return now() <= v_expiry;
  end if;
  return true;
end;
$$;

revoke all on function public._wheel_is_individual_subscriber(uuid) from public;

create or replace function public._wheel_draw(p_is_subscriber boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r double precision := random();
  v_cum double precision := 0;
  v_year double precision := case when p_is_subscriber then 0.001 else 0 end;
  v_month double precision := case when p_is_subscriber then 0.010 else 0 end;
  v_theme double precision := 0.200;
  v_video double precision := 0.100;
  v_licorne double precision := 0.100;
  v_rg double precision := 0.050;
  v_wc double precision := 0.050;
  -- Seasonal windows — mirrors SUMMER_START/END, RG_START/END, WC_START/END
  -- in src/theme.js. Resync manually if those dates change.
  v_theme_active boolean := now() >= '2026-06-21'::timestamptz and now() <= '2026-07-23 23:59:59'::timestamptz;
  v_rg_active boolean := now() >= '2026-05-24'::timestamptz and now() <= '2026-06-04 23:59:59'::timestamptz;
  v_wc_active boolean := now() >= '2026-06-06'::timestamptz and now() <= '2026-07-26 23:59:59'::timestamptz;
begin
  if not v_theme_active then v_theme := 0; end if;
  if not v_rg_active then v_rg := 0; end if;
  if not v_wc_active then v_wc := 0; end if;

  if v_r < v_cum + v_year then return 'year'; end if;
  v_cum := v_cum + v_year;
  if v_r < v_cum + v_month then return 'month'; end if;
  v_cum := v_cum + v_month;
  if v_r < v_cum + v_theme then return 'theme'; end if;
  v_cum := v_cum + v_theme;
  if v_r < v_cum + v_video then return 'video'; end if;
  v_cum := v_cum + v_video;
  if v_r < v_cum + v_licorne then return 'licorne'; end if;
  v_cum := v_cum + v_licorne;
  if v_r < v_cum + v_rg then return 'rg'; end if;
  v_cum := v_cum + v_rg;
  if v_r < v_cum + v_wc then return 'wc'; end if;
  return 'nothing';
end;
$$;

revoke all on function public._wheel_draw(boolean) from public;
