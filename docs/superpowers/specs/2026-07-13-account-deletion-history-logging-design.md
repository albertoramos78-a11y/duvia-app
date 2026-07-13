# Journaliser un départ causé par une suppression de compte — design

**Date :** 2026-07-13
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Le spec précédent ([2026-07-13-family-membership-history-design.md](2026-07-13-family-membership-history-design.md)) a journalisé les arrivées, départs volontaires et retraits dans l'Historique — mais a explicitement laissé de côté un cas : quand un membre supprime son propre compte, l'Edge Function `delete-account` retire sa ligne `family_members` côté serveur, sans qu'aucun appareil ne déclenche l'action côté client. Aucune entrée d'historique n'est créée dans ce cas.

Backlog item 8a. Décidé par l'utilisateur le 2026-07-13 : « quelqu'un qui veut disparaître sans laisser de trace peut le faire en supprimant son compte » — étant donné que l'Historique se présente comme un registre légal/permanent, ce silence est un vrai trou, pas un cas marginal.

## Approche retenue

Deux options envisagées :
- **(A) Modifier `delete-account`** pour qu'elle écrive elle-même l'entrée. Rejetée : cette fonction a déjà été prise en flagrant délit de dérive dashboard/dépôt (audit sécurité 2026-07-08) — la modifier impose de faire coller son contenu réel par l'utilisateur avant tout changement, puis un redéploiement manuel.
- **(B) Un trigger PostgreSQL** — retenue. Migration SQL pure, committée dans le repo comme unique source de vérité (aucun risque de dérive, contrairement à une Edge Function).

**⚠️ Révision post-test live (2026-07-13) :** la première version de cette migration déclenchait le trigger sur `auth.users` (`BEFORE DELETE`). Testée en live avec 2 comptes réels, elle n'a produit aucune entrée. Diagnostic (journal temporaire inséré dans la fonction) : le trigger se déclenchait bien, mais ne trouvait plus aucune ligne `family_members` à lire. Cause réelle : l'Edge Function `delete-account` supprime la ligne `family_members` en **étape 1** de son exécution, et ne supprime `auth.users` qu'en **étape 5**, tout à la fin — au moment où le trigger `auth.users` se déclenche, la ligne `family_members` est déjà partie depuis longtemps. Design corrigé ci-dessous.

## Mécanique du trigger (design corrigé)

Migration `supabase/migrations/0034_log_account_deletion_history.sql`, à exécuter par l'utilisateur dans le SQL Editor Supabase (aucun accès direct de l'assistant à la base — voir CLAUDE.md).

- Une fonction `SECURITY DEFINER` (`set search_path = public`, même convention que `set_member_identity` en 0020) déclenchée par un trigger **`AFTER DELETE ON public.family_members FOR EACH ROW`** — pas `auth.users`.
- Pourquoi ça ne double-logge jamais les départs volontaires/retraits (spec précédent) : vérifié en lisant le code réel de `leave_family()` et `remove_family_member()` (RPC `SECURITY DEFINER`, via `pg_get_functiondef`) — ces deux fonctions ne font **jamais** de `DELETE` sur `family_members`, seulement `UPDATE ... SET status = 'removed'`. Un `DELETE` sur cette table ne peut donc arriver aujourd'hui que via l'appel explicite `.delete()` de `delete-account` — le trigger ne se déclenche donc que sur le cas réellement visé.
- Logique, à partir de la ligne supprimée (`OLD`) :
  1. Si `OLD.status` n'était pas `'active'` (déjà `'removed'` avant la suppression du compte, ex. quelqu'un qui avait quitté puis supprime son compte plus tard) → ne rien faire, ce départ a déjà été loggé en son temps.
  2. Sinon, compter les membres `status = 'active'` restants de la même famille (`family_id = OLD.family_id`).
  3. Si au moins un reste → insérer une entrée dans `history`.
  4. Si c'était le dernier membre actif → ne rien insérer (décidé : personne ne resterait pour la lire).

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
