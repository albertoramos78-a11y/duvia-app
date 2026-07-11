-- 0033_cleanup_anonymous_families.sql
--
-- Nettoyage ponctuel des comptes/familles "anonymes" créés par l'ancien
-- mécanisme de "badge invisible" de useFamilySync (App.jsx), retiré dans la
-- même livraison (2026-07-11). Ces comptes ne sont jamais rejoints par un
-- vrai utilisateur — le mécanisme ne fait que créer sa propre famille,
-- jamais rejoindre une famille existante — donc sûrs à nettoyer.
--
-- À exécuter UNE SEULE FOIS, manuellement, dans l'éditeur SQL Supabase.
-- Ne dépend d'aucune autre migration. N'est appelé par aucun code de l'app.

-- ── Aperçu (à lire avant de lancer la suppression) ──────────────────────────
select count(*) as comptes_anonymes from auth.users where is_anonymous = true;

select count(*) as familles_uniquement_anonymes from families f
  where exists (select 1 from family_members fm where fm.family_id = f.id)
  and not exists (
    select 1 from family_members fm
    join auth.users u on u.id = fm.user_id
    where fm.family_id = f.id and u.is_anonymous is not true
  );

-- ── Suppression ──────────────────────────────────────────────────────────────
-- a) capturer D'ABORD les familles dont TOUS les membres actuels sont
-- anonymes (au moins un membre, et aucun membre non-anonyme) — une famille
-- déjà vide pour une autre raison (ex: suppression de compte d'un
-- utilisateur seul, voir leaveAllFamiliesOnDelete dans App.jsx) n'a aucune
-- ligne family_members et n'apparaît donc jamais ici.
create temporary table _anon_only_families as
select f.id from families f
  where exists (select 1 from family_members fm where fm.family_id = f.id)
  and not exists (
    select 1 from family_members fm
    join auth.users u on u.id = fm.user_id
    where fm.family_id = f.id and u.is_anonymous is not true
  );

-- b) supprimer les adhésions puis les familles ainsi identifiées
delete from family_members where family_id in (select id from _anon_only_families);
delete from families where id in (select id from _anon_only_families);

-- c) filet de sécurité : si un compte anonyme s'était par ailleurs
-- retrouvé membre d'une famille contenant AUSSI un vrai membre (le
-- mécanisme actuel ne crée jamais ce cas, mais coûte rien à couvrir), ne
-- retirer que sa ligne d'adhésion — la famille elle-même n'est pas touchée.
delete from family_members
  where user_id in (select id from auth.users where is_anonymous = true);

-- d) plus aucune ligne family_members ne peut référencer un compte
-- anonyme à ce stade → suppression sûre des comptes eux-mêmes
delete from auth.users where is_anonymous = true;

drop table _anon_only_families;
