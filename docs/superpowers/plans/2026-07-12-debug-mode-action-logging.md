# Mode debug — journalisation des changements d'onglet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Mode debug" toggle in Préférences that logs tab switches (via the existing, mostly-unused `logAction()` mechanism) so bug reports actually contain a useful action trail, and auto-disables itself after the next bug report is sent.

**Architecture:** A small module-level flag in `src/services/diagnostics.js` (`isDebugMode()`/`setDebugMode()`, persisted to `localStorage`) gates a single new `logAction("tab_switch", ...)` call site in `App.jsx`'s existing `switchTab()` function. `submitBugReport()` turns the flag back off after a successful submission. Two near-identical checkbox blocks (one in `PrefsTab`, one in `ObserverPrefsTab`) let any account type toggle it on.

**Tech Stack:** React (`src/App.jsx`), a plain JS module (`src/services/diagnostics.js`), `localStorage`.

## Global Constraints

- localStorage key: exactly `duvia_debug_mode` (value `"1"` when on, key removed/absent when off).
- Exported function names: exactly `isDebugMode()` and `setDebugMode(on)`.
- `setDebugMode(false)` must fire only on `submitBugReport()`'s SUCCESS path (after the `insert` succeeds), never when the insert throws — a failed report must leave debug mode on.
- Log entry shape: exactly `logAction("tab_switch", { tab: TABS[i]?.label || i })`.
- The toggle must be added to BOTH `PrefsTab` and `ObserverPrefsTab` — not just one.
- Bump `APP_VERSION` (`src/config.js`) from `"1.58"` to `"1.59"`, and `SW_VERSION` (`public/sw.js`) from `"1.58"` to `"1.59"`, in the same commit as the code change.
- Test command: `TZ=Europe/Paris npm test` (must stay at 122 passing — no new pure function/test expected). Build command: `npm run build`.

---

### Task 1: Debug-mode flag, tab-switch logging, and Préférences toggles

**Files:**
- Modify: `src/services/diagnostics.js`
- Modify: `src/App.jsx` (import line, `switchTab()`, `PrefsTab()`, `ObserverPrefsTab()`)
- Modify: `src/config.js`, `public/sw.js` (version bump)

**Interfaces:**
- Produces: `isDebugMode(): boolean` and `setDebugMode(on: boolean): void`, exported from `src/services/diagnostics.js`. Both are used only within this task (no later task consumes them).

- [ ] **Step 1: Add debug-mode state to `diagnostics.js`**

In `src/services/diagnostics.js`, find the constants block near the top:

```js
const MAX_LOGS = 300; // dernières actions conservées
const MAX_ERRORS = 50; // dernières erreurs conservées
const RETRY_KEY = "duvia_bugreport_retry";
```

Add a new constant and the debug-mode state right after it:

```js
const MAX_LOGS = 300; // dernières actions conservées
const MAX_ERRORS = 50; // dernières erreurs conservées
const RETRY_KEY = "duvia_bugreport_retry";
const DEBUG_MODE_KEY = "duvia_debug_mode";

// ── Mode debug (opt-in) ───────────────────────────────────────────────────
// Désactivé par défaut. Une fois activé (Préférences), logAction() reçoit
// des appels supplémentaires (ex: changements d'onglet) qui seraient sinon
// silencieux — voir switchTab() dans App.jsx. Se désactive automatiquement
// après le prochain rapport de bug envoyé avec succès (submitBugReport).
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

- [ ] **Step 2: Auto-disable debug mode after a successful bug report**

In `src/services/diagnostics.js`, find `submitBugReport`:

```js
export async function submitBugReport({ comment, screenshot, context }) {
  const report = buildReport({ comment, screenshot: screenshot || null, context });
  const { error } = await supabase.from("bug_reports").insert(report);
  if (error) {
    // Échec → conserver pour réessai (sans la capture, trop lourde pour localStorage).
    try { window.localStorage.setItem(RETRY_KEY, JSON.stringify({ ...report, screenshot: null })); } catch { /* noop */ }
    throw error;
  }
  try { window.localStorage.removeItem(RETRY_KEY); } catch { /* noop */ }
  logAction("bug_report_sent", { hasScreenshot: !!screenshot });
  return true;
}
```

Add `setDebugMode(false);` right before the final `return true;` (after the success path is fully established, so a thrown error above never reaches it):

```js
export async function submitBugReport({ comment, screenshot, context }) {
  const report = buildReport({ comment, screenshot: screenshot || null, context });
  const { error } = await supabase.from("bug_reports").insert(report);
  if (error) {
    // Échec → conserver pour réessai (sans la capture, trop lourde pour localStorage).
    try { window.localStorage.setItem(RETRY_KEY, JSON.stringify({ ...report, screenshot: null })); } catch { /* noop */ }
    throw error;
  }
  try { window.localStorage.removeItem(RETRY_KEY); } catch { /* noop */ }
  logAction("bug_report_sent", { hasScreenshot: !!screenshot });
  setDebugMode(false);
  return true;
}
```

- [ ] **Step 3: Import the new functions in `App.jsx`**

In `src/App.jsx`, find this exact import line (currently at line 13):

```js
import { initDiagnostics, retryPendingReport, submitBugReport, captureScreenshot } from "./services/diagnostics";
```

Replace it with:

```js
import { initDiagnostics, retryPendingReport, submitBugReport, captureScreenshot, logAction, isDebugMode, setDebugMode } from "./services/diagnostics";
```

- [ ] **Step 4: Log tab switches when debug mode is on**

In `src/App.jsx`, find this exact line (currently line 3430):

```js
  function switchTab(i){ tabDir.current = i > tab ? "right" : "left"; setTab(i); }
```

Replace it with:

```js
  function switchTab(i){
    tabDir.current = i > tab ? "right" : "left";
    setTab(i);
    if (isDebugMode()) logAction("tab_switch", { tab: TABS[i]?.label || i });
  }
```

(`TABS` is declared later in this same component body, around line 4393 — `const TABS = (isObs && !isAdm) ? [...] : ...`. This is safe: `switchTab` is only ever *invoked* from a later render's click handlers, by which point `TABS` already holds its value for that render. Do not move or duplicate the `TABS` declaration.)

- [ ] **Step 5: Add the "Mode debug" toggle to `PrefsTab`**

In `src/App.jsx`, inside `function PrefsTab()` (starts at line 6812), find the state declarations block that starts with:

```js
  const [customerId, setCustomerId] = useState("");
  const [cidCopied,  setCidCopied]  = useState(false);
  // ── 2FA (double authentification) ──────────────────────────────────────
```

Insert a new state line right before the `// ── 2FA` comment:

```js
  const [customerId, setCustomerId] = useState("");
  const [cidCopied,  setCidCopied]  = useState(false);
  const [debugMode, setDebugModeState] = useState(isDebugMode);
  // ── 2FA (double authentification) ──────────────────────────────────────
```

Then find this exact block near the end of the "🔒 Sécurité" section (the 2FA block's closing lines, currently at lines 7358-7359):

```js
        )}
      </div>

      {/* ── Sauvegarde des données (.duvia) ── */}
```

Replace it with (inserting the new toggle between the 2FA block and the section's closing `</div>`):

```js
        )}
        <div style={{height:1,background:C.bor,margin:"12px 0"}}/>
        <label style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer",padding:"13px 16px",background:C.sur,borderRadius:12,border:`1px solid ${C.bor}`}}>
          <input type="checkbox" checked={debugMode} onChange={e=>{ setDebugMode(e.target.checked); setDebugModeState(e.target.checked); }}
            style={{width:16,height:16,marginTop:2,accentColor:C.vio,cursor:"pointer"}} />
          <div>
            <div style={{fontSize:13,fontWeight:700,color:C.txt}}>🐞 {t.debugModeLabel||"Mode debug"}</div>
            <div style={{fontSize:11,color:C.mut,marginTop:2,lineHeight:1.4}}>{t.debugModeDesc||"Enregistre les changements d'écran pour aider à diagnostiquer un bug. Se désactive automatiquement après l'envoi du prochain rapport."}</div>
          </div>
        </label>
      </div>

      {/* ── Sauvegarde des données (.duvia) ── */}
```

- [ ] **Step 6: Add the same "Mode debug" toggle to `ObserverPrefsTab`**

In `src/App.jsx`, inside `function ObserverPrefsTab()` (starts at line 7451), find its state declarations block — it mirrors `PrefsTab`'s, with a `// ── 2FA (double authentification) ──` comment preceded by a `useState` line for `customerId`/`cidCopied` (same pattern as Step 5, same variable names). Insert the identical new state line right before that comment:

```js
  const [debugMode, setDebugModeState] = useState(isDebugMode);
  // ── 2FA (double authentification) ──────────────────────────────────────
```

Then find this exact block near the end of `ObserverPrefsTab`'s "🔒 Sécurité" section (currently at lines 7860-7863):

```js
        )}
      </div>

      {/* ── Supprimer sauvegarde locale (données de secours navigateur) ── */}
```

Replace it with:

```js
        )}
        <div style={{height:1,background:C.bor,margin:"12px 0"}}/>
        <label style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer",padding:"13px 16px",background:C.sur,borderRadius:12,border:`1px solid ${C.bor}`}}>
          <input type="checkbox" checked={debugMode} onChange={e=>{ setDebugMode(e.target.checked); setDebugModeState(e.target.checked); }}
            style={{width:16,height:16,marginTop:2,accentColor:C.vio,cursor:"pointer"}} />
          <div>
            <div style={{fontSize:13,fontWeight:700,color:C.txt}}>🐞 {t.debugModeLabel||"Mode debug"}</div>
            <div style={{fontSize:11,color:C.mut,marginTop:2,lineHeight:1.4}}>{t.debugModeDesc||"Enregistre les changements d'écran pour aider à diagnostiquer un bug. Se désactive automatiquement après l'envoi du prochain rapport."}</div>
          </div>
        </label>
      </div>

      {/* ── Supprimer sauvegarde locale (données de secours navigateur) ── */}
```

- [ ] **Step 7: Add the translation keys**

In `src/i18n/fr.js`, find the existing bug-report keys:

```js
    bugReportScreenshot:"Joindre une capture de l'écran actuel",
    bugReportScreenshotWarn:"La capture peut contenir des infos visibles à l'écran (noms, données). À activer seulement si utile.",
    bugReportScreenshotUnavailable:"indisponible",
```

Add the two new keys right after them:

```js
    bugReportScreenshot:"Joindre une capture de l'écran actuel",
    bugReportScreenshotWarn:"La capture peut contenir des infos visibles à l'écran (noms, données). À activer seulement si utile.",
    bugReportScreenshotUnavailable:"indisponible",
    debugModeLabel:"Mode debug",
    debugModeDesc:"Enregistre les changements d'écran pour aider à diagnostiquer un bug. Se désactive automatiquement après l'envoi du prochain rapport.",
```

(Other languages fall back to these French strings automatically via `t.key || "..."` — no other i18n file needs editing, per this repo's established pattern.)

- [ ] **Step 8: Run the test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `# pass 122` (unchanged — no test touches `diagnostics.js`'s debug-mode state or `switchTab`).

- [ ] **Step 9: Build**

Run: `npm run build`
Expected: build succeeds with no errors (the pre-existing "chunks are larger than 500 kB" warning is expected and unrelated).

- [ ] **Step 10: Manual verification checklist (for the report, not automatable)**

Note in your report that the following still needs a live check by the user after deploy (no browser tooling in this environment):
1. Open Préférences, confirm the "🐞 Mode debug" checkbox appears in the Sécurité section, unchecked by default.
2. Check it, switch between 2-3 tabs, submit a bug report — confirm the received email's "Dernières actions" lists the tab switches.
3. Reopen Préférences — confirm the checkbox is now unchecked again (auto-disabled).
4. Repeat steps 1-3 logged in as an observer/child account (`ObserverPrefsTab`).

- [ ] **Step 11: Bump version**

In `src/config.js`, change:
```js
export const APP_VERSION = "1.58";
```
to:
```js
export const APP_VERSION = "1.59";
```

In `public/sw.js`, change:
```js
const SW_VERSION = "1.58";
```
to:
```js
const SW_VERSION = "1.59";
```

- [ ] **Step 12: Commit**

```bash
git add src/App.jsx src/services/diagnostics.js src/i18n/fr.js src/config.js public/sw.js
git commit -m "$(cat <<'EOF'
Add an opt-in debug mode that logs tab switches for bug reports

logAction() was called from only 2 places in the whole codebase, so a
bug report's "last actions" trail was almost always empty. Adds a
Préférences toggle (off by default, auto-disables after the next bug
report is sent) that logs tab switches while active -- available to
all account types.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** spec's "1. Activation manuelle" → Step 5/6 (toggle, default off). "2. Auto-désactivation" → Step 2. "3. Portée : changements d'onglet" → Step 4. `diagnostics.js` code block → Steps 1-2 (copied verbatim). `App.jsx` code block → Steps 3-4 (copied verbatim). UI Préférences section → Steps 5-6 (both components covered). Test/vérification section → Steps 8-9 (automated) and Step 10 (manual, explicitly called out as non-automatable). Version bump → Step 11.
- **Placeholder scan:** no TBD/TODO; every step has literal code, exact file content, or an exact command.
- **Type consistency:** `isDebugMode`/`setDebugMode` signatures are identical everywhere they're used (diagnostics.js definition, App.jsx import, switchTab, both Prefs components). The local component state is named `debugMode`/`setDebugModeState` in both `PrefsTab` and `ObserverPrefsTab` — deliberately named `setDebugModeState` (not `setDebugMode`) to avoid shadowing the imported `setDebugMode` function from diagnostics.js, since both are used together in the same `onChange` handler.
