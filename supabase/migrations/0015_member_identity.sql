-- 0015_member_identity.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Identité de l'invité côté SERVEUR (fin du nom provisoire dérivé de l'email).
--
-- Problème corrigé : dans le flux d'invitation par token, l'invité rejoint en
-- status='pending' et la RLS l'empêche d'écrire families.data.parents. La RPC de
-- validation ne fait que basculer le statut → l'inviteur n'avait aucune source
-- fiable pour le NOM de l'invité (il devinait à partir de l'email).
--
-- Solution propre : l'invité enregistre son vrai nom (et son genre) sur SA
-- ligne family_members au moment où il rejoint, via une RPC dédiée. L'inviteur
-- lit ensuite display_name tel quel à la validation.
--
-- À exécuter sur Supabase APRÈS 0014. Idempotent (réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Colonnes d'identité sur l'adhésion
alter table public.family_members add column if not exists display_name text;
alter table public.family_members add column if not exists gender       text;

-- 2) RPC : l'invité renseigne SON identité sur SA propre adhésion.
--    SECURITY DEFINER pour contourner la RLS qui masque les lignes 'pending',
--    mais strictement limité à la ligne de l'appelant (user_id = auth.uid()).
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
         gender       = coalesce(nullif(btrim(coalesce(p_gender, '')), ''), gender)
   where family_id = p_family_id
     and user_id   = auth.uid();
end;
$$;

-- 3) Permissions : réservé aux comptes authentifiés.
revoke all     on function public.set_member_identity(uuid, text, text) from public;
grant  execute on function public.set_member_identity(uuid, text, text) to authenticated;

-- Note RLS : aucune nouvelle policy nécessaire. La lecture de display_name/gender
-- des membres 'pending' par l'inviteur passe par la policy "select same-family"
-- déjà posée en 0012 (validate_family_member).
