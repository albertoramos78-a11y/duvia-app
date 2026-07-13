# Journaliser un départ causé par une suppression de compte — design

**Date :** 2026-07-13
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Le spec précédent ([2026-07-13-family-membership-history-design.md](2026-07-13-family-membership-history-design.md)) a journalisé les arrivées, départs volontaires et retraits dans l'Historique — mais a explicitement laissé de côté un cas : quand un membre supprime son propre compte, l'Edge Function `delete-account` retire sa ligne `family_members` côté serveur, sans qu'aucun appareil ne déclenche l'action côté client. Aucune entrée d'historique n'est créée dans ce cas.

Backlog item 8a. Décidé par l'utilisateur le 2026-07-13 : « quelqu'un qui veut disparaître sans laisser de trace peut le faire en supprimant son compte » — étant donné que l'Historique se présente comme un registre légal/permanent, ce silence est un vrai trou, pas un cas marginal.

## Approche retenue

Deux options envisagées :
- **(A) Modifier `delete-account`** pour qu'elle écrive elle-même l'entrée. Rejetée : cette fonction a déjà été prise en flagrant délit de dérive dashboard/dépôt (audit sécurité 2026-07-08) — la modifier impose de faire coller son contenu réel par l'utilisateur avant tout changement, puis un redéploiement manuel.
- **(B) Un trigger PostgreSQL sur `auth.users`** — retenue. Migration SQL pure, committée dans le repo comme unique source de vérité (aucun risque de dérive, contrairement à une Edge Function). Se déclenche uniquement quand un compte est réellement supprimé, quel que soit le chemin de code qui le déclenche (pas seulement `delete-account`) — protège aussi contre un futur autre mécanisme de suppression qu'on n'aurait pas prévu.

## Mécanique du trigger

Nouvelle migration `supabase/migrations/0034_log_account_deletion_history.sql`, à exécuter par l'utilisateur dans le SQL Editor Supabase (aucun accès direct de l'assistant à la base — voir CLAUDE.md).

- Une fonction `SECURITY DEFINER` (`set search_path = public`, même convention que `set_member_identity` en 0020) déclenchée par un trigger **`BEFORE DELETE ON auth.users FOR EACH ROW`**.
- `BEFORE` plutôt que `AFTER` : garantit que les lignes `family_members` de ce compte sont encore intactes au moment de la lecture, sans dépendre de l'ordre exact d'une éventuelle suppression en cascade.
- Pour chaque ligne `family_members` où `user_id = OLD.id` :
  1. Compter les autres membres `status = 'active'` de la même famille (`family_id`, `user_id <> OLD.id`).
  2. Si ce compte n'est **pas** le dernier membre actif → insérer une entrée dans `history`.
  3. Si c'était le dernier membre actif → ne rien insérer (décidé : personne ne resterait pour la lire).

Ne rentre jamais en conflit avec les entrées déjà loggées côté client pour un départ volontaire ou un retrait (spec précédent) : ces flux-là ne suppriment jamais la ligne `auth.users`, seulement la ligne `family_members` — le trigger ne se déclenche donc que sur le cas réellement nouveau (suppression de compte).

## Forme de l'entrée

- `who` : `family_members.display_name`, sinon `family_members.email`, sinon `"Cette personne"`.
- `action` : `"{who} a quitté la famille (compte supprimé)"` — formulation volontairement distincte d'un départ volontaire (`"... a quitté la famille"` tout court), pour que l'Historique reste transparent sur la nature de l'évènement.
- `detail` : `""`.
- `type` : `"family"` — réutilise le type introduit par le spec précédent, même icône/filtre (👪) dans `HistTab`, pas de nouvelle entrée dans `TYPE_ICON`/`TYPE_LABEL`.
- `user_id` : `NULL` — le compte est sur le point de disparaître, inutile de garder une référence pendante (cohérent avec le fait que la colonne est déjà nullable et que d'autres entrées historiques gèrent déjà des acteurs supprimés via `removedUserIds`/`formatActorName` côté client).

Un seul format de message, sans distinction de rôle (parent/enfant/observateur) — simplification volontaire : ce qui compte ici est *qui* et *que le compte a été supprimé*, pas son rôle.

## Non-objectifs

- Pas de rattrapage rétroactif pour des comptes déjà supprimés avant cette migration.
- Ne couvre pas le cas où c'est le dernier membre actif de la famille qui supprime son compte (décidé explicitement, voir ci-dessus).
- Ne modifie pas `delete-account` (Edge Function laissée intacte, option A rejetée).

## Test / vérification

- Aucun test automatisé possible (`node --test` ne couvre que la logique JS pure de `core.js` — ceci est un trigger SQL côté Supabase).
- Vérification live à faire par l'utilisateur : créer 2 comptes de test liés à la même famille (ex. un parent + un observateur), supprimer le compte de l'un des deux, confirmer qu'une entrée `"... a quitté la famille (compte supprimé)"` apparaît dans l'Historique vue par le compte restant.
- Vérifier aussi le cas limite : supprimer le compte du dernier membre actif d'une famille → aucune entrée ne doit apparaître (pas d'erreur côté suppression de compte non plus).
- Pas de changement côté client (`App.jsx`) pour cette fonctionnalité → pas de bump `APP_VERSION`/`SW_VERSION` nécessaire (uniquement une migration SQL côté Supabase).
