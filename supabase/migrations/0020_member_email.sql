-- 0020_member_email.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Email réel de l'invité côté SERVEUR (fin du "je devine depuis l'invitation").
--
-- Problème corrigé : quand un invité rejoint avec une adresse DIFFÉRENTE de
-- celle tapée par le créateur dans le lien d'invitation (cas volontairement
-- testé : contournement d'email, connexion via bouton Google avec un autre
-- compte...), l'app n'avait aucune source fiable pour son VRAI email — elle
-- affichait celui de family_invitations.email (l'adresse invitée d'origine),
-- jamais celui du compte Supabase réellement utilisé pour se connecter.
-- Conséquence : le créneau invité affiche le mauvais email, et la correction
-- de parentIdx par email (App.jsx) ne peut jamais matcher le bon compte.
--
-- Solution : même pattern que 0015 (display_name) pour l'email — l'invité
-- enregistre sa vraie adresse sur SA ligne family_members au moment où il
-- rejoint, via set_member_identity, lue côté serveur depuis auth.users (pas
-- transmise par le client, donc infalsifiable).
--
-- À exécuter sur Supabase APRÈS 0019. Idempotent (réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Colonne email sur l'adhésion
alter table public.family_members add column if not exists email text;

-- 2) set_member_identity renseigne aussi l'email réel (lu depuis auth.users,
--    jamais depuis un paramètre client) en plus du nom/genre déjà gérés.
create or replace function public.set_member_identity(
  p_family_id   uuid,
  p_display_name text,
  p_gender      text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  update public.family_members
     set display_name = nullif(btrim(coalesce(p_display_name, '')), ''),
         gender       = coalesce(nullif(btrim(coalesce(p_gender, '')), ''), gender),
         email        = (select u.email from auth.users u where u.id = auth.uid())
   where family_id = p_family_id
     and user_id   = auth.uid();
end;
$$;

-- Permissions inchangées (déjà accordées en 0015, ré-appliquées par sécurité).
revoke all     on function public.set_member_identity(uuid, text, text) from public;
grant  execute on function public.set_member_identity(uuid, text, text) to authenticated;
