-- 0044_ai_features_foundation.sql
--
-- Infrastructure partagée pour les fonctionnalités IA (Premium+IA), en
-- commençant par la reformulation de message. Voir docs/superpowers/specs/
-- 2026-07-19-ai-message-rephrasing-design.md.
--
-- ai_enabled : interrupteur booléen par compte, complètement déconnecté de
-- l'échelle Freemium/Trial/Premium (aucun vrai palier "Premium+IA" vendable
-- n'existe encore, la vraie facturation Stripe est bloquée sur le SIRET) —
-- activé/désactivé uniquement depuis le panneau admin (admin-manage-
-- subscriptions), jamais par le client lui-même.
--
-- 🔒 Verrouillée au niveau colonne, même mécanisme que 0041_lock_
-- subscriptions_paid_columns.sql pour plan/premium_since/cycle : les
-- policies RLS de `subscriptions` ne restreignent QUE la ligne (la sienne),
-- pas les valeurs — et le client a déjà le droit d'upserter sa propre ligne
-- (effet "Sync sub → table subscriptions", App.jsx). Sans ce REVOKE,
-- n'importe quel compte authentifié pourrait s'auto-accorder l'accès IA en
-- appelant directement l'API REST avec son propre jeton
-- (supabase.from("subscriptions").upsert({ai_enabled:true})), même si
-- l'app elle-même n'envoie jamais ce champ. Les fonctions SECURITY DEFINER
-- (dont l'Edge Function service-role) ne sont pas affectées : le
-- propriétaire de la table garde toujours tous les privilèges sur ses
-- propres colonnes.
alter table public.subscriptions add column if not exists ai_enabled boolean not null default false;
revoke update (ai_enabled) on public.subscriptions from public;
revoke insert (ai_enabled) on public.subscriptions from public;

-- ai_usage_log : partagée par les 4 futures fonctionnalités IA (reformulation
-- de message aujourd'hui, dépenses/calendrier/météo plus tard), chacune son
-- propre `feature`. Ne stocke JAMAIS le contenu envoyé/reçu à l'IA, seulement
-- l'usage (horodatage) pour le plafond anti-abus.
--
-- 🔧 Contrairement à invite_email_log (migrations 0042/0043), le plafond ici
-- est vérifié par un simple SELECT count() côté Edge Function, SANS RPC
-- atomique — accepté car cette fonctionnalité reste réservée aux comptes
-- activés par l'admin (risque d'abus bien plus faible qu'une fonctionnalité
-- ouverte à tous les utilisateurs authentifiés). À migrer vers le même schéma
-- atomique que check_and_log_invite_email si ai_enabled devient un vrai
-- palier vendable ouvert à tous.
create table if not exists public.ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null check (feature in ('rephrase_message')),
  used_at timestamptz not null default now()
);
create index if not exists idx_ai_usage_log_user_feature_used on public.ai_usage_log(user_id, feature, used_at);

alter table public.ai_usage_log enable row level security;
