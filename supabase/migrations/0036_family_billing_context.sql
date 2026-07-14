-- 0036_family_billing_context.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- RPC utilisée par un observateur pour connaître, en une fois : (a) les
-- abonnements des parents de SA PROPRE famille (jamais d'une autre famille —
-- aucun paramètre n'est accepté, tout est dérivé de auth.uid()), et (b) son
-- propre rang parmi les observateurs actifs de cette famille. Le calcul du
-- plan effectif (fenêtre de trial, bêta, extensions de parrainage...) reste
-- entièrement côté client (subStatus()/getPerms() dans App.jsx) — cette RPC
-- ne fait que lever la restriction RLS pour livrer les données brutes
-- nécessaires, jamais celles d'une famille tierce.
--
-- Contexte : backlog 17d (limite d'observateurs pendant le Trial) n'était
-- jusqu'ici appliqué que côté écran de config du parent (v1.79-1.80) — un
-- observateur en trop gardait un accès complet s'il se connectait sur son
-- propre appareil. Cette RPC est le premier pas pour un vrai blocage côté
-- observateur (voir Task 2 pour le câblage client).
--
-- À exécuter sur Supabase APRÈS 0035. Idempotent (réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Défensif : `created_at` sur family_members. La table existe depuis avant
--    l'historique de migrations de ce repo (créée directement au tableau de
--    bord) — cette colonne existe presque certainement déjà (c'est la
--    convention par défaut de Supabase), mais on le garantit sans risque.
alter table public.family_members add column if not exists created_at timestamptz not null default now();

create or replace function public.get_family_billing_context()
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
  v_created_at  timestamptz;
  v_rank        int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select family_id, role, created_at into v_family_id, v_role, v_created_at
    from public.family_members
   where user_id = v_uid and status = 'active'
   limit 1;

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
     and created_at < v_created_at;

  return query
    select s.plan, s.premium_since, s.cycle, s.trial_start, s.trial_extension_days, s.account_created_at, v_rank
      from public.subscriptions s
      join public.family_members fm on fm.user_id = s.user_id
     where fm.family_id = v_family_id
       and fm.role = 'parent'
       and fm.status = 'active';
end;
$$;

-- Réservé aux comptes authentifiés (même pattern que set_member_identity, 0015).
revoke all     on function public.get_family_billing_context() from public;
grant  execute on function public.get_family_billing_context() to authenticated;
