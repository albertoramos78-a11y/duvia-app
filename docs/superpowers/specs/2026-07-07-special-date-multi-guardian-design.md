# Dates spéciales — garde multi-personnes (parents + observateurs)

## Contexte

Dans `StepDates` (config famille → Dates personnalisées), chaque date personnalisée a une section "Garde chez" qui permet de forcer, pour ce jour-là, l'affichage du calendrier sur un parent précis plutôt que sur la garde résolue normalement (`resolveGuard`). Aujourd'hui :

- Un seul parent peut être sélectionné (`cd.parentId`, une chaîne).
- Les observateurs ne sont jamais proposés, même ceux marqués "peut être gardien" (`canGuard: true`).
- La sélection remplace toujours la garde normale — il n'y a pas de bouton "aucun" explicite, mais en pratique `cd.parentId` est toujours rempli une fois qu'on a cliqué un parent.

Ce document couvre l'extension : sélection multiple, inclusion des observateurs gardiens, et retour au calendrier par défaut si rien n'est sélectionné.

## Portée

Ce changement reste strictement un **affichage du calendrier** (case du mois + ligne de la vue liste). Il ne touche à aucune autre fonctionnalité :
- Pas d'impact sur `resolveGuard()` lui-même, ni sur le calcul des dépenses (qui reste basé sur `parentIdx`/position).
- Pas d'impact sur le badge "qui garde cette semaine" en fin de semaine, ni sur la détection de changement de garde (`isChangeDay`) — ces deux mécanismes lisent déjà `d.guard` (la garde résolue normalement, non modifiée par la date personnalisée), et continuent de le faire.

## Modèle de données

`cd.guardIds: string[]` — nouveau champ sur chaque entrée de `cfg.specialDates.custom[]`. Chaque élément est une chaîne préfixée :
- `` `p:${parent.id}` `` pour un parent
- `` `obs:${observer.id}` `` pour un observateur

Tableau vide ou absent → aucune garde forcée (comportement par défaut).

**Rétrocompatibilité** : les entrées déjà enregistrées avec l'ancien champ `cd.parentId` (chaîne unique, jamais de préfixe) et sans `cd.guardIds` sont lues comme `[\`p:${cd.parentId}\`]`. Aucune migration de données n'est nécessaire — la lecture gère les deux formats.

## Logique pure (nouveau, dans `src/utils/core.js`)

```js
// Décompose un id préfixé ("p:123" / "obs:abc") en {type, id}.
function parseGuardId(idStr) { ... }

// Résout cd.guardIds (ou cd.parentId en fallback) en une liste d'objets
// gardien {type, id, name, color, avatar}, dans l'ordre de sélection.
// Les ids qui ne correspondent plus à personne (parent/observateur supprimé
// depuis) sont silencieusement ignorés.
function resolveCustomDateGuardians(cd, parents, observers) { ... }
```

Ces deux fonctions sont pures (aucune dépendance à React/Supabase) et couvertes par des tests dans `core.test.js`, suivant la convention du projet.

## Interface — section "Garde chez" (`StepDates`)

- Les boutons parents existants restent (un bouton par parent).
- Un bouton par observateur avec `canGuard === true` est ajouté à la suite, même style que les boutons parents mais utilisant `C.ora` comme couleur par défaut si l'observateur n'a pas de couleur propre (cohérent avec le reste de l'app, où les observateurs sont toujours représentés en orange).
- Chaque clic **bascule** l'appartenance de cette personne dans `cd.guardIds` (ajoute si absent, retire si présent) — ce n'est plus un remplacement.
- Quand `cd.guardIds` est vide, un petit texte discret remplace les boutons actifs : "Calendrier par défaut" (les boutons restent cliquables pour resélectionner).

## Rendu calendrier

**0 personne sélectionnée** — inchangé : la case utilise `guard` (résultat de `resolveGuard`), sans override.

**1 personne sélectionnée** — comme le comportement actuel, étendu aux observateurs : couleur pleine de cette personne, son nom affiché. (Aujourd'hui limité aux parents ; devient parent OU observateur.)

**2+ personnes sélectionnées** — nouveau :
- Fond de case : dégradé CSS en bandes verticales égales, une par personne, dans l'ordre de sélection (`linear-gradient(to right, color1 0% X%, color2 X% Y%, ...)`).
- Nom affiché : prénoms joints par « + » (ex. "Sissi + Alberto"), tronqué avec ellipsis si trop long pour la case (le tronquage existe déjà pour les autres libellés de case, même traitement CSS).

**Vue liste** : même logique — la ligne du jour affiche les noms joints et un petit point de couleur par personne (au lieu d'un point unique), réutilisant `resolveCustomDateGuardians`.

## Points d'intégration dans `App.jsx`

- `StepDates` (~ligne 8843-8855) : remplace les boutons "Garde chez" à sélection unique par la version multi-toggle + observateurs.
- Vue grille mensuelle (~ligne 10339-10353, variable `customParent`) : remplacé par `resolveCustomDateGuardians(cd, cfg.parents, cfg.observers)`, et le rendu de la case (couleur de fond, libellé) mis à jour pour gérer 0/1/2+ résultats.
- Vue liste (~ligne 10271-10279, variables `_cdList`/`effectiveGuard`) : même remplacement, adapté au rendu de la ligne de liste.

## Hors scope (explicitement)

- Pas de limite sur le nombre de personnes sélectionnables.
- Pas de verrouillage Premium supplémentaire sur les boutons de sélection (ils ne l'étaient déjà pas avant ce changement — seul l'ajout d'une nouvelle date personnalisée est Premium).
- Pas de changement au badge de fin de semaine ni à la logique de calcul des dépenses.
