# Attribution légale des dépenses & remboursements — Design

## Contexte et problème

`expenses.created_by` / `expenses.paid_by` et `reimbursements.from_parent` / `reimbursements.to_parent` sont des **index de position** (0 ou 1) dans `cfg.parents`, pas des identifiants de compte. Un créneau de position (0 = "créneau créateur", 1 = "créneau invité") peut être **recyclé** : quand un parent quitte puis qu'un nouveau parent est invité, l'app réutilise le même index (`confirmInvite`, App.jsx) pour ne jamais dépasser 2 parents. Résultat observé en production : après le départ de Toti (index 0) et la fermeture de sa carte "parti", Sissi (ex-invitée) a glissé à l'index 0 — toutes les dépenses `created_by: 0` de Toti s'affichent maintenant comme créées par Sissi.

Ce bug de ré-indexation (le bouton "×" qui fait un `.filter()` au lieu de vider le créneau en place) sera corrigé séparément (voir conversation — fix ciblé, pas dans ce chantier). Mais même une fois corrigé, le modèle "attribution = index de position" reste **fondamentalement incompatible** avec une preuve légale : le recyclage de créneau est une fonctionnalité voulue de l'app (limite à 2 parents), donc un même index désignera légitimement des personnes différentes au fil du temps.

## Exigence

Quand un parent quitte la famille, les dépenses/remboursements qu'il a créés ou payés doivent continuer à afficher **son vrai nom**, suivi de **"(parti)"**, indéfiniment — même si son ancien créneau de position est ensuite réutilisé par quelqu'un d'autre.

## Décisions de conception

### 1. Deux colonnes par acteur, ajoutées (pas remplacées)

Pour `expenses` : `created_by_user_id` (uuid), `created_by_name` (text snapshot), `paid_by_user_id` (uuid), `paid_by_name` (text snapshot).
Pour `reimbursements` : `from_user_id`/`from_name`, `to_user_id`/`to_name`.

Les colonnes existantes (`created_by`, `paid_by`, `from_parent`, `to_parent` — les index 0/1) sont **conservées inchangées**. Elles servent à un besoin différent : calculer le solde courant entre "les 2 parents actuels de la famille" (totaux, répartition %) — une notion positionnelle, pas identitaire, qui doit continuer à fonctionner telle quelle.

### 2. Nom capturé en instantané, pas résolu en direct

`created_by_name`/`paid_by_name` (etc.) sont écrits **une fois, à la création** de la dépense/remboursement, et ne changent plus jamais — même si la personne renomme son profil plus tard, même si son créneau est recyclé. C'est le choix qui rend l'affichage résistant au recyclage de créneau : on n'a pas besoin de retrouver la personne dans `cfg.parents` pour connaître son nom.

`created_by_user_id`/`paid_by_user_id` sont eux aussi figés à la création, et servent uniquement à déterminer si la personne a quitté la famille (point 3) — pas à retrouver son nom.

### 3. Détection "(parti)" via `family_members`, pas via `cfg.parents`

`family_members` a une ligne permanente par personne ayant un jour rejoint la famille (`user_id` + `status`), qui devient `'removed'` via la RPC `leave_family` — cette ligne n'est **jamais recyclée**, contrairement à un index de `cfg.parents`. C'est la source fiable pour savoir "cette personne a-t-elle quitté ?", indépendamment de qui occupe son ancien créneau aujourd'hui.

Le hook `useCustody`/l'effet de réconciliation (App.jsx, ~ligne 1722) fait déjà `select("user_id,status")` sur `family_members` pour marquer les parents partis dans `cfg.parents`. Ce chantier **réexpose ce même ensemble** (`removedUserIds: Set<string>`) via le contexte `useApp()`, pour que l'affichage des dépenses puisse faire `removedUserIds.has(expense.createdByUserId)` sans requête supplémentaire.

### 4. Données existantes : pas de backfill

Les dépenses/remboursements déjà créés avant ce chantier gardent `created_by_user_id`/`created_by_name` à `NULL`. On ne tente pas de deviner rétroactivement qui occupait quel créneau à l'époque (l'info fiable n'existe plus, et une supposition fausse serait pire qu'une case vide). L'affichage retombe sur le comportement actuel (résolution par index) pour ces lignes anciennes — inchangé, donc pas de régression, juste pas de correction rétroactive.

### 5. Où les nouveaux champs sont renseignés

À la création (App.jsx, les call sites qui construisent un objet `Expense`/`Reimbursement`) :
- `created_by_user_id`/`created_by_name` ← `user.id`/`user.name` (toujours l'utilisateur connecté qui crée l'entrée)
- `paid_by_user_id`/`paid_by_name` ← `cfg.parents[paidByIdx]?.userId` / `?.name` (le parent sélectionné comme payeur, peut être l'autre parent)
- Idem pour `from`/`to` des remboursements.

Si `cfg.parents[paidByIdx]` n'a pas encore de `userId` (invitation pas encore acceptée), les nouveaux champs restent `NULL` pour cette entrée — cas limite accepté, l'affichage retombe sur le nom de créneau actuel comme aujourd'hui.

## Portée de ce chantier

Inclus : `expenses`, `reimbursements` (services, hook, types, tous les points d'affichage dans App.jsx qui lisent `e.createdBy`/`e.paidBy`/`r.from`/`r.to`).

Explicitement **hors périmètre** (chantier séparé, plus tard) : garde/planning, dates spéciales, config famille (photo/tel/rôle/couleur) — ces domaines n'ont aujourd'hui **aucune** traçabilité "qui a fait quoi" (toujours dans le blob JSON `families.data`, jamais extraits en table dédiée). Y ajouter une preuve légale est une fonctionnalité neuve, pas un correctif, et mérite son propre design.

## Fichiers concernés

- `supabase/migrations/0021_expense_identity.sql` (nouveau) — 8 colonnes, pas de backfill.
- `src/services/supabase/expenseService.ts` — types `Expense`/`Reimbursement`, `dbToExpense`/`expenseToDb`, `dbToReimbursement`/`reimbursementToDb`.
- `src/hooks/useExpenses.ts` — vérifier si des adaptations sont nécessaires (probablement non, passe les objets tels quels).
- `src/App.jsx` — call sites de création (~lignes 11142-11168 et création de remboursements), tous les points d'affichage nom/couleur (~4052-4062, 11365, 11619-11623, 12222-12276), exposer `removedUserIds` via le contexte `useApp()`.
- `src/utils/core.js` — petit helper pur et testé pour formater "Nom" vs "Nom (parti)".

## Ce que ce chantier NE fait PAS

- Ne corrige pas le bug de ré-indexation du bouton "×" (fix séparé, déjà scopé dans la conversation).
- Ne répare pas rétroactivement la famille Toti/Sissi déjà corrompue (l'info d'origine est perdue ; possible piste manuelle via les entrées `history` qui ont un vrai `user_id`, à explorer séparément si besoin, hors de ce chantier).
- Ne touche pas à la garde, aux dates spéciales, ni à la config famille.
