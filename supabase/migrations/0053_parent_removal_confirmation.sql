-- 0053_parent_removal_confirmation.sql
--
-- remove_family_member() let the earlier-joined member (in practice, almost
-- always the family creator) unilaterally kick out an already-active PARENT
-- with zero involvement from the removed party — a real power imbalance for
-- a co-parenting app ("aucun parent n'est administrateur de l'autre" was
-- advertised but not actually true). Root-caused 2026-07-24: the only live
-- UI path (App.jsx retirerInvite()) calls remove_family_member() straight
-- after a local confirm() dialog; a second, more elaborate "email
-- simulation" confirmation flow (requestDeletion/executeDeletion) exists in
-- App.jsx but is dead code — never wired to any onClick — so it provided no
-- actual protection either.
--
-- Fix applied at the RPC layer (protects every current and future call
-- site, not just one UI button): removing an ACTIVE PARENT now requires the
-- target's own confirmation, exactly like the existing confirmed-expense-
-- deletion (0022) and pension-end-request (0050) patterns. Removing an
-- observer, a child, or a parent who never actually joined (pending
-- invite) is unaffected — still immediate, as before; those aren't
-- symmetric relationships the same way two co-parents are.
--
-- À exécuter après 0052. Idempotent (IF NOT EXISTS / CREATE OR REPLACE).

alter table public.family_members
  add column if not exists pending_removal_by uuid,
  add column if not exists pending_removal_requested_at timestamptz;

-- ── remove_family_member() : demande de retrait au lieu de retrait immédiat
--    quand la cible est un parent déjà actif ────────────────────────────────
-- Le type de retour change (void → boolean : true si une DEMANDE a été
-- posée, false si le retrait a été immédiat) — DROP requis, CREATE OR
-- REPLACE seul ne permet pas de changer le type de retour d'une fonction
-- existante.

drop function if exists public.remove_family_member(uuid, uuid);

create function public.remove_family_member(p_family_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller        uuid := auth.uid();
  v_caller_joined timestamptz;
  v_target_joined timestamptz;
  v_target_role   text;
  v_target_status text;
  v_target_pending uuid;
begin
  if v_caller is null then raise exception 'not_authenticated'; end if;
  if v_caller = p_user_id then raise exception 'cannot_remove_self'; end if;

  -- L'appelant doit être membre ACTIF de la famille.
  if not exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = v_caller and status = 'active'
  ) then
    raise exception 'not_a_member';
  end if;

  -- La cible doit exister dans la famille.
  select joined_at, role, status, pending_removal_by
    into v_target_joined, v_target_role, v_target_status, v_target_pending
    from public.family_members
   where family_id = p_family_id and user_id = p_user_id;
  if not found then raise exception 'target_not_found'; end if;

  select joined_at into v_caller_joined
    from public.family_members
   where family_id = p_family_id and user_id = v_caller;

  -- Interdit de retirer quelqu'un arrivé avant ou en même temps que soi.
  if coalesce(v_target_joined, 'epoch'::timestamptz)
     <= coalesce(v_caller_joined, 'epoch'::timestamptz) then
    raise exception 'not_allowed';
  end if;

  if v_target_role = 'parent' and v_target_status = 'active' then
    if v_target_pending is not null then
      raise exception 'removal_already_requested';
    end if;
    update public.family_members
       set pending_removal_by = v_caller, pending_removal_requested_at = now()
     where family_id = p_family_id and user_id = p_user_id;
    return true;
  else
    update public.family_members
       set status = 'removed'
     where family_id = p_family_id and user_id = p_user_id;
    return false;
  end if;
end;
$$;

revoke all on function public.remove_family_member(uuid, uuid) from public;
grant execute on function public.remove_family_member(uuid, uuid) to authenticated;

-- ── RPC : le parent visé confirme son propre retrait ────────────────────────

create or replace function public.confirm_parent_removal(p_family_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller uuid := auth.uid();
  v_pending uuid;
begin
  if v_caller is null then raise exception 'not_authenticated'; end if;

  select pending_removal_by into v_pending
    from public.family_members
   where family_id = p_family_id and user_id = v_caller;
  if not found then raise exception 'not_a_member'; end if;
  if v_pending is null then raise exception 'no_pending_removal'; end if;

  update public.family_members
     set status = 'removed', pending_removal_by = null, pending_removal_requested_at = null
   where family_id = p_family_id and user_id = v_caller;
end;
$$;

-- ── RPC : annuler/refuser la demande (le demandeur qui retire sa demande,
--    ou le parent visé qui la refuse) ────────────────────────────────────────

create or replace function public.cancel_parent_removal(p_family_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller uuid := auth.uid();
  v_pending uuid;
begin
  if v_caller is null then raise exception 'not_authenticated'; end if;

  select pending_removal_by into v_pending
    from public.family_members
   where family_id = p_family_id and user_id = p_user_id;
  if not found then raise exception 'target_not_found'; end if;
  if v_pending is null then raise exception 'no_pending_removal'; end if;
  if v_caller <> p_user_id and v_caller <> v_pending then
    raise exception 'not_a_party_to_this_request';
  end if;

  update public.family_members
     set pending_removal_by = null, pending_removal_requested_at = null
   where family_id = p_family_id and user_id = p_user_id;
end;
$$;

revoke all on function public.confirm_parent_removal(uuid) from public;
grant execute on function public.confirm_parent_removal(uuid) to authenticated;
revoke all on function public.cancel_parent_removal(uuid, uuid) from public;
grant execute on function public.cancel_parent_removal(uuid, uuid) to authenticated;
