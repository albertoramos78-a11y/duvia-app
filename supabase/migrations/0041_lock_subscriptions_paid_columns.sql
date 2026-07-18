-- 0041_lock_subscriptions_paid_columns.sql
--
-- Context: the `subscriptions` table (not itself defined in a repo migration —
-- created directly in the Supabase dashboard, like several other tables in
-- this project) has RLS policies (subscriptions_insert_own/_update_own) that
-- only restrict WHICH ROW a client can touch (their own), not WHICH VALUES.
-- Combined with the client's own "Sync sub → table subscriptions" effect
-- (src/App.jsx, upserts `plan`/`premium_since`/`cycle` straight from local
-- React state on every change), this meant any authenticated user could
-- grant themselves Premium: either by tampering with local client state
-- (e.g. via React DevTools) and letting the app's own legitimate sync effect
-- upload the forged values, or by calling the Supabase REST API directly with
-- their own JWT. Confirmed exploitable, not theoretical — this migration
-- closes it at the column-privilege level, independent of RLS.
--
-- Depends on: the `subscriptions` table already existing (created outside
-- this repo). Run this AFTER deploying the matching client change that stops
-- sending plan/premium_since/cycle in the reverse-sync upsert (src/App.jsx) —
-- otherwise that upsert will start failing outright for every user (a single
-- UPDATE/INSERT statement fails entirely if it references a column the
-- caller lacks privilege on, even if other columns in the same statement are
-- fine).
--
-- SECURITY DEFINER functions (the admin Edge Function's underlying RPCs, the
-- referral-crediting RPCs, and the new spin_wheel_check_monetary_prize()
-- below) are unaffected by this REVOKE: they execute as the function owner
-- (the table owner in Supabase), and a table owner always has full column
-- privileges on their own tables regardless of explicit GRANT/REVOKE.

begin;

-- Safety net: once the client stops specifying these columns on insert (new
-- account, first-ever row), make sure sane defaults still apply — matching
-- makeSub()'s client-side defaults for a brand new account.
alter table public.subscriptions
  alter column plan set default 'trial_premium',
  alter column cycle set default 'yearly';

revoke update (plan, premium_since, cycle) on public.subscriptions from public;
revoke insert (plan, premium_since, cycle) on public.subscriptions from public;

-- ── Server-side, tamper-proof check for the wheel's two monetary prizes ────
-- Only "1 mois offert"/"1 an offert" have real monetary value — the other
-- prizes (seasonal themes) are cosmetic, client-local only (never persisted
-- to this table), and are left to the existing client-side random draw,
-- which is fine since there is no exploitable value in forcing one of them.
--
-- This function does NOT auto-grant the prize (matches current product
-- behavior — winning still shows "sera appliqué à votre prochain paiement",
-- a manual/future-automation step) — it only makes the DRAW itself honest,
-- so it can no longer be forced to always return a win by manipulating
-- Math.random() in the browser.
create or replace function public.spin_wheel_check_monetary_prize()
returns text -- 'year' | 'month' | 'none'
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_plan text;
  v_premium_since timestamptz;
  v_cycle text;
  v_ref_months int;
  v_is_subscriber boolean := false;
  v_expiry timestamptz;
  v_r double precision := random();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select plan, premium_since, cycle, coalesce(ref_months, 0)
    into v_plan, v_premium_since, v_cycle, v_ref_months
  from public.subscriptions
  where user_id = v_uid;

  -- Même définition de "souscripteur" que perms.spinWinSub côté client
  -- (App.jsx) : le plan INDIVIDUEL doit être premium et non expiré — jamais
  -- le plan familial partagé.
  if v_plan = 'premium' then
    if v_premium_since is not null and v_cycle is not null then
      v_expiry := v_premium_since
        + (case when v_cycle = 'yearly' then interval '1 year' else interval '1 month' end)
        + (v_ref_months * interval '30 days');
      v_is_subscriber := now() <= v_expiry;
    else
      v_is_subscriber := true;
    end if;
  end if;

  if not v_is_subscriber then
    return 'none'; -- PROBS_OTHERS: year/month sont déjà à 0% pour les non-souscripteurs
  end if;

  -- PROBS_SUBSCRIBER (App.jsx) : year 0.1%, month 1.0%
  if v_r < 0.001 then return 'year'; end if;
  if v_r < 0.011 then return 'month'; end if;
  return 'none';
end;
$$;

grant execute on function public.spin_wheel_check_monetary_prize() to authenticated;

commit;
