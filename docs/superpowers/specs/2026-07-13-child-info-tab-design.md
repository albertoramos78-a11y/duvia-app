# Fiche enfant : de la modale d'en-tête à un onglet de la barre principale — design

**Date :** 2026-07-13
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

La fiche enfant en lecture seule pour observateurs/enfants ([2026-07-09-child-info-card-readonly-design.md](2026-07-09-child-info-card-readonly-design.md)) est accessible via un bouton 🧒 isolé dans l'en-tête, séparé de la barre d'onglets principale (Calendrier, Contacts, Messages...). Backlog item 18b — l'utilisateur veut l'intégrer "dans le bandeau" plutôt que dans l'en-tête.

Clarifié le 2026-07-13 : "le bandeau" désigne la barre d'onglets principale (celle où se trouvent déjà Calendrier/EDT/Contacts/Messages/Jeu), pas le bandeau d'info de garde en cours.

## Décisions prises pendant le brainstorm

- **Vrai onglet, contenu plein écran** (pas une icône qui ouvre la même pop-up) — cohérent avec le reste de la barre.
- **Position : juste après Calendrier** (2e onglet) — pour garder la même proximité que l'ancien bouton d'en-tête, toujours visible.
- **Le bouton 🧒 de l'en-tête disparaît** — un seul point d'accès, pas de doublon.

## Composants et fichiers concernés (tous dans `src/App.jsx`)

- **`TABS`** (~ligne 4406) : les deux branches `isObs`/`isChild` gagnent une entrée `{icon:"🧒", label:t.tabChildInfo||"Enfant"}` en 2e position.
- **`ChildInfoModal`** (~ligne 2615) → renommé **`ChildInfoTab`** : supprime le wrapper plein écran à fond semi-transparent (`position:fixed,inset:0,background:"rgba(0,0,0,.5)"...`) et le bouton de fermeture ✕ ; garde tout le contenu interne tel quel (sélecteur multi-enfants en chips, avatar, date de naissance, champs allergie/groupe sanguin/école/médecin/contacts d'urgence/notes déjà filtrés sur "non vide"). Ne prend plus de props (`onClose` retiré) — s'aligne sur les autres composants d'onglet (`ContactsTab()`, `ScheduleTab()`) qui lisent tout via `useApp()`.
- **Rendu conditionnel par `tab` (~lignes 5104-5130)** : les indices se décalent d'un cran après la position 1 pour laisser la place au nouvel onglet.
  - Observateur : `0→CalTab, 1→ChildInfoTab, 2→ContactsTab, 3→MessagingTab, 4→GameTab` (au lieu de 0-3 actuels).
  - Enfant : `0→CalTab, 1→ChildInfoTab, 2→ScheduleTab, 3→ContactsTab, 4→MessagingTab` (au lieu de 0-3 actuels ; l'index 4→GameTab actuel pour ce rôle est déjà mort code — `TABS` n'a que 4 entrées pour ce rôle donc `tab` ne peut jamais valoir 4 — non affecté par ce changement).
- **Bouton d'en-tête 🧒** (~ligne 4734-4739) et l'état `showChildInfoModal` (~ligne 3442) ainsi que son rendu modal (`{showChildInfoModal && <ChildInfoModal .../>}`) : supprimés entièrement.
- **i18n** : nouvelle clé `tabChildInfo:"Enfant"` dans `fr.js` (les clés déjà utilisées à l'intérieur du composant — `childInfoCardTitle`, `childInfoCardEmpty`, `childAllergy`, etc. — restent inchangées).

## Non-objectifs

- Aucun changement de contenu ou de logique de la fiche elle-même (mêmes champs, même filtrage sur "non vide", même sélecteur multi-enfants).
- Ne touche pas aux onglets du rôle parent (le bouton/la fiche n'ont jamais été visibles pour ce rôle).
- Pas de nouvelle traduction au-delà de la clé FR `tabChildInfo` (les autres langues restent incomplètes par design, comme partout ailleurs dans l'app).

## Test / vérification

- `TZ=Europe/Paris npm test` doit rester vert (122 tests) — changement purement JSX/structurel, aucune nouvelle fonction pure.
- Bump `APP_VERSION`/`SW_VERSION` (changement de `App.jsx`).
- Vérification live à faire par l'utilisateur (pas de navigateur dans cet environnement) : se connecter en observateur puis en enfant, confirmer que l'onglet "Enfant" 🧒 apparaît en 2e position, affiche bien les infos (avec plusieurs enfants si possible pour tester le sélecteur), et que le bouton 🧒 de l'en-tête a bien disparu sans laisser d'espace vide bizarre.
