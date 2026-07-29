# Filet de sécurité anti-écran-blanc (React Error Boundary) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current "blank white screen" failure mode on any React render crash with a self-contained recovery screen offering a reload button and a one-click automatic crash report.

**Architecture:** A single new React class component, `src/ErrorBoundary.jsx`, implements `getDerivedStateFromError`/`componentDidCatch` and wraps the existing `<App/>` render in `src/main.jsx`. It has zero dependency on the app's own context/theme/state (all of which may be broken when it activates), reusing only the already-exported, context-free `logError`/`submitBugReport` functions from `src/services/diagnostics.js`.

**Tech Stack:** React (class component — required for Error Boundaries, hooks don't support this), plain inline styles (no theme dependency).

## Global Constraints

- New file path: exactly `src/ErrorBoundary.jsx`.
- `ErrorBoundary` must import nothing from `src/App.jsx`, must not call `useApp()` or reference the app's theme object (`C`), and must not assume any Supabase session/family state is available — it needs to render correctly even when the entire rest of the app is broken.
- Auto-sent crash report's `comment` field must read exactly: `` `[Plantage automatique] ${error message or "Erreur inconnue"}${" — compte: " + email if an email was recovered, otherwise nothing}` `` (exact template given in Task 1, Step 2 below — use it verbatim).
- Email recovery reads exactly `localStorage` key `duvia_session` via `JSON.parse(window.localStorage.getItem("duvia_session") || "null")` — no other key, no other method.
- Bump `APP_VERSION` (`src/config.js`) from `"1.59"` to `"1.60"`, and `SW_VERSION` (`public/sw.js`) from `"1.59"` to `"1.60"`, in the same commit as the code change.
- Test command: `TZ=Europe/Paris npm test` (must stay at 122 passing — no new test expected, this repo has no component-test harness; verification is live/manual per the spec). Build command: `npm run build`.

---

### Task 1: `ErrorBoundary` component + wire into `main.jsx`

**Files:**
- Create: `src/ErrorBoundary.jsx`
- Modify: `src/main.jsx`
- Modify: `src/config.js`, `public/sw.js` (version bump)

**Interfaces:**
- Consumes: `logError(message, stack, context)` and `submitBugReport({ comment, screenshot, context })`, both already exported by `src/services/diagnostics.js` (no changes to that file in this task).
- Produces: a default-exported React component `ErrorBoundary` from `src/ErrorBoundary.jsx`, taking `children` as its only prop. Nothing else in this plan consumes it — this is the only task.

- [ ] **Step 1: Create `src/ErrorBoundary.jsx`**

Create the file with exactly this content:

```jsx
// src/ErrorBoundary.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Filet de sécurité au niveau racine : sans ceci, un plantage au rendu
// N'IMPORTE OÙ dans l'app démonte tout l'arbre React et laisse un écran
// blanc total, sans aucun moyen d'interagir — y compris pour signaler le
// problème, puisque le menu "Signaler un problème" fait lui-même partie de
// l'app qui vient de planter.
//
// 🔧 Volontairement sans AUCUNE dépendance à App.jsx, au thème, ou à
// useApp() : cet écran doit pouvoir s'afficher correctement même si c'est
// précisément l'état de l'app (contexte, session, thème) qui a causé le
// plantage. Il ne réutilise que logError/submitBugReport de diagnostics.js,
// qui ne dépendent d'aucun état React.
//
// Limites connues (normales pour un Error Boundary React, pas des bugs) :
// ne rattrape pas une erreur survenant avant que React ne démarre, ni une
// erreur dans un gestionnaire d'évènement (onClick, etc. — déjà couvert
// séparément par window.addEventListener("error"/"unhandledrejection")
// dans initDiagnostics()).
// ─────────────────────────────────────────────────────────────────────────────
import { Component } from "react";
import { logError, submitBugReport } from "./services/diagnostics";

const STYLES = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "#f5f5f5", fontFamily: "-apple-system, sans-serif" },
  card: { maxWidth: 360, width: "100%", textAlign: "center", background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 4px 24px rgba(0,0,0,.08)" },
  icon: { fontSize: 40, marginBottom: 12 },
  title: { fontSize: 17, fontWeight: 800, color: "#222", marginBottom: 8 },
  desc: { fontSize: 13, color: "#666", lineHeight: 1.6, marginBottom: 22 },
  btnPrimary: { width: "100%", height: 44, background: "linear-gradient(135deg,#7BA8F5,#9D8FF0)", color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, fontSize: 14, marginBottom: 10, cursor: "pointer" },
  btnSecondary: { width: "100%", height: 40, background: "transparent", color: "#666", border: "1.5px solid #ddd", borderRadius: 12, fontWeight: 700, fontSize: 13, cursor: "pointer" },
  status: { fontSize: 12, color: "#666", marginTop: 12 },
};

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, sending: false, sent: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    logError(error?.message || "Erreur de rendu", error?.stack, { componentStack: errorInfo?.componentStack });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReport = async () => {
    this.setState({ sending: true });
    let email = null;
    try { email = JSON.parse(window.localStorage.getItem("duvia_session") || "null"); } catch { /* noop */ }
    try {
      await submitBugReport({
        comment: `[Plantage automatique] ${this.state.error?.message || "Erreur inconnue"}${email ? " — compte: " + email : ""}`,
        screenshot: null,
        context: { userId: null, familyId: null, screen: "crash", appState: {} },
      });
      this.setState({ sent: true, sending: false });
    } catch {
      this.setState({ sent: "error", sending: false });
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={STYLES.wrap}>
        <div style={STYLES.card}>
          <div style={STYLES.icon}>⚠️</div>
          <div style={STYLES.title}>Une erreur est survenue</div>
          <div style={STYLES.desc}>Duvia a rencontré un problème inattendu. Vous pouvez recharger l'application, ou nous signaler ce problème pour qu'on puisse le corriger.</div>
          <button onClick={this.handleReload} style={STYLES.btnPrimary}>🔄 Recharger l'application</button>
          <button onClick={this.handleReport} disabled={this.state.sending || this.state.sent === true} style={STYLES.btnSecondary}>
            {this.state.sending ? "Envoi…" : this.state.sent === true ? "✅ Signalé" : "🐛 Signaler ce problème"}
          </button>
          {this.state.sent === true && <div style={STYLES.status}>Merci, le problème a été transmis.</div>}
          {this.state.sent === "error" && <div style={STYLES.status}>L'envoi a échoué. Réessayez, ou rechargez l'application.</div>}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
```

- [ ] **Step 2: Wrap `<App/>` in `src/main.jsx`**

`src/main.jsx` currently reads:

```jsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // Revérifie périodiquement s'il y a une nouvelle version, utile pour
      // une appli installée restée ouverte longtemps sans être rechargée.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); // toutes les heures
    }).catch(() => {});

    // 🔧 "Nouvelle version disponible" : on ignore le tout premier
    // contrôleur (1ère visite, rien à mettre à jour), et on prévient
    // l'appli uniquement quand un VRAI changement de version se produit.
    let hadControllerBefore = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadControllerBefore) { hadControllerBefore = true; return; }
      window.dispatchEvent(new CustomEvent("duvia-update-ready"));
    });
  });
}
```

Replace the top import block and the `createRoot(...).render(...)` call — everything from the top of the file through the closing `);` of the render call — with:

```jsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
```

Leave the entire `if ("serviceWorker" in navigator) { ... }` block below it completely untouched (do not modify, do not reformat).

- [ ] **Step 3: Run the test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `# pass 122` (unchanged — no test touches `main.jsx` or the new component).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds with no errors (the pre-existing "chunks are larger than 500 kB" warning is expected and unrelated).

- [ ] **Step 5: Manual verification checklist (for the report, not automatable)**

Note in your report that the following still needs a live check by the user after deploy (no browser tooling in this environment, and this repo has no component-test harness to simulate a render crash automatically):
1. Temporarily add `throw new Error("test crash")` at the top of any component's render body (e.g. inside `CalTab`), deploy/run locally, navigate to trigger it, confirm the recovery screen appears instead of a blank page — then remove the temporary throw.
2. Click "🔄 Recharger l'application" — confirm the app reloads and recovers normally.
3. Trigger the crash again, click "🐛 Signaler ce problème" — confirm it shows "Envoyé, merci" and that the email received at `duvia.services@gmail.com` contains the exact error message and (if logged in) a masked account email.

- [ ] **Step 6: Bump version**

In `src/config.js`, change:
```js
export const APP_VERSION = "1.59";
```
to:
```js
export const APP_VERSION = "1.60";
```

In `public/sw.js`, change:
```js
const SW_VERSION = "1.59";
```
to:
```js
const SW_VERSION = "1.60";
```

- [ ] **Step 7: Commit**

```bash
git add src/ErrorBoundary.jsx src/main.jsx src/config.js public/sw.js
git commit -m "$(cat <<'EOF'
Add a root-level Error Boundary so a render crash isn't a blank screen

The app had no Error Boundary anywhere -- any uncaught render error
unmounted the whole tree, leaving a totally blank page with no way to
even reach the bug-report feature. Wraps <App/> in main.jsx with a
self-contained recovery screen (reload button + one-click automatic
crash report) that has zero dependency on the app's own context/theme,
since that may be exactly what's broken.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** "1. Un seul filet, au niveau racine" → Step 1-2 (single ErrorBoundary wrapping `<App/>` in main.jsx). "2. Écran de secours" → Step 1's full component code (reload button, auto-send report button, email recovery from `duvia_session`, sent/error states). "3. Limites connues" → documented in the component's own header comment, not a code requirement. Test/vérification section → Steps 3-4 (automated) and Step 5 (manual, explicitly non-automatable). Version bump → Step 6.
- **Placeholder scan:** no TBD/TODO; every step has literal file content or exact commands.
- **Type consistency:** n/a (single new file, no cross-task interfaces — `ErrorBoundary`'s only interface, `children` prop, is standard React and used correctly at its one call site in `main.jsx`).
