-- 0036_family_billing_context.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- RPC utilisée par un observateur pour connaître, en une fois : (a) les
-- abonnements des parents de SA PROPRE famille (jamais d'une autre famille —
-- le paramètre optionnel p_family_id ne fait que désambiguïser entre les
-- appartenances DE L'APPELANT LUI-MÊME, tout reste filtré par auth.uid()), et
-- (b) son propre rang parmi les observateurs actifs de cette famille. Le
-- calcul du plan effectif (fenêtre de trial, bêta, extensions de
-- parrainage...) reste entièrement côté client (subStatus()/getPerms() dans
-- App.jsx) — cette RPC ne fait que lever la restriction RLS pour livrer les
-- données brutes nécessaires, jamais celles d'une famille tierce.
--
-- Contexte : backlog 17d (limite d'observateurs pendant le Trial) n'était
-- jusqu'ici appliqué que côté écran de config du parent (v1.79-1.80) — un
-- observateur en trop gardait un accès complet s'il se connectait sur son
-- propre appareil. Cette RPC est le premier pas pour un vrai blocage côté
-- observateur (voir Task 2 pour le câblage client).
--
-- Corrections post-revue (avant tout déploiement) : cette migration n'a
-- jamais été exécutée sur Supabase (confirmé dans task-1-report.md), elle a
-- donc été corrigée directement ici plutôt que via une nouvelle migration.
-- La revue de code du Task 1 a relevé 3 points importants, tous corrigés :
--   1) La requête finale faisait un `join` (inner) de `subscriptions` vers
--      `family_members` : un parent actif sans encore de ligne dans
--      `subscriptions` (upsert client-side avec 3s de debounce, voir
--      App.jsx:4031-4051) disparaissait silencieusement du résultat. On part
--      maintenant de `family_members` avec un `left join subscriptions`, pour
--      qu'un parent actif produise toujours exactement une ligne (champs
--      d'abonnement à NULL si absent).
--   2) `created_at` sur `family_members` n'est pas garanti pré-exister sur
--      cette table créée au tableau de bord ; un `add column ... default
--      now()` aurait horodaté toutes les lignes existantes de façon
--      identique, cassant silencieusement le calcul de rang pour toute
--      famille ayant déjà 2+ observateurs. On utilise donc `joined_at`, qui
--      existe déjà et contient déjà de vraies valeurs historiques (lu par
--      exemple dans App.jsx:2337/2368).
--   3) Le lookup initial de la famille active de l'appelant ne triait pas
--      (`limit 1` arbitraire) : un utilisateur avec plusieurs appartenances
--      actives simultanées pouvait tomber sur une famille où il n'est pas
--      observateur, et lever à tort `not_an_observer`. On ajoute un
--      paramètre optionnel `p_family_id` : quand il est fourni, il doit
--      correspondre exactement à l'appartenance active de l'appelant ; sinon
--      on garde le comportement `limit 1` d'aujourd'hui (pas pire que
--      l'existant ailleurs dans ce repo pour la même ambiguïté).
--
-- À exécuter sur Supabase APRÈS 0035. Idempotent (réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_family_billing_context(p_family_id uuid default null)
returns table (
  parent_plan                 text,
  parent_premium_since        timestamptz,
  parent_cycle                text,
  parent_trial_start          timestamptz,
  parent_trial_extension_days int,
  parent_account_created_at   timestamptz,
  my_observer_rank             int
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

  if v_role <> 'observer' then
    raise exception 'not_an_observer';
  end if;

  select count(*) into v_rank
    from public.family_members
   where family_id = v_family_id
     and role = 'observer'
     and status = 'active'
     and joined_at < v_joined_at;

  return query
    select s.plan, s.premium_since, s.cycle, s.trial_start, s.trial_extension_days, s.account_created_at, v_rank
      from public.family_members fm
      left join public.subscriptions s on s.user_id = fm.user_id
     where fm.family_id = v_family_id
       and fm.role = 'parent'
       and fm.status = 'active';
end;
$$;

-- Réservé aux comptes authentifiés (même pattern que set_member_identity, 0015).
revoke all     on function public.get_family_billing_context(uuid) from public;
grant  execute on function public.get_family_billing_context(uuid) to authenticated;
