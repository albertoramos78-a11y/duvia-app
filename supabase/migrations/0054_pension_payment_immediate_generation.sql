-- 0054_pension_payment_immediate_generation.sql
--
-- Bug reported live 2026-07-24: a pension confirmed today (start_date
-- 2026-07-01, day_of_month=5) showed no payment row at all for the
-- 2026-07-05 due date. Root cause: generate_due_pension_payments() (0046)
-- only ever generates the CURRENT month's row, and is called exclusively by
-- a daily pg_cron job (configured only in the Supabase dashboard, not
-- committed here) — a config confirmed after that day's cron already ran
-- has to wait up to 24h for its very first payment to appear, and any
-- month between start_date and confirmation is never backfilled at all.
--
-- Fix: confirm_pension_config() now backfills every due period from
-- start_date through the current month immediately, instead of waiting on
-- the cron. The daily cron function is untouched — it still covers new
-- months arriving for already-active configs.
--
-- Also relaxes confirm_pension_payment(): per product direction, the payer
-- marking a payment "paid" is a courtesy step, not a requirement — the
-- recipient can confirm receipt directly from 'pending', not only from
-- 'marked_paid'. mark_pension_payment_paid() is unchanged (still available,
-- just optional now).
--
-- À exécuter après 0053. Idempotent (CREATE OR REPLACE).

create or replace function public.generate_pension_payments_for_config(p_config_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg record;
  v_month date;
  v_due_date date;
  v_period text;
begin
  select * into cfg from public.pension_configs where id = p_config_id and status = 'active';
  if cfg.id is null then
    return;
  end if;

  v_month := date_trunc('month', cfg.start_date)::date;
  while v_month <= date_trunc('month', current_date)::date loop
    v_due_date := v_month + (cfg.day_of_month - 1);
    if v_due_date >= cfg.start_date and v_due_date <= current_date then
      v_period := to_char(v_month, 'YYYY-MM');
      insert into public.pension_payments (family_id, config_id, period, amount, due_date, status)
      values (cfg.family_id, cfg.id, v_period, cfg.amount, v_due_date, 'pending')
      on conflict (config_id, period) do nothing;
    end if;
    v_month := v_month + interval '1 month';
  end loop;
end;
$$;

revoke all on function public.generate_pension_payments_for_config(uuid) from public, authenticated;

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

  perform public.generate_pension_payments_for_config(v_row.id);

  return v_row;
end;
$$;

revoke all on function public.confirm_pension_config(uuid) from public;
grant execute on function public.confirm_pension_config(uuid) to authenticated;

-- ── confirm_pension_payment() : accepte 'pending' ET 'marked_paid' ──────────

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
  if v_row.status not in ('pending', 'marked_paid') then
    raise exception 'not_confirmable';
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
