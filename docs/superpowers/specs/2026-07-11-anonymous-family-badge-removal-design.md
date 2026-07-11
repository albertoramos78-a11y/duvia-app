# Suppression du compte "anonyme" de synchronisation famille — design

**Date :** 2026-07-11
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

`useFamilySync` (App.jsx:1537) crée aujourd'hui, dès l'ouverture de l'app **sans session existante**, un compte Supabase "anonyme" (`supabase.auth.signInAnonymously()`, App.jsx:1661) puis une famille vide pour ce compte (App.jsx:1785-1833). CLAUDE.md documente ce mécanisme comme un "badge invisible par appareil" pour la synchronisation famille avant qu'un utilisateur ait un vrai compte.

Quand l'utilisateur s'inscrit réellement (`doReg()` → `linkAccount()` → `supabase.auth.signUp()`, App.jsx:2099-2103), Supabase crée un **nouveau** compte (uid différent) et bascule la session dessus. `signUp()` ne convertit jamais le compte anonyme en place — c'est confirmé dans le code, il n'existe aucun mécanisme de "upgrade" d'identité anonyme ailleurs dans le repo (recherche exhaustive de `signInAnonymously`/`is_anonymous` : un seul point d'appel, celui-ci).

Or l'effet `useFamilySync` qui gère tout ça tourne dans un `useEffect(() => {...}, [])` — deps vides, une seule exécution par montage. Il ne se relance jamais quand la session bascule de l'anonyme vers le vrai compte. Résultat, selon le timing (course réelle, pas déterministe) : `familyId` peut rester bloqué sur la famille fantôme abandonnée pendant le reste du chargement, et le vrai compte — jamais membre de cette famille — voit ses écritures liées à la famille échouer (RLS 403, confirmé en direct sur `custody_special_dates`).

Recherche exhaustive (grep de tous les usages de `familySync.familyId`/`familySync.syncStatus`) : **aucun code ne lit la famille créée par le compte anonyme avant une vraie connexion.** `LoginScreen` ne lit ni `cfg` ni `familySync`. Le mécanisme ne sert donc aujourd'hui absolument rien — c'est du travail et un risque pour zéro bénéfice.

## Ce qui a déjà été essayé et écarté

Un correctif tenté le même jour (commit `a89a8bd`, v1.55) ajoutait un second effet qui écoutait `onAuthStateChange` et forçait un `duviaReload()` dès qu'un uid différent apparaissait après le premier vu. Reverté (`49c191e`, v1.56) : il interrompait le flux `doReg()` en cours (rechargement avant que l'inscription n'ait fini son travail local) et provoquait une nouvelle collision `families_share_code_key` (409). Le design ci-dessous n'introduit ni détection de changement d'identité, ni rechargement — il supprime simplement la cause à la racine.

## Design retenu : ne plus créer de compte/famille anonyme

**Principe :** tant qu'il n'y a pas de vraie session, `useFamilySync` ne fait rien. Pas de compte anonyme, pas de famille. `familyId` reste `null`.

### Partie 1 — code (`App.jsx`, dans `useFamilySync`)

Le bloc actuel (App.jsx:1658-1663) :

```js
// 1. S'assurer d'avoir une session (compte anonyme automatique)
const { data: sessData } = await supabase.auth.getSession();
if (!sessData?.session) {
  const { error: signErr } = await supabase.auth.signInAnonymously();
  if (signErr) throw signErr;
}
const { data: userData } = await supabase.auth.getUser();
const uid = userData?.user?.id;
if (!uid) throw new Error("no-uid");
```

devient :

```js
// 1. Sans session réelle, rien à synchroniser — on ne crée plus de compte
// anonyme ici (2026-07-11, backlog item 15) : rien dans l'app ne lit une
// famille avant une vraie connexion/inscription, et créer un compte
// jetable était la cause d'un bug réel (familyId resté accroché à cette
// famille fantôme après le passage au vrai compte). Une vraie
// connexion/inscription redémarre cet effet proprement (nouveau montage
// après duviaReload()/reload de session) et retombe alors dans la branche
// ci-dessous avec un vrai uid.
const { data: sessData } = await supabase.auth.getSession();
if (!sessData?.session) {
  if (!cancelled) setSyncStatus("synced");
  return;
}
const { data: userData } = await supabase.auth.getUser();
const uid = userData?.user?.id;
if (!uid) throw new Error("no-uid");
```

Rien d'autre dans `useFamilySync` ne change : la branche de création de famille pour un **vrai** compte (App.jsx:1785-1833, corrigée et validée ce matin en v1.54) reste identique et continue de s'exécuter normalement une fois qu'un vrai uid existe.

Pourquoi `setSyncStatus("synced")` plutôt que laisser `"connecting"` : par cohérence avec les autres branches "rien à faire, ce n'est pas une erreur" du même effet (`hasPendingOnly`, `wasRemovedObserver`, App.jsx:1721/1727). Sans conséquence visible : `FamilySyncCard` (seul consommateur de `syncStatus`) n'est rendue qu'après connexion, et l'écran de connexion (`LoginScreen`) s'affiche tant que `!user` (App.jsx:4340), avant tout code qui lirait `syncStatus`.

### Partie 2 — nettoyage des données existantes

Les comptes/familles anonymes déjà créés avant ce correctif sont inertes (jamais rejoints par un vrai utilisateur — le mécanisme ne fait que créer sa propre famille, jamais rejoindre une famille existante) mais encombrent la base. Nettoyage dans une nouvelle migration `supabase/migrations/0033_cleanup_anonymous_families.sql`.

**Point de vigilance identifié en concevant ce script :** une famille peut légitimement se retrouver avec **zéro** ligne `family_members`, sans rapport avec le compte anonyme — cas réel déjà présent dans le code (`leaveAllFamiliesOnDelete`, App.jsx:4185-4212) : un utilisateur seul (jamais rejoint par un co-parent) qui supprime son compte fait disparaître sa propre ligne `family_members`, laissant sa famille à zéro membre. Un script naïf du type "supprimer toute famille sans aucun membre" supprimerait donc aussi ces familles réelles, sans rapport avec le bug. Le script ci-dessous évite ce piège en capturant D'ABORD, avant toute suppression, l'ensemble des familles dont **tous les membres actuels sont exclusivement anonymes** — une famille déjà vide pour une autre raison n'entre jamais dans cet ensemble.

1. Aperçu (SELECT, à faire tourner et lire d'abord) :
```sql
select count(*) as comptes_anonymes from auth.users where is_anonymous = true;

select count(*) as familles_uniquement_anonymes from families f
  where exists (select 1 from family_members fm where fm.family_id = f.id)
  and not exists (
    select 1 from family_members fm
    join auth.users u on u.id = fm.user_id
    where fm.family_id = f.id and u.is_anonymous is not true
  );
```

2. Suppression :
```sql
-- a) capturer D'ABORD les familles dont TOUS les membres actuels sont
-- anonymes (au moins un membre, et aucun membre non-anonyme) — une famille
-- déjà vide pour une autre raison (ex: suppression de compte d'un
-- utilisateur seul) n'a aucune ligne family_members et n'apparaît donc
-- jamais ici.
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
```

Ce script est à coller et exécuter une fois dans l'éditeur SQL Supabase (comme les migrations précédentes de cette session), après le déploiement du correctif de code — pas besoin de le refaire ensuite, `signInAnonymously()` ne sera plus jamais appelé.

## Non-objectifs

- Ne touche pas à la création de famille pour un vrai compte (déjà correcte, v1.54).
- N'introduit aucune détection de changement d'identité ni rechargement automatique (approche déjà tentée et écartée).
- Ne modifie aucune policy RLS.

## Test / vérification

- `TZ=Europe/Paris npm test` doit rester vert (122 tests) — ce changement ne touche à aucune fonction pure de `src/utils/core.js`, aucun nouveau test attendu.
- Vérification live après déploiement : inscription d'un nouveau compte parent de bout en bout, plus de 403 sur `custody_special_dates` ni de 409 sur `families`/`family_members` dans la console.
- Bump `APP_VERSION` (src/config.js) et `SW_VERSION` (public/sw.js) ensemble, comme à chaque déploiement.
