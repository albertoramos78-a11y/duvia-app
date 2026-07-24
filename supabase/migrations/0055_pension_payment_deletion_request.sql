-- 0055_pension_payment_deletion_request.sql
--
-- Either party to a pension can request a specific monthly payment LINE be
-- deleted (e.g. created by mistake, needs correcting) — same
-- confirmed-deletion pattern as expenses (0022): a request flag instead of
-- an immediate delete, the OTHER party confirms (real delete) or refuses
-- (flag cleared). Distinct from contest_pension_payment (0046), which
-- disputes whether a payment was actually received without removing the
-- record.
--
-- À exécuter après 0054. Idempotent (IF NOT EXISTS / CREATE OR REPLACE).

alter table public.pension_payments
  add column if not exists pending_delete boolean not null default false,
  add column if not exists delete_requested_by uuid;

create or replace function public.request_delete_pension_payment(p_payment_id uuid)
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

  if auth.uid() not in (v_cfg.from_user_id, v_cfg.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;
  if v_row.pending_delete then
    raise exception 'deletion_already_requested';
  end if;

  update public.pension_payments
     set pending_delete = true, delete_requested_by = auth.uid()
   where id = p_payment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.request_delete_pension_payment(uuid) from public;
grant execute on function public.request_delete_pension_payment(uuid) to authenticated;

-- ── Confirmer (par l'AUTRE partie que le demandeur) : suppression réelle ────

create or replace function public.confirm_delete_pension_payment(p_payment_id uuid)
returns void
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
  if not v_row.pending_delete then
    raise exception 'no_pending_deletion';
  end if;
  select * into v_cfg from public.pension_configs where id = v_row.config_id;
  if auth.uid() not in (v_cfg.from_user_id, v_cfg.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;
  if auth.uid() = v_row.delete_requested_by then
    raise exception 'cannot_confirm_own_request';
  end if;

  delete from public.pension_payments where id = p_payment_id;
end;
$$;

revoke all on function public.confirm_delete_pension_payment(uuid) from public;
grant execute on function public.confirm_delete_pension_payment(uuid) to authenticated;

-- ── Annuler/refuser (le demandeur qui retire sa demande, ou l'autre partie
-- qui la refuse) ─────────────────────────────────────────────────────────

create or replace function public.cancel_delete_pension_payment(p_payment_id uuid)
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
  if not v_row.pending_delete then
    raise exception 'no_pending_deletion';
  end if;
  select * into v_cfg from public.pension_configs where id = v_row.config_id;
  if auth.uid() not in (v_cfg.from_user_id, v_cfg.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;

  update public.pension_payments
     set pending_delete = false, delete_requested_by = null
   where id = p_payment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.cancel_delete_pension_payment(uuid) from public;
grant execute on function public.cancel_delete_pension_payment(uuid) to authenticated;
