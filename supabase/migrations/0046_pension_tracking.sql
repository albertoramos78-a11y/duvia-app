-- 0046_pension_tracking.sql
--
-- Suivi de la pension alimentaire (backlog item 14) — voir
-- docs/superpowers/specs/2026-07-20-child-support-tracking-design.md.
--
-- Entièrement séparé du solde des dépenses partagées (expenses/reimbursements) :
-- décision explicite, jamais mélangé dans balance[i] côté client.
--
-- Contrairement à expenses/reimbursements (RLS permissive, "confiance
-- familiale"), ce module impose des règles strictes côté serveur : toutes les
-- mutations passent par les 5 RPC SECURITY DEFINER ci-dessous, les tables
-- elles-mêmes n'accordent que SELECT aux clients authentifiés — décision
-- explicite de l'utilisateur (plus sûr, nouveau pattern dans ce projet,
-- assumé après avoir signalé la tension avec la convention existante).
--
-- À exécuter après 0045. Idempotent (IF NOT EXISTS partout où possible).

-- ── 1. Tables ─────────────────────────────────────────────────────────────

create table if not exists public.pension_configs (
  id                  uuid        primary key default gen_random_uuid(),
  family_id           uuid        not null references public.families(id) on delete cascade,
  from_parent         int         not null,
  from_user_id        uuid        not null,
  to_parent           int         not null,
  to_user_id          uuid        not null,
  amount              numeric(10,2) not null,
  day_of_month        int         not null check (day_of_month between 1 and 28),
  start_date          date        not null,
  end_date            date,
  status              text        not null default 'proposed' check (status in ('proposed','active','superseded')),
  created_by_user_id  uuid        not null,
  created_at          timestamptz not null default now(),
  confirmed_by_user_id uuid,
  confirmed_at        timestamptz
);

create index if not exists pension_configs_family_id_idx on public.pension_configs(family_id);

create table if not exists public.pension_payments (
  id                      uuid        primary key default gen_random_uuid(),
  family_id               uuid        not null references public.families(id) on delete cascade,
  config_id               uuid        not null references public.pension_configs(id) on delete cascade,
  period                  text        not null, -- 'YYYY-MM'
  amount                  numeric(10,2) not null,
  due_date                date        not null,
  status                  text        not null default 'pending' check (status in ('pending','marked_paid','confirmed','contested')),
  marked_paid_by_user_id  uuid,
  marked_paid_at          timestamptz,
  confirmed_by_user_id    uuid,
  confirmed_at            timestamptz,
  note                    text        not null default '',
  payer_reminder_sent_at  timestamptz,
  overdue_alert_sent_at   timestamptz,
  created_at              timestamptz not null default now(),
  unique (config_id, period)
);

create index if not exists pension_payments_family_id_idx on public.pension_payments(family_id);
create index if not exists pension_payments_config_id_idx on public.pension_payments(config_id);
create index if not exists pension_payments_due_date_idx  on public.pension_payments(due_date);

-- ── 2. RLS : lecture seule pour les clients, toute écriture via RPC ──────────

alter table public.pension_configs  enable row level security;
alter table public.pension_payments enable row level security;

drop policy if exists "pension_configs_select" on public.pension_configs;
create policy "pension_configs_select" on public.pension_configs for select
  using (exists (
    select 1 from public.family_members fm
    where fm.family_id = pension_configs.family_id and fm.user_id = auth.uid()
  ));

drop policy if exists "pension_payments_select" on public.pension_payments;
create policy "pension_payments_select" on public.pension_payments for select
  using (exists (
    select 1 from public.family_members fm
    where fm.family_id = pension_payments.family_id and fm.user_id = auth.uid()
  ));

-- Volontairement AUCUNE policy insert/update/delete : tout passe par les RPC
-- SECURITY DEFINER ci-dessous, qui s'exécutent avec les privilèges du
-- propriétaire de la table (contournent RLS) après leurs propres vérifications.

-- ── 3. RPC : proposer une configuration ─────────────────────────────────────

create or replace function public.propose_pension_config(
  p_family_id     uuid,
  p_from_parent   int,
  p_from_user_id  uuid,
  p_to_parent     int,
  p_to_user_id    uuid,
  p_amount        numeric,
  p_day_of_month  int,
  p_start_date    date
) returns public.pension_configs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if auth.uid() not in (p_from_user_id, p_to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;
  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = p_family_id and fm.user_id = auth.uid() and fm.role = 'parent'
  ) then
    raise exception 'not_a_parent';
  end if;
  if p_from_user_id = p_to_user_id then
    raise exception 'from_and_to_must_differ';
  end if;
  if not exists (
    select 1 from public.family_members fm
    where fm.family_id = p_family_id
      and fm.user_id = case when auth.uid() = p_from_user_id then p_to_user_id else p_from_user_id end
      and fm.role = 'parent'
  ) then
    raise exception 'counterparty_not_a_parent';
  end if;
  if p_day_of_month < 1 or p_day_of_month > 28 then
    raise exception 'invalid_day_of_month';
  end if;
  if p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;
  -- Only blocks a second SIMULTANEOUS proposal. An existing 'active' config is
  -- deliberately allowed here: proposing a new one against it is exactly how
  -- "changer le montant" works (see design doc's "Approche retenue" section) —
  -- the old 'active' row is only marked 'superseded' once this new one is
  -- confirmed, in confirm_pension_config below, never before.
  if exists (
    select 1 from public.pension_configs
    where family_id = p_family_id and status = 'proposed'
  ) then
    raise exception 'pension_already_configured';
  end if;

  insert into public.pension_configs (
    family_id, from_parent, from_user_id, to_parent, to_user_id,
    amount, day_of_month, start_date, status, created_by_user_id
  ) values (
    p_family_id, p_from_parent, p_from_user_id, p_to_parent, p_to_user_id,
    p_amount, p_day_of_month, p_start_date, 'proposed', auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.propose_pension_config(uuid,int,uuid,int,uuid,numeric,int,date) from public;
grant execute on function public.propose_pension_config(uuid,int,uuid,int,uuid,numeric,int,date) to authenticated;

-- ── 4. RPC : confirmer une configuration (par l'AUTRE parent) ───────────────

create or replace function public.confirm_pension_config(p_config_id uuid)
returns public.pension_configs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_configs where id = p_config_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'not_proposed';
  end if;
  if auth.uid() = v_row.created_by_user_id then
    raise exception 'cannot_confirm_own_proposal';
  end if;
  if auth.uid() not in (v_row.from_user_id, v_row.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;

  -- Clôt toute autre configuration active de la même famille (changement de
  -- montant) — seulement maintenant que la nouvelle est confirmée, jamais avant.
  update public.pension_configs
     set status = 'superseded', end_date = v_row.start_date
   where family_id = v_row.family_id
     and status = 'active'
     and id <> v_row.id;

  update public.pension_configs
     set status = 'active', confirmed_by_user_id = auth.uid(), confirmed_at = now()
   where id = p_config_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.confirm_pension_config(uuid) from public;
grant execute on function public.confirm_pension_config(uuid) to authenticated;

-- ── 5. RPC : annuler/refuser une configuration proposée (par l'une ou l'autre
-- partie, tant qu'elle est encore 'proposed') ───────────────────────────────
-- Sert les deux cas : le proposant qui retire sa propre proposition, ou le
-- destinataire qui la refuse. Suppression pure de la ligne — une proposition
-- annulée/refusée n'a jamais pris effet, donc aucune valeur d'historique à
-- conserver (simplification délibérée, pas un oubli : pas de statut 'rejected').

create or replace function public.cancel_pension_config(p_config_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_configs where id = p_config_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'not_proposed';
  end if;
  if auth.uid() not in (v_row.from_user_id, v_row.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;

  delete from public.pension_configs where id = p_config_id;
end;
$$;

revoke all on function public.cancel_pension_config(uuid) from public;
grant execute on function public.cancel_pension_config(uuid) to authenticated;

-- ── 6. RPC : le payeur marque un versement comme payé ───────────────────────

create or replace function public.mark_pension_payment_paid(p_payment_id uuid)
returns public.pension_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_payments;
  v_cfg public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_payments where id = p_payment_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  select * into v_cfg from public.pension_configs where id = v_row.config_id;

  if auth.uid() <> v_cfg.from_user_id then
    raise exception 'only_payer_can_mark_paid';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'not_pending';
  end if;

  update public.pension_payments
     set status = 'marked_paid', marked_paid_by_user_id = auth.uid(), marked_paid_at = now()
   where id = p_payment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.mark_pension_payment_paid(uuid) from public;
grant execute on function public.mark_pension_payment_paid(uuid) to authenticated;

-- ── 7. RPC : le bénéficiaire confirme un versement ──────────────────────────

create or replace function public.confirm_pension_payment(p_payment_id uuid)
returns public.pension_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_payments;
  v_cfg public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_payments where id = p_payment_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  select * into v_cfg from public.pension_configs where id = v_row.config_id;

  if auth.uid() <> v_cfg.to_user_id then
    raise exception 'only_recipient_can_confirm';
  end if;
  if v_row.status <> 'marked_paid' then
    raise exception 'not_marked_paid';
  end if;

  update public.pension_payments
     set status = 'confirmed', confirmed_by_user_id = auth.uid(), confirmed_at = now()
   where id = p_payment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.confirm_pension_payment(uuid) from public;
grant execute on function public.confirm_pension_payment(uuid) to authenticated;

-- ── 8. RPC : le bénéficiaire conteste un versement ──────────────────────────

create or replace function public.contest_pension_payment(p_payment_id uuid, p_note text default '')
returns public.pension_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pension_payments;
  v_cfg public.pension_configs;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.pension_payments where id = p_payment_id;
  if v_row.id is null then
    raise exception 'not_found';
  end if;
  select * into v_cfg from public.pension_configs where id = v_row.config_id;

  if auth.uid() <> v_cfg.to_user_id then
    raise exception 'only_recipient_can_contest';
  end if;
  if v_row.status <> 'marked_paid' then
    raise exception 'not_marked_paid';
  end if;

  update public.pension_payments
     set status = 'contested', confirmed_by_user_id = auth.uid(), confirmed_at = now(),
         note = coalesce(nullif(btrim(p_note), ''), '')
   where id = p_payment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.contest_pension_payment(uuid, text) from public;
grant execute on function public.contest_pension_payment(uuid, text) to authenticated;

-- ── 9. Fonction de génération mensuelle (appelée par pg_cron, pas par un client) ──

create extension if not exists pg_net with schema extensions;

create or replace function public.generate_due_pension_payments()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg record;
  v_period   text;
  v_due_date date;
begin
  v_period := to_char(current_date, 'YYYY-MM');
  for cfg in
    select * from public.pension_configs
    where status = 'active' and start_date <= current_date
  loop
    v_due_date := date_trunc('month', current_date)::date + (cfg.day_of_month - 1);
    if v_due_date >= cfg.start_date then
      insert into public.pension_payments (family_id, config_id, period, amount, due_date, status)
      values (cfg.family_id, cfg.id, v_period, cfg.amount, v_due_date, 'pending')
      on conflict (config_id, period) do nothing;
    end if;
  end loop;
end;
$$;

revoke all on function public.generate_due_pension_payments() from public, authenticated;
