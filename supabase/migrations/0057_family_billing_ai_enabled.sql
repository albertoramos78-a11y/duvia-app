-- 0057_family_billing_ai_enabled.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Bug (rapporté 2026-07-27) : quand un parent a Premium+IA et l'autre hérite du
-- plan familial, l'héritier voyait "Premium hérité" (sans IA) au lieu de
-- "Premium+IA hérité" — et pire, perdait carrément l'ACCÈS aux fonctionnalités
-- IA (bulle assistant, reformulation de message), pas seulement le libellé.
--
-- Root cause : get_family_billing_context() (0036, étendue par 0039) ne
-- renvoyait jamais ai_enabled, donc ni le client (bestParentSub() dans
-- App.jsx) ni les Edge Functions ai-chatbot/ai-rephrase-message (qui
-- revérifient ai_enabled côté serveur) ne pouvaient savoir que le MEILLEUR
-- statut IA de la famille devait s'appliquer à tout le monde — exactement la
-- même règle "toujours le plus haut" déjà en place pour le plan Premium de
-- base depuis 0039.
--
-- Fix : ajoute la colonne parent_ai_enabled (ai_enabled de chaque parent actif,
-- même filtre que les autres colonnes). Le calcul "vrai si N'IMPORTE LEQUEL des
-- parents l'a" reste côté appelant (bestParentSub() côté client, .some() côté
-- Edge Functions) — cette fonction reste une simple projection des lignes
-- brutes, comme avant.
--
-- Même contrainte que 0039 : PostgreSQL n'autorise aucun changement de la
-- liste de colonnes d'un `returns table` existant via CREATE OR REPLACE — DROP
-- puis CREATE, protégé par une transaction pour qu'aucune session concurrente
-- ne voie la fonction "manquante" entre les deux.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

drop function if exists public.get_family_billing_context(uuid);

create or replace function public.get_family_billing_context(p_family_id uuid default null)
returns table (
  parent_plan                 text,
  parent_premium_since        timestamptz,
  parent_cycle                text,
  parent_trial_start          timestamptz,
  parent_trial_extension_days int,
  parent_account_created_at   timestamptz,
  parent_beta_end              timestamptz,
  my_observer_rank             int,
  parent_user_id               uuid,
  parent_ai_enabled            boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_family_id   uuid;
  v_role        text;
  v_joined_at   timestamptz;
  v_rank        int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if p_family_id is not null then
    select family_id, role, joined_at into v_family_id, v_role, v_joined_at
      from public.family_members
     where user_id = v_uid and status = 'active' and family_id = p_family_id
     limit 1;
  else
    select family_id, role, joined_at into v_family_id, v_role, v_joined_at
      from public.family_members
     where user_id = v_uid and status = 'active'
     limit 1;
  end if;

  if v_family_id is null then
    raise exception 'no_family';
  end if;

  if v_role = 'observer' then
    select count(*) into v_rank
      from public.family_members
     where family_id = v_family_id
       and role = 'observer'
       and status = 'active'
       and joined_at < v_joined_at;
  else
    v_rank := 0;
  end if;

  return query
    select
      s.plan, s.premium_since, s.cycle, s.trial_start, s.trial_extension_days,
      s.account_created_at, s.beta_end,
      v_rank,
      case when v_role = 'parent' then fm.user_id else null end,
      coalesce(s.ai_enabled, false)
      from public.family_members fm
      left join public.subscriptions s on s.user_id = fm.user_id
     where fm.family_id = v_family_id
       and fm.role = 'parent'
       and fm.status = 'active';
end;
$$;

revoke all     on function public.get_family_billing_context(uuid) from public;
grant  execute on function public.get_family_billing_context(uuid) to authenticated;

commit;
