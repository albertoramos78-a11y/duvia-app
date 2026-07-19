-- 0042_invite_email_log.sql
--
-- Anti-abus pour l'envoi réel d'emails d'invitation (feature "envoi
-- automatique réel d'emails d'invitation", voir docs/superpowers/specs/
-- 2026-07-19-real-invite-email-sending-design.md). Ne dépend d'aucune autre
-- migration.
--
-- Aucune policy RLS créée volontairement : ni lecture ni écriture pour un
-- client normal (authenticated/anon) — seule la Edge Function
-- send-invite-email (service role, qui bypass RLS) lit/écrit cette table.
-- C'est la table qui fait foi pour les plafonds anti-abus : 10 envois par
-- compte par 24h glissantes (tous types confondus), et 3 envois vers la
-- même adresse par 7 jours glissants (tous types confondus).
--
-- 🔧 recipient_email est TOUJOURS stocké en minuscules par la Edge Function
-- (invariant appliqué en code, pas par une contrainte SQL — un seul
-- écrivain possible : le client service-role de la fonction).

create table invite_email_log (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null,
  invite_type text not null check (invite_type in ('parent','observer','child','referral')),
  sent_at timestamptz not null default now()
);

create index idx_invite_email_log_sender_sent on invite_email_log(sender_user_id, sent_at);
create index idx_invite_email_log_recipient_sent on invite_email_log(recipient_email, sent_at);

alter table invite_email_log enable row level security;
