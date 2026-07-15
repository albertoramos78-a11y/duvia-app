-- 0039_family_wide_effective_plan.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Étend get_family_billing_context() (0036, déjà déployée) : jusqu'ici réservée
-- à un observateur qui vérifie son propre quota, elle devient appelable par
-- TOUT membre actif d'une famille (parent/enfant/observateur) pour connaître le
-- statut effectif de sa famille = le meilleur des deux plans parents, pas
-- seulement son propre plan individuel. Voir
-- docs/superpowers/specs/2026-07-15-family-wide-premium-sharing-design.md.
--
-- create or replace function est idempotent, mais PostgreSQL n'autorise à
-- changer la liste de colonnes d'un `returns table` existant que par un AJOUT
-- EN FIN DE LISTE — jamais une insertion au milieu (ça échoue avec "cannot
-- change return type of existing function"). parent_user_id est donc ajouté
-- APRÈS my_observer_rank (dernière colonne de la version déployée par 0036),
-- pas avant : aucun impact côté client, qui lit les champs par nom
-- (r.parent_user_id), jamais par position. Aucune table modifiée, aucune
-- donnée migrée.
--
-- Sécurité : ajoute parent_user_id aux lignes retournées, mais UNIQUEMENT
-- rempli si l'appelant est lui-même un parent actif de cette famille (vérifié
-- côté serveur via v_role, jamais falsifiable par le client) — un enfant ou un
-- observateur qui interroge cette fonction pour son propre statut ne reçoit
-- jamais l'identité d'un parent. Pas de champ email ici (voir
-- get_coparent_email ci-dessous, restreint aux seuls appelants parents).
-- ─────────────────────────────────────────────────────────────────────────────

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
  parent_user_id               uuid
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

  -- 🔧 La restriction "observateur uniquement" est retirée ici (0036 la posait
  -- via `raise exception 'not_an_observer'`) : tout rôle actif peut désormais
  -- appeler cette fonction pour SA PROPRE famille. my_observer_rank reste
  -- calculé uniquement pour un appelant observateur (0 sinon, inoffensif —
  -- seul familyMaxObservers() côté client en a l'usage, et seulement pour un
  -- observateur).
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
      case when v_role = 'parent' then fm.user_id else null end
      from public.family_members fm
      left join public.subscriptions s on s.user_id = fm.user_id
     where fm.family_id = v_family_id
       and fm.role = 'parent'
       and fm.status = 'active';
end;
$$;

revoke all     on function public.get_family_billing_context(uuid) from public;
grant  execute on function public.get_family_billing_context(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_coparent_email : résout l'email d'un co-parent pour l'affichage du
-- bandeau "Premium via votre famille" (PremiumTab). Restreinte aux appelants
-- eux-mêmes parents actifs, et à une cible elle-même parent actif de LA MÊME
-- famille que l'appelant — même pattern de vérification que
-- set_member_identity (0020_member_email.sql).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_coparent_email(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_family_id   uuid;
  v_target_role text;
  v_email       text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_user_id is null then
    raise exception 'missing_user_id';
  end if;

  select family_id into v_family_id
    from public.family_members
   where user_id = v_uid and status = 'active' and role = 'parent'
   limit 1;

  if v_family_id is null then
    raise exception 'not_a_parent';
  end if;

  select role into v_target_role
    from public.family_members
   where user_id = p_user_id and status = 'active' and family_id = v_family_id
   limit 1;

  if v_target_role is null or v_target_role <> 'parent' then
    raise exception 'not_a_coparent';
  end if;

  select email into v_email from auth.users where id = p_user_id;
  return v_email;
end;
$$;

revoke all     on function public.get_coparent_email(uuid) from public;
grant  execute on function public.get_coparent_email(uuid) to authenticated;
