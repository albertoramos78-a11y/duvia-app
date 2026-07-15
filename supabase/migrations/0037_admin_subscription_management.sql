-- 0037_admin_subscription_management.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Deux ajouts pour la gestion admin des abonnements :
--
-- 1) app_config : table singleton (une seule ligne, id=1) portant la bascule
--    bêta GLOBALE (remplace la constante BETA_END codée en dur dans App.jsx).
--    Lisible par tout compte authentifié (chaque page load doit savoir si la
--    bêta globale est active, sans passer par une Edge Function) ; aucune
--    policy d'écriture directe — seule la Edge Function admin-manage-
--    subscriptions (service role) peut la modifier.
--
-- 2) subscriptions.beta_end : date de fin d'un override "Bêta" PAR COMPTE
--    (distinct de la bascule globale ci-dessus), posé par un admin via le
--    même outil. Nullable, pertinent uniquement quand subscriptions.plan =
--    'beta'.
--
-- ⚠️ À exécuter sur Supabase AVANT 0036 (pas après) : 0036 a été modifié après
-- coup pour lire subscriptions.beta_end, la colonne créée ici. Idempotent
-- (réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  id           int primary key default 1,
  beta_enabled boolean not null default false,
  beta_end     timestamptz,
  constraint app_config_singleton check (id = 1)
);
insert into public.app_config (id) values (1) on conflict (id) do nothing;

alter table public.app_config enable row level security;
drop policy if exists "app_config_select_authenticated" on public.app_config;
create policy "app_config_select_authenticated" on public.app_config
  for select to authenticated using (true);

alter table public.subscriptions add column if not exists beta_end timestamptz;
