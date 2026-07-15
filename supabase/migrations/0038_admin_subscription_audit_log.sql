-- 0038_admin_subscription_audit_log.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Journal des changements d'abonnement effectués par un admin via l'outil
-- "Gérer l'abonnement d'un compte" (admin-manage-subscriptions). Chaque
-- changement enregistre l'état COMPLET de la ligne subscriptions AVANT la
-- modification (previous_state, snapshot JSON), pour permettre un vrai
-- "annuler" plus tard — pas juste un historique en lecture seule.
--
-- Aucune policy RLS de lecture/écriture pour authenticated/anon : accessible
-- uniquement via la Edge Function (service role), même principe que app_config
-- (0037) — le client ne lit/écrit jamais cette table directement.
--
-- À exécuter sur Supabase après 0037. Idempotent (réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.admin_subscription_log (
  id             bigint generated always as identity primary key,
  admin_id       uuid not null,
  target_user_id uuid not null,
  previous_state jsonb,
  new_plan       text not null,
  changed_at     timestamptz not null default now()
);

alter table public.admin_subscription_log enable row level security;
