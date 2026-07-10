# Bulle d'info jour (lecture seule) pour enfants/observateurs — Design

**Statut :** approuvé, prêt pour planification.
**Backlog :** dernière partie de l'item 5 ("Observer/child mode feature requests") — la carte d'identité enfant (`ChildInfoModal`) a déjà été livrée le 2026-07-09, ceci est la pièce "mini calendrier : bulle flottante avec les infos du jour sélectionné".

## Contexte

Demande originale (2026-07-07/08, jamais détaillée depuis) : "Mini calendar: show a floating bubble with the selected day's info (observer/child mode)." Confirmé le 2026-07-11 : uniquement pour les rôles enfant et observateur.

Investigation du code existant avant le brainstorm :
- `CalTab` (`App.jsx:10399`) est déjà rendu avec `readOnly` pour les observateurs (`App.jsx:5001`) et les enfants (`App.jsx:5020`) — même composant, même prop, pour les deux rôles.
- Le mécanisme de bulle existe déjà entièrement pour les parents : taper un jour ouvre `InlinePicker` (`App.jsx:11287`), qui affiche des badges du jour (férié/vacances/événements spéciaux), un bloc rendez-vous (heure/lieu/note si renseignés), puis des boutons pour réassigner la garde à un parent/gardien, plus un bouton "modifier en détail" ouvrant `EditDay`.
- **Aujourd'hui, taper un jour ne fait RIEN pour un enfant/observateur** — le clic est explicitement désactivé quand `readOnly` est vrai, à la fois dans `openDay()` (vue grille, `App.jsx:11092-11095`) et dans les gestionnaires `onClick` inline de la vue liste (`App.jsx:10946`, `10955`). C'est donc un vrai nouvel accès, pas un simple restyle.
- **Découverte importante** : la plupart des infos qu'on pensait devoir exposer sont déjà visibles sans taper sur le jour. `GuardCell` (`App.jsx:11229`, utilisé en vue liste) affiche déjà le nom du parent/gardien, son heure/lieu de prise en charge, et son rôle ("🏠 Gardien" / "🎁 Ensemble"), même en mode `readOnly`. Les badges (férié/vacances/événements) sont aussi déjà affichés dans la case, dans les deux vues (liste et grille). La vue grille (`renderDayCell`, `App.jsx:11097`) encode le parent par la COULEUR de fond de la case plutôt que par du texte, donc le nom n'y est pas explicitement écrit — mais l'heure/lieu y sont déjà visibles s'ils sont renseignés.
- La seule information réellement invisible aujourd'hui pour ces rôles, dans les deux vues, est **la note** (`guard.note`) qu'un parent peut attacher à un jour — elle n'existe nulle part en dehors de `InlinePicker`.

La fonctionnalité garde donc sa valeur (bulle cohérente et accessible au lieu de devoir mémoriser des couleurs, affichage explicite du nom en vue grille, et surtout rendre la note visible pour la première fois) sans qu'il soit nécessaire de dupliquer une UI d'affichage : on étend le composant existant.

## Architecture

Un seul composant modifié : `InlinePicker` (`App.jsx:11287`) gagne une prop `readOnly` (booléen, défaut `false`).

- **Partie haute (badges + bloc rendez-vous)** : strictement inchangée, rendue à l'identique dans les deux modes — c'est déjà la partie qui contient l'information (dont la note), pas d'action.
- **Partie basse (ligne d'actions)** : actuellement les boutons de réassignation parent/gardien + bouton "✕" (effacer) + bouton "modifier en détail". En mode `readOnly`, cette ligne est remplacée par une seule ligne de texte non cliquable résumant qui a la garde ce jour-là (nom du parent ou "🏠 {nom du gardien}"), dérivée du même objet `guard` déjà reçu en prop — pas de nouvelle donnée, pas de nouvel appel réseau.
- Si `guard` ne désigne personne (jour non configuré), afficher un texte neutre ("Non défini") plutôt que rien, pour que la bulle ne paraisse jamais cassée/vide.

**Points d'entrée à réactiver** (actuellement bloqués à `readOnly`) :
- `openDay()` (vue grille, `App.jsx:11092-11095`) : retirer le `if(readOnly) return;` qui empêche toute ouverture.
- Les deux `onClick` inline de la vue liste (`App.jsx:10946`, `10955`) : retirer le `if(!readOnly)` qui les entoure.
- `GuardCell` (`App.jsx:11229`, `11237`) : son `onClick={readOnly?undefined:onClick}` doit aussi être réactivé pour `readOnly`, sinon le clic depuis la vue liste ne se propage jamais jusqu'à `openDay`/`setInlineDs`.
- Les deux endroits qui rendent conditionnellement `InlinePicker` (`App.jsx:10959` en liste, `App.jsx:11211-11224` en grille) : retirer le `!readOnly` qui empêche actuellement son rendu, et lui passer `readOnly={readOnly}`.

**Ce qui reste bloqué, sans changement** : le modal d'édition complet `EditDay` (`fullDs`) reste inaccessible — son rendu est déjà gardé par `!readOnly` en plus de `!editBlocked` (`App.jsx:10966`), et `InlinePicker` en mode `readOnly` ne proposera de toute façon aucun bouton "modifier en détail" (`onFull` non applicable dans ce mode).

## Erreurs et cas limites

- Jour sans garde définie (`guard` vide/undefined) : afficher "Non défini" au lieu d'une ligne vide.
- Garde partagée (`guard.allParents`) : afficher les deux noms de parents, comme le fait déjà `GuardCell` pour ce cas.
- Aucune donnée serveur supplémentaire n'est nécessaire — tout vient de `cfg`/`guard`, déjà chargés pour afficher le calendrier lui-même.

## Tests

Pas de nouvelle logique pure à extraire vers `core.js` — c'est une extension de rendu conditionnel dans un composant React existant, testée manuellement (pas de framework de test de composants dans ce repo, cf. CLAUDE.md/mémoire session).

Vérification manuelle obligatoire (pas d'outil navigateur dans cet environnement) : en tant qu'enfant ou observateur, taper un jour dans le calendrier (vue liste ET vue grille) doit ouvrir la bulle avec les bonnes infos et aucun bouton cliquable ; taper un jour ayant une note doit afficher cette note (jamais visible avant) ; vérifier qu'aucune action de la bulle ne permet de modifier la garde.
