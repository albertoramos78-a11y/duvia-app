-- 0050_pension_end_request.sql
--
-- Ajoute la possibilité de mettre fin à une pension ACTIVE, avec validation de
-- l'AUTRE parent — jusqu'ici, seule une NOUVELLE proposition pouvait
-- superseder une config active (changement de montant, voir
-- confirm_pension_config dans 0046), aucun moyen de simplement l'arrêter.
-- Même principe que la suppression d'une dépense déjà confirmée (App.jsx
-- ExpTab, requestDeleteExp/confirmDeleteExp/rejectDeleteExp) : une demande,
-- pas une suppression immédiate.
--
-- À exécuter après 0046. Idempotent (IF NOT EXISTS partout où possible).

alter table public.pension_configs
  add column if not exists pending_end boolean not null default false,
  add column if not exists end_requested_by uuid;

-- ── RPC : demander la fin d'une pension active (l'une ou l'autre partie) ────

create or replace function public.request_end_pension_config(p_config_id uuid)
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
  if v_row.status <> 'active' then
    raise exception 'not_active';
  end if;
  if auth.uid() not in (v_row.from_user_id, v_row.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;
  if v_row.pending_end then
    raise exception 'end_already_requested';
  end if;

  update public.pension_configs
     set pending_end = true, end_requested_by = auth.uid()
   where id = p_config_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.request_end_pension_config(uuid) from public;
grant execute on function public.request_end_pension_config(uuid) to authenticated;

-- ── RPC : confirmer la fin (par l'AUTRE partie que le demandeur) ────────────

create or replace function public.confirm_end_pension_config(p_config_id uuid)
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
  if v_row.status <> 'active' or not v_row.pending_end then
    raise exception 'no_pending_end_request';
  end if;
  if auth.uid() = v_row.end_requested_by then
    raise exception 'cannot_confirm_own_request';
  end if;
  if auth.uid() not in (v_row.from_user_id, v_row.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;

  update public.pension_configs
     set status = 'superseded', end_date = current_date, pending_end = false
   where id = p_config_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.confirm_end_pension_config(uuid) from public;
grant execute on function public.confirm_end_pension_config(uuid) to authenticated;

-- ── RPC : annuler/refuser la demande de fin (l'une ou l'autre partie — le
-- demandeur qui retire sa demande, ou l'autre parent qui la refuse) ─────────

create or replace function public.cancel_end_pension_config(p_config_id uuid)
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
  if not v_row.pending_end then
    raise exception 'no_pending_end_request';
  end if;
  if auth.uid() not in (v_row.from_user_id, v_row.to_user_id) then
    raise exception 'not_a_party_to_this_pension';
  end if;

  update public.pension_configs
     set pending_end = false, end_requested_by = null
   where id = p_config_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.cancel_end_pension_config(uuid) from public;
grant execute on function public.cancel_end_pension_config(uuid) to authenticated;
