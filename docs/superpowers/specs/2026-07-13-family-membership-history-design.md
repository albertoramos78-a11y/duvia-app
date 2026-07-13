# Journaliser les arrivées/départs de la famille dans l'Historique — design

**Date :** 2026-07-13
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

L'onglet Historique (`HistTab`, `App.jsx:12097`) journalise déjà les dépenses, documents du coffre, sauvegardes et modifications de calendrier — mais rien sur les changements de composition de la famille (arrivée d'un nouveau parent/observateur, départ volontaire, retrait par quelqu'un d'autre). Backlog item 1.

## Contrainte technique découverte (importante)

L'Historique est une table Supabase **partagée par famille et synchronisée en temps réel** (`src/hooks/useHistory.ts`) : chaque appareil connecté à la famille reçoit les nouvelles entrées via `postgres_changes`. Brancher l'écriture sur un mécanisme de *détection* passive (l'évènement `duvia-invite-left`, déjà utilisé pour afficher une notification "X a quitté") créerait un doublon par appareil actuellement connecté au moment du départ — chacun détecterait le changement et écrirait sa propre entrée.

**Design retenu pour éviter ça** : n'écrire l'entrée que depuis l'appareil de la personne qui **déclenche réellement l'action** (celle qui clique), jamais depuis un appareil qui l'observe passivement. Concrètement, l'entrée est ajoutée directement dans les fonctions/points d'appel existants qui déclenchent le changement, pas dans le mécanisme de détection temps réel.

## Évènements couverts (v1)

1. **Un membre rejoint** — quand un parent valide une adhésion en attente (`familySync.validateMember(...)`), 3 points d'appel dans `App.jsx` selon le contexte (invitation parent, approbation observateur — au moins `~8573`, `~10472`, `~10655`, à reconfirmer avec les numéros de ligne exacts au moment du plan).
2. **Un membre quitte volontairement** — quand quelqu'un clique sur "Quitter la famille" (`familySync.leaveFamily()`), 3 points d'appel (`~4816`, `~5078`, `~8094`).
3. **Un membre est retiré par quelqu'un d'autre** — quand un parent retire un autre membre (`familySync.removeFamilyMember(userId)`), 3 points d'appel (`~8114`, `~8147`, `~10583`).

**Limitation assumée, documentée, pas un bug** : un départ causé par une **suppression de compte** (le serveur agit seul via l'Edge Function `delete-account`, sans qu'aucun appareil ne déclenche l'action côté client dans ce flux) n'est **pas** couvert par cette version — aucune entrée d'historique n'est créée dans ce cas précis. Éviter de toucher à `delete-account` pour cette fonctionnalité (Edge Function à risque de dérive dashboard/dépôt, per CLAUDE.md — nécessiterait de faire coller son contenu réel par l'utilisateur avant toute modification, hors scope ici).

## Forme des entrées

Réutilise `addHist(action, detail, type)` tel quel (`App.jsx:4174`), avec un nouveau type `"family"` :
- Arrivée : `addHist("<Nom> a rejoint la famille", "", "family")`
- Départ volontaire : `addHist("<Nom> a quitté la famille", "", "family")`
- Retrait : `addHist("<Nom> a été retiré de la famille", "", "family")`

(Le nom exact disponible à chaque point d'appel — celui du membre concerné, pas celui de l'acteur — sera confirmé site par site au moment du plan ; `addHist` capture déjà automatiquement l'auteur de l'action via `cfg.parents?.[user?.parentIdx]?.name || user?.name`, donc le "Saisi par" affiché dans l'historique sera la bonne personne sans travail supplémentaire.)

## Petit ajustement d'affichage

`HistTab` a des tables `TYPE_ICON`/`TYPE_LABEL` par type (`App.jsx:12100-12102`) pour l'icône et le libellé du filtre. Ajouter `"family"` à ces deux tables (ex: icône 👪, libellé "Famille") pour un rendu propre — mais **pas** à `TYPE_MAP` (qui sert à naviguer vers l'onglet correspondant au clic) puisqu'il n'y a pas d'onglet "famille" vers lequel naviguer ; ce comportement (entrée non cliquable) est déjà celui des entrées de type `"backup"`, précédent existant à suivre.

## Non-objectifs

- Pas de rattrapage rétroactif : seuls les évènements futurs (à partir du déploiement) sont journalisés, comme pour tous les autres types d'entrées de l'Historique.
- Ne couvre pas le départ par suppression de compte (voir plus haut).
- Ne touche pas à `useFamilySync`'s détection temps réel existante (`duvia-invite-left` reste tel quel, pour la notification "toast" — juste pas de nouvelle écriture d'historique dessus).

## Test / vérification

- `TZ=Europe/Paris npm test` doit rester vert (122 tests) — pas de nouvelle fonction pure attendue, changement de logique dans des gestionnaires d'évènements existants.
- Vérification live : avec 2 comptes de test (2 navigateurs/appareils), faire rejoindre puis quitter/retirer un membre, confirmer une seule entrée par évènement dans l'Historique (pas de doublon), visible par les deux comptes.
- Bump `APP_VERSION`/`SW_VERSION` comme à chaque changement de `App.jsx`.
