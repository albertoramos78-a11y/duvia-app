# Mode debug — journalisation des changements d'onglet — design

**Date :** 2026-07-12
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

La fonctionnalité de rapport de bug (`BugReportModal`, `src/services/diagnostics.js`) inclut déjà un système de journalisation (`logAction`, ring buffer de 300 entrées) censé aider à comprendre ce que l'utilisateur faisait juste avant un bug. En pratique, ce système n'est appelé que dans 2 endroits de tout le code (`app_open` à l'ouverture de l'app, `bug_report_sent` à l'envoi du rapport lui-même) — aucune action réelle de l'utilisateur (changement d'onglet, clic, etc.) n'est jamais journalisée. Constaté en direct le 2026-07-12 : un rapport de bug envoyé ne montrait quasiment rien d'utile dans la section "Dernières actions" du mail de notification.

Les erreurs JS (`logError`), elles, sont déjà capturées automatiquement partout (écouteurs globaux `window.addEventListener("error"/"unhandledrejection")`) — aucun changement nécessaire de ce côté.

## Design retenu

### 1. Activation manuelle, pas automatique

Plutôt que d'enregistrer les actions de tout le monde en permanence (coût de performance pour rien, question de vie privée), l'utilisateur active lui-même un "Mode debug" quand il sait qu'il va essayer de reproduire un bug. Toggle dans les Préférences (`PrefsTab` et `ObserverPrefsTab`, section "🔒 Sécurité" — `App.jsx:7219` et `App.jsx:7721`), désactivé par défaut.

### 2. Auto-désactivation après le prochain rapport de bug

Le mode reste actif jusqu'à l'envoi du prochain rapport ("Signaler un problème"), après quoi il se désactive automatiquement — pas besoin d'y repenser, pas de risque de l'oublier activé pendant des semaines.

### 3. Portée : changements d'onglet uniquement (v1)

Plutôt que d'instrumenter des dizaines d'endroits dans les 17 000 lignes de `App.jsx` (gros chantier, risque élevé pour un premier jet), le mode debug journalise uniquement les **changements d'onglet principal** (Calendrier, Dépenses, Messages, etc.) — un seul point d'entrée dans le code (`switchTab()`, `App.jsx:3430`), donc un changement petit et sûr. Ça donne déjà un fil "l'utilisateur était sur tel écran, puis tel écran, puis a signalé le bug", suffisant pour la grande majorité des cas. D'autres actions précises pourront être ajoutées plus tard si le besoin se confirme, une fois ce mécanisme en place et éprouvé.

## Détails techniques

### `src/services/diagnostics.js`

Nouvel état module-level (comme `logs`/`errs` existants), persisté dans `localStorage` (`duvia_debug_mode`, valeur `"1"` ou absente) pour survivre à un rechargement de page :

```js
const DEBUG_MODE_KEY = "duvia_debug_mode";
let debugModeOn = (() => {
  try { return window.localStorage.getItem(DEBUG_MODE_KEY) === "1"; } catch { return false; }
})();

export function isDebugMode() { return debugModeOn; }

export function setDebugMode(on) {
  debugModeOn = !!on;
  try {
    if (debugModeOn) window.localStorage.setItem(DEBUG_MODE_KEY, "1");
    else window.localStorage.removeItem(DEBUG_MODE_KEY);
  } catch { /* noop */ }
}
```

Dans `submitBugReport()`, juste avant le `return true;` final : `setDebugMode(false);` — auto-désactivation après un rapport envoyé avec succès (uniquement en cas de succès ; un envoi qui échoue laisse le mode actif, cohérent avec l'esprit "encore utile puisque le bug n'est pas signalé").

`logAction`/`app_open`/`bug_report_sent` restent **inchangés** — toujours journalisés inconditionnellement, comme aujourd'hui. Seul le nouvel appel pour les changements d'onglet (voir ci-dessous) est conditionné par `isDebugMode()`.

### `src/App.jsx`

Import : ajouter `logAction, isDebugMode` à l'import existant de `./services/diagnostics` (ligne 13).

`switchTab()` (`App.jsx:3430`), actuellement :
```js
function switchTab(i){ tabDir.current = i > tab ? "right" : "left"; setTab(i); }
```
devient :
```js
function switchTab(i){
  tabDir.current = i > tab ? "right" : "left";
  setTab(i);
  if (isDebugMode()) logAction("tab_switch", { tab: TABS[i]?.label || i });
}
```
(`TABS` est déjà défini plus haut dans le même composant — `App.jsx:4393` — et accessible ici par closure au moment de l'appel, pas au moment de la définition de la fonction.)

### UI Préférences (`PrefsTab` et `ObserverPrefsTab`)

Un petit bloc dans la section "🔒 Sécurité" existante (pas une nouvelle section séparée) :
- Une case à cocher "Mode debug" avec une description courte : "Enregistre les changements d'écran pour aider à diagnostiquer un bug. Se désactive automatiquement après l'envoi du prochain rapport."
- État initial lu via `isDebugMode()` au montage du composant.
- `onChange` appelle `setDebugMode(checked)` et met à jour l'état local du composant.

Disponible pour tous les types de compte (parent, enfant, observateur) — même logique que le 2FA plus tôt cette session (`PrefsTab` ET `ObserverPrefsTab` reçoivent chacun leur propre bloc, comme c'est déjà le pattern établi dans ce fichier pour ce genre de réglage).

## Non-objectifs

- Pas d'instrumentation d'autres actions que les changements d'onglet dans cette première version.
- Ne touche pas à `logError` (déjà correct).
- Ne concerne pas le cas "écran blanc suite à un plantage" — sujet distinct, brainstorm séparé à suivre.

## Test / vérification

- `TZ=Europe/Paris npm test` doit rester vert (122 tests) — pas de nouvelle fonction pure attendue, changement de comportement React + un module de state simple.
- Vérification live : activer le mode debug dans Préférences, changer d'onglet 2-3 fois, signaler un bug → le mail reçu doit lister ces changements d'onglet dans "Dernières actions". Revérifier ensuite que le mode s'est bien désactivé automatiquement (rouvrir Préférences, case décochée).
- Bump `APP_VERSION`/`SW_VERSION` comme à chaque changement de `App.jsx`.
