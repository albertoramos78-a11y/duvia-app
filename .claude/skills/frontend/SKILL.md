---
name: frontend
description: Use when building, modifying, or reviewing UI/frontend code in the Duvia app (React components, styles, forms, new tabs/modals) - enforces Duvia's theme/i18n/validation conventions, keeps the visual identity distinctive rather than generic-AI-looking, and requires live browser verification before any UI work is called done.
---

# Frontend Duvia

Duvia est une app React + Vite (co-parentalité, mobile-first — utilisée en situation de transition de garde, souvent sur téléphone, parfois dans un moment de stress). Trois familles de règles s'appliquent à tout travail UI.

## 1. Conventions du projet (non négociables)

- **Thème** : ne jamais coder une couleur en dur. Utiliser les clés de `src/theme.js` (`bg, card, sur, bor, txt, mut, inp, vio, blu, grn, yel, red, ora, pin`) via l'objet thème reçu en props/contexte. Le thème actif dépend du mode DARK/LIGHT **et** de fenêtres saisonnières date-gated (`isSummerPeriod()`, `isRGPeriod()`, `isWCPeriod()` dans `theme.js`) — si tu ajoutes un thème événementiel, suis ce même pattern (dates de début/fin + fonction `isXPeriod()`), ne le hardcode pas ailleurs.
- **i18n** : tout texte visible par l'utilisateur passe par `TR` (`src/i18n/index.js`, agrégé depuis `fr.js/en.js/de.js/es.js/pt.js`). Le français est la langue de référence — les autres langues peuvent être incomplètes par design (fallback `t.key || "..."`), donc ne pas bloquer une PR pour une traduction DE/ES/PT manquante, mais **toujours** ajouter la clé FR. Jamais de chaîne française/anglaise en dur dans le JSX.
- **Validation** : toute limite de longueur/montant sur un input vient de `LIMITS` (`src/config.js`) — jamais un nombre magique (`maxLength={60}` → utiliser `LIMITS.NAME_MAX`, etc.).
- **Pattern de données** : pour une nouvelle feature persistée, suivre `service (src/services/supabase/*Service.ts) → hook (src/hooks/use*.ts, avec souscription Realtime) → composant dans App.jsx`. Ne pas appeler Supabase directement depuis un composant.
- **Logique pure** : toute fonction pure nouvelle (validation, calcul de dates, dédup...) va dans `src/utils/core.js` avec un test dans `core.test.js`, pas inline dans `App.jsx`.
- **Version** : toute modification de code app (même un simple ajustement visuel) doit incrémenter `APP_VERSION` (`src/config.js`) **et** `SW_VERSION` (`public/sw.js`) ensemble avant de pousser — sinon les onglets déjà ouverts ne détectent jamais la mise à jour. Voir CLAUDE.md pour le détail.

## 2. Qualité visuelle et UX

- **Ne pas produire un design générique IA** : pas de gradient violet par défaut, pas de police système par défaut (Inter/Roboto/Arial) si l'app en a déjà une, pas de layout interchangeable avec n'importe quelle autre app. Duvia a déjà une identité (palette `BRAND` extraite d'un gradient bleu→rose, thèmes saisonniers) — s'y aligner plutôt que réinventer.
- **Mobile-first** : cibles tactiles suffisamment grandes, pas de texte tronqué sur petit écran, tester en largeur réduite avant de considérer un composant terminé.
- **Cohérence avec l'existant** : avant de créer un nouveau composant, regarder comment un onglet similaire est déjà construit dans `App.jsx` (structure des modals, boutons, cards) plutôt que d'introduire un nouveau style.
- **Contexte émotionnel** : c'est une app utilisée par des parents séparés, parfois en tension (échanges de garde, messages, dépenses partagées) — préférer une UI apaisante et claire à quelque chose de ludique/criard, sauf sur les zones déjà thématisées comme telles (thème LICORNE pour les enfants, par ex.).
- **Micro-interactions avec parcimonie** : une transition ou une animation doit clarifier un changement d'état, pas décorer.

## 3. Vérification avant de dire "c'est fait"

- **Build + tests ne suffisent pas pour du JSX.** Ce repo n'a pas de tests de composants — un changement visuel peut compiler et passer `npm test` tout en cassant l'app en prod (déjà arrivé : un remplacement d'image d'en-tête a crashé la prod malgré build+tests verts).
- Avant de clore une tâche UI : lancer `npm run dev`, ouvrir la fonctionnalité dans le navigateur, tester le chemin nominal **et** au moins un cas limite (formulaire vide, texte trop long par rapport à `LIMITS`, thème DARK et LIGHT), et vérifier l'absence de régression visible sur les onglets voisins.
- Si un test en navigateur réel n'est pas possible dans le contexte courant, le dire explicitement plutôt que d'affirmer que "ça marche".
- Ne pas oublier le bump de version (point 1) une fois la vérification faite.
