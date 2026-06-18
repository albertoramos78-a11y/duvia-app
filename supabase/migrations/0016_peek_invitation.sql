-- 0016_peek_invitation.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Aperçu d'une invitation AVANT connexion (pré-remplissage email + détection de
-- compte existant).
--
-- Problème corrigé : le lien d'invitation « nouveau format » ne contient qu'un
-- jeton opaque. L'email de l'invité reste côté serveur → la page d'invitation
-- ne pouvait ni pré-remplir l'email, ni savoir s'il faut afficher « Connexion »
-- (compte déjà existant) ou « Créer un compte ».
--
-- Solution : une fonction qui, à partir du jeton, renvoie l'email invité et un
-- booléen « ce compte existe déjà ? ». Lisible sans être connecté (anon), mais
-- protégée par la possession du jeton (secret, à usage unique, expirant).
--
-- À exécuter sur Supabase APRÈS 0015. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.peek_invitation(p_token text)
returns table(email text, has_account boolean)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text;
begin
  -- Retrouve l'invitation valide (non expirée, non utilisée) liée à ce jeton.
  select fi.email
    into v_email
  from public.family_invitations fi
  where fi.token::text = p_token
    and fi.used_by is null
    and (fi.expires_at is null or fi.expires_at > now())
  limit 1;

  -- Jeton inconnu / expiré / déjà utilisé : on ne renvoie rien (aucune fuite).
  if v_email is null then
    return;
  end if;

  return query
    select
      v_email,
      exists(select 1 from auth.users u where lower(u.email) = lower(v_email));
end;
$$;

-- Accessible sans authentification (l'invité n'a pas encore de session), mais la
-- sécurité repose sur le secret du jeton.
revoke all     on function public.peek_invitation(text) from public;
grant  execute on function public.peek_invitation(text) to anon, authenticated;
