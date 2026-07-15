-- 0040_referral_system_fix.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Rend le parrainage fonctionnel entre deux vrais comptes sur deux appareils
-- différents. Jusqu'ici, la vérification du code parrain à l'inscription et
-- le crédit du bonus au parrain passaient tous les deux par un tableau
-- localStorage propre à l'appareil (`users`, App.jsx) — jamais synchronisé
-- avec Supabase, donc jamais fonctionnel pour deux personnes réelles sur deux
-- appareils. Voir docs/superpowers/specs/2026-07-15-referral-system-fix-design.md.
--
-- La table subscriptions a déjà en production toutes les colonnes
-- nécessaires (ref_code, ref_used, ref_count, validated_ref_count,
-- ref_months, pending_spins, monthly_ref_month, monthly_ref_count) —
-- confirmé via information_schema.columns, jamais capturées dans une
-- migration de ce dépôt (même situation que la table elle-même). Seule
-- ref_validated manque, ajoutée ci-dessous.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.subscriptions add column if not exists ref_validated boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────────────
-- consume_referral_code : vérifie qu'un code parrain correspond à un vrai
-- compte actif, incrémente son ref_count côté serveur. Appelée PENDANT le
-- flux d'inscription (App.jsx, doReg()) — l'état de la session Supabase Auth
-- de l'appelant à cet instant précis n'est pas garanti, donc cette fonction
-- n'utilise JAMAIS auth.uid() et est accordée à anon ET authenticated. Aucune
-- donnée sensible n'est exposée : juste valide/invalide + l'id du parrain,
-- qui ne fuite rien de plus qu'un identifiant déjà destiné à être partagé
-- publiquement par le parrain lui-même (c'est un code de parrainage).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.consume_referral_code(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_referrer_id uuid;
begin
  if v_code = '' then
    return json_build_object('valid', false);
  end if;

  select s.user_id into v_referrer_id
    from public.subscriptions s
    join auth.users u on u.id = s.user_id
   where s.ref_code = v_code
   limit 1;

  if v_referrer_id is null then
    return json_build_object('valid', false);
  end if;

  update public.subscriptions
     set ref_count = coalesce(ref_count, 0) + 1
   where user_id = v_referrer_id;

  return json_build_object('valid', true, 'referrer_id', v_referrer_id);
end;
$$;

revoke all     on function public.consume_referral_code(text) from public;
grant  execute on function public.consume_referral_code(text) to anon;
grant  execute on function public.consume_referral_code(text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- credit_referral_validation : appelée par le FILLEUL une fois son score
-- d'engagement local (App.jsx, refActions) au-dessus du seuil. Recrédite le
-- parrain ET marque le filleul comme validé, en une transaction. Le calcul du
-- bonus est réimplémenté ici (pas transmis par le client) : c'est une
-- exception délibérée au principe de ce projet de ne pas dupliquer la
-- logique métier en SQL — ici la duplication protège contre un client qui
-- s'auto-attribuerait n'importe quel bonus pour un autre compte.
-- Constantes reprises telles quelles de App.jsx : TRIAL_BASE_DAYS=15,
-- TRIAL_MAX_DAYS=30, paliers Trial {1:5, 2:10, 3+:0}, PREM_BONUS_PER_REF=1,
-- PREM_MAX_PER_MONTH=5, SPIN_PER_REF=1.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.credit_referral_validation()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid                 uuid := auth.uid();
  v_referee              record;
  v_referrer             record;
  v_referrer_is_premium  boolean;
  v_referrer_days_elapsed numeric;
  v_referrer_max_days    numeric;
  v_referrer_is_freemium boolean := false;
  v_new_validated_count  int;
  v_bonus_days           int := 0;
  v_new_monthly_month    text;
  v_new_monthly_count    int;
  v_this_month           text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_referee from public.subscriptions where user_id = v_uid;
  if v_referee is null or v_referee.ref_used is null then
    raise exception 'no_referral_to_credit';
  end if;
  if v_referee.ref_validated then
    raise exception 'already_validated';
  end if;

  select * into v_referrer from public.subscriptions where ref_code = v_referee.ref_used;
  if v_referrer is null then
    raise exception 'referrer_not_found';
  end if;

  -- Le parrain est-il Premium payant, encore actif (même fenêtre que
  -- subStatus() côté client : premium_since + cycle, pas expiré) ?
  v_referrer_is_premium := v_referrer.plan = 'premium' and (
    v_referrer.premium_since is null or v_referrer.cycle is null or
    (case when v_referrer.cycle = 'yearly'
       then v_referrer.premium_since + interval '1 year'
       else v_referrer.premium_since + interval '1 month'
     end) > now()
  );

  v_new_validated_count := coalesce(v_referrer.validated_ref_count, 0) + 1;

  if v_referrer_is_premium then
    -- Phase Premium abonné : +1j par filleul validé, plafond 5/mois, reset mensuel.
    v_this_month := to_char(now(), 'YYYY-MM');
    v_new_monthly_count := (case when v_referrer.monthly_ref_month = v_this_month
                               then coalesce(v_referrer.monthly_ref_count, 0) else 0 end) + 1;
    v_new_monthly_month := v_this_month;
    v_bonus_days := case when v_new_monthly_count <= 5 then 1 else 0 end;
  else
    v_new_monthly_month := v_referrer.monthly_ref_month;
    v_new_monthly_count := v_referrer.monthly_ref_count;
    -- Le parrain est-il encore dans sa fenêtre Trial (pas Freemium) ?
    v_referrer_days_elapsed := extract(epoch from (now() - coalesce(v_referrer.account_created_at, v_referrer.trial_start))) / 86400.0;
    v_referrer_max_days := least(15 + coalesce(v_referrer.trial_extension_days, 0), 30);
    v_referrer_is_freemium := v_referrer_days_elapsed > v_referrer_max_days;
    if v_referrer_is_freemium then
      v_bonus_days := 0;
    else
      v_bonus_days := case v_new_validated_count when 1 then 5 when 2 then 10 else 0 end;
    end if;
  end if;

  -- Marque le filleul comme validé de façon ATOMIQUE, AVANT de créditer le
  -- parrain — la clause WHERE ref_validated=false est réévaluée par Postgres
  -- contre l'état réellement committé au moment du UPDATE (pas au moment du
  -- SELECT plus haut), donc deux appels concurrents pour le même filleul ne
  -- peuvent jamais tous les deux passer : le second bloque sur le verrou de
  -- ligne du premier, puis échoue silencieusement (0 ligne affectée) une
  -- fois le premier committé. En créditant le parrain SEULEMENT après que ce
  -- UPDATE ait réellement affecté une ligne, un double appel simultané ne
  -- peut jamais créditer le parrain deux fois.
  update public.subscriptions
     set ref_validated = true
   where user_id = v_uid and ref_validated = false;

  if not found then
    raise exception 'already_validated';
  end if;

  update public.subscriptions
     set validated_ref_count = v_new_validated_count,
         trial_extension_days = coalesce(trial_extension_days, 0) + v_bonus_days,
         pending_spins = coalesce(pending_spins, 0) + 1,
         -- 🔧 Reprend exactement la garde de l'ancien code client
         -- (shouldUpgrade = !parrainIsPrem && !parrainIsFreemium && ...) :
         -- un parrain freemium (trial expiré) n'est PAS promu earned_premium,
         -- et un parrain en "beta" (palier spécial par compte, sa propre
         -- logique dans subStatus()) n'est jamais écrasé non plus.
         plan = case when not v_referrer_is_premium and not v_referrer_is_freemium
                       and v_new_validated_count >= 1
                       and plan not in ('premium','earned_premium','beta') then 'earned_premium' else plan end,
         monthly_ref_month = v_new_monthly_month,
         monthly_ref_count = v_new_monthly_count
   where user_id = v_referrer.user_id;

  update public.subscriptions
     set plan = case when plan not in ('premium') then 'earned_premium' else plan end
   where user_id = v_uid;

  return json_build_object('ok', true);
end;
$$;

revoke all     on function public.credit_referral_validation() from public;
grant  execute on function public.credit_referral_validation() to authenticated;
