# Filet de sécurité anti-écran-blanc (React Error Boundary) — design

**Date :** 2026-07-12
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

L'app n'a aucun "Error Boundary" React (confirmé par recherche exhaustive dans `src/`). Un plantage au rendu n'importe où dans l'arbre de composants démonte toute l'application — écran blanc total, aucune UI, aucun moyen d'interagir, y compris pour signaler le problème (le menu "Signaler un problème" fait lui-même partie de l'app qui vient de planter). C'est exactement le pire moment pour ne pas pouvoir envoyer de rapport, alors qu'un pipeline complet pour ça vient d'être livré aujourd'hui (email automatique à `duvia.services@gmail.com`, voir items 17/17b du backlog).

## Design retenu

### 1. Un seul filet, au niveau racine

`src/main.jsx` monte directement `<App/>` — un seul point d'accroche. Nouveau fichier `src/ErrorBoundary.jsx`, un composant classe React (obligatoire : `componentDidCatch`/`getDerivedStateFromError` n'existent pas en hooks), enveloppant `<App/>` :

```jsx
<StrictMode>
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
</StrictMode>
```

Alternative écartée : un filet par onglet — bien plus de travail (à ajouter partout), et n'aurait de toute façon pas protégé les parties partagées (en-tête, menu) où un plantage laisserait quand même l'app inutilisable.

### 2. Écran de secours

Volontairement autonome — aucune dépendance au thème (`useApp()`/`C`) ni à aucun état de l'app, puisque c'est potentiellement ce qui a planté. Styles en dur, minimalistes :
- Titre "Une erreur est survenue" + une icône.
- Bouton **"🔄 Recharger l'application"** → `window.location.reload()`.
- Bouton **"🐛 Signaler ce problème"** → envoie automatiquement un rapport, sans que l'utilisateur ait à taper quoi que ce soit :
  - Le message d'erreur exact (`error.message`) et la pile d'appels React (`errorInfo.componentStack`) sont capturés dans `componentDidCatch` et envoyés via `logError()` (déjà exporté par `diagnostics.js`) — ils atterrissent donc dans le rapport comme n'importe quelle autre erreur.
  - Le rapport lui-même est envoyé via `submitBugReport()` (déjà existant), avec un commentaire du type `[Plantage automatique] <message d'erreur>`.
  - **Identité** : `submitBugReport` accepte normalement `userId`/`familyId` via le contexte React (`useApp()`) — indisponible ici puisque l'arbre a planté. À la place, on relit directement `localStorage.getItem("duvia_session")` (email du compte, format déjà utilisé ailleurs dans `App.jsx` — un simple JSON stringifié, pas de dépendance React) et on l'inclut dans le commentaire du rapport. Il sera automatiquement masqué (`a***@domaine`) par le passage existant dans `buildReport()` — aucun changement nécessaire côté fonction email.
  - Une fois envoyé : le bouton affiche "Envoyé, merci" ; le bouton recharger reste disponible à tout moment.

### 3. Limites connues (non-objectifs, pas des défauts)

- Ne rattrape pas une erreur survenant avant que React ne démarre (ex: erreur de syntaxe au chargement du module) — cas très rare, hors de portée d'un Error Boundary par nature.
- Ne rattrape pas les erreurs dans un gestionnaire d'évènement (`onClick` etc.) — mécanisme React différent, déjà couvert par `window.addEventListener("error"/"unhandledrejection")` dans `initDiagnostics()`.
- Un bug dans l'écran de secours lui-même ne serait pas rattrapé — d'où le choix de le garder extrêmement simple (pas de dépendance externe, styles en dur).

## Fichiers touchés

- Créer : `src/ErrorBoundary.jsx`.
- Modifier : `src/main.jsx` (import + enveloppe `<App/>`).
- Pas de changement dans `src/App.jsx` ni `src/services/diagnostics.js` (réutilise `logError`/`submitBugReport` tels quels).

## Test / vérification

- `TZ=Europe/Paris npm test` doit rester vert (122 tests) — pas de nouvelle fonction pure, un composant React classique difficile à unit-tester dans ce dépôt (pas d'harnais de test composants) ; vérification live uniquement.
- Vérification live : forcer une erreur de rendu temporaire (ex: `throw new Error("test")` dans un composant, retiré ensuite) et confirmer que l'écran de secours s'affiche au lieu d'un écran blanc, que "Recharger" fonctionne, et que "Signaler ce problème" envoie bien un email avec le message d'erreur et l'email du compte (masqué).
- Bump `APP_VERSION`/`SW_VERSION` comme à chaque changement de code app (`main.jsx` en fait partie).

## Non-objectifs

- Ne touche pas au reste du pipeline de rapport de bug (email, mode debug) — les réutilise tels quels.
- Pas de filet par onglet dans cette version.
