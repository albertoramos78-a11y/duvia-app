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
--
-- 🔧 Historique : la première version de ce script utilisait une table
-- temporaire (CREATE TEMPORARY TABLE) pour figer la liste des familles
-- "100% anonymes" avant suppression, en 2 requêtes séparées. En usage réel
-- (2026-07-12), ça a échoué : "relation does not exist" au moment de la
-- suppression — l'éditeur SQL Supabase n'exécute pas forcément deux
-- requêtes séparées sur la même connexion/session, donc la table
-- temporaire (qui n'existe que pour la session qui l'a créée) avait déjà
-- disparu. Réécrit en UNE SEULE requête via des CTE Postgres "modifiantes"
-- (WITH ... DELETE ... RETURNING) : chaque CTE ne touche qu'UNE table
-- (family_members / families / auth.users), pour éviter l'erreur Postgres
-- "tuple to be deleted was already modified" qui surviendrait si deux CTE
-- tentaient de supprimer la même ligne dans la même commande.

-- ── Aperçu (à lire avant de lancer la suppression) ──────────────────────────
select count(*) as comptes_anonymes from auth.users where is_anonymous = true;

select count(*) as familles_uniquement_anonymes from families f
  where exists (select 1 from family_members fm where fm.family_id = f.id)
  and not exists (
    select 1 from family_members fm
    join auth.users u on u.id = fm.user_id
    where fm.family_id = f.id and u.is_anonymous is not true
  );

-- ── Suppression (une seule requête, un seul aller-retour) ───────────────────
-- anon_only_families : familles dont TOUS les membres actuels sont anonymes
-- (au moins un membre, et aucun membre non-anonyme) — une famille déjà vide
-- pour une autre raison (ex: suppression de compte d'un utilisateur seul,
-- voir leaveAllFamiliesOnDelete dans App.jsx) n'a aucune ligne
-- family_members et n'apparaît donc jamais ici. Cette CTE est évaluée une
-- seule fois, sur l'état AVANT les suppressions ci-dessous (sémantique
-- standard des CTE Postgres : toutes les CTE d'une même requête partagent
-- le même instantané), donc son résultat n'est pas affecté par les DELETE
-- qui suivent dans la même commande.
with anon_only_families as (
  select f.id from families f
  where exists (select 1 from family_members fm where fm.family_id = f.id)
  and not exists (
    select 1 from family_members fm
    join auth.users u on u.id = fm.user_id
    where fm.family_id = f.id and u.is_anonymous is not true
  )
),
-- Toute adhésion (family_members) d'un compte anonyme — couvre à la fois le
-- cas normal (famille 100% anonyme) et le filet de sécurité (un compte
-- anonyme qui se serait retrouvé, par ailleurs, membre d'une famille
-- contenant aussi un vrai membre — la famille elle-même n'est pas touchée
-- dans ce cas, seule cette ligne d'adhésion l'est).
del_memberships as (
  delete from family_members
  where user_id in (select id from auth.users where is_anonymous = true)
  returning 1
),
-- Les familles elles-mêmes, identifiées par la CTE ci-dessus.
del_families as (
  delete from families
  where id in (select id from anon_only_families)
  returning 1
),
-- Les comptes anonymes eux-mêmes. Sûr même si Postgres exécute cette
-- suppression "en même temps" que del_memberships au sein de la même
-- commande : les contraintes de clé étrangère ne sont vérifiées qu'en fin
-- de commande, pas ligne par ligne, donc l'ordre interne n'a pas
-- d'importance ici.
del_users as (
  delete from auth.users where is_anonymous = true
  returning 1
)
select
  (select count(*) from del_memberships) as adhesions_supprimees,
  (select count(*) from del_families) as familles_supprimees,
  (select count(*) from del_users) as comptes_supprimes;
