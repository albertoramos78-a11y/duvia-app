# Carte info enfant en lecture seule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give observers and children a read-only view of a child's info (school, doctor, emergency contacts, notes, allergy, blood type, birthdate) via a new icon in the app's top header, since they currently have no screen where this data is visible at all.

**Architecture:** Pure client-side addition, no backend/RLS/migration work. A new header icon button (visible only for `isObs||isChild`) opens a new `ChildInfoModal` component that reads `cfg.children` from the existing `useApp()` context — the same unfiltered `cfg` object `ContactsTab` already uses for these roles. A small pure helper (`formatChildBirthdate`) is extracted to `src/utils/core.js` per this repo's convention for testable logic, since the exact `JJ/MM` formatting already exists inline in one place (PDF export) and this plan adds a second call site.

**Tech Stack:** React (single-file `src/App.jsx`), `src/utils/core.js` pure helpers + `node --test` (`src/utils/core.test.js`), i18n via `src/i18n/{fr,en,de,es,pt}.js`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-child-info-card-readonly-design.md` — every requirement in it must map to a task below.
- French (`fr.js`) is the reference language; add the same 2 new keys to `en.js`, `de.js`, `es.js`, `pt.js` too (translate for real, don't leave French copy-pasted into the other 4 — this repo tolerates missing keys via `t.key||"fallback"` but these are new keys with no existing fallback text elsewhere, so they must all be populated).
- No new backend/RLS/migration files — this plan is 100% client-side (confirmed in the spec: `cfg.children` is already unfiltered for observers/children).
- Tests: `TZ=Europe/Paris npm test` must show `104` existing tests still passing plus the new ones from Task 1 (currently 104 total as of the last commit on `main`).
- Build: `npm run build` must succeed with no new errors/warnings beyond the pre-existing chunk-size warning.
- Per `CLAUDE.md`: bump `APP_VERSION` in `src/config.js` and `SW_VERSION` in `public/sw.js` together (same new value) as the final step before committing Task 2 — this is the only task in this plan that ships user-visible app code.
- Icon for the header button: 🧒 (approved in the spec).

---

### Task 1: `formatChildBirthdate` pure helper

**Files:**
- Modify: `src/utils/core.js` (append at end of file, after `isConversationHidden`, currently ending at line 575)
- Modify: `src/utils/core.test.js` (append at end of file, currently ending at line 641)

**Interfaces:**
- Produces: `formatChildBirthdate(birthDay, birthMonth, birthYear)` → `string`. Exported from `src/utils/core.js`. Task 2 imports and calls this with a child object's `birthDay`/`birthMonth`/`birthYear` fields (all stored as strings or `""` on the child object, e.g. `ch.birthDay`, per the existing `StepId` child card at `App.jsx:8040-8058`).

- [ ] **Step 1: Write the failing tests**

Append to `src/utils/core.test.js`:

```js
import { formatChildBirthdate } from "./core.js";

test("formatChildBirthdate : jour et mois présents, pas d'année → JJ/MM", () => {
  assert.strictEqual(formatChildBirthdate("5", "3", ""), "05/03");
});

test("formatChildBirthdate : jour, mois et année présents → JJ/MM/AAAA", () => {
  assert.strictEqual(formatChildBirthdate("5", "3", "2018"), "05/03/2018");
});

test("formatChildBirthdate : déjà sur 2 chiffres, pas de padding en trop", () => {
  assert.strictEqual(formatChildBirthdate("12", "11", "2015"), "12/11/2015");
});

test("formatChildBirthdate : jour manquant → chaîne vide", () => {
  assert.strictEqual(formatChildBirthdate("", "3", "2018"), "");
});

test("formatChildBirthdate : mois manquant → chaîne vide", () => {
  assert.strictEqual(formatChildBirthdate("5", "", "2018"), "");
});

test("formatChildBirthdate : jour et mois manquants → chaîne vide", () => {
  assert.strictEqual(formatChildBirthdate("", "", ""), "");
});

test("formatChildBirthdate : birthDay/birthMonth undefined (enfant tout juste créé) → chaîne vide", () => {
  assert.strictEqual(formatChildBirthdate(undefined, undefined, undefined), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `formatChildBirthdate is not a function` (or similar `TypeError`), 7 new failing tests.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/utils/core.js`:

```js
// Formate la date de naissance d'un enfant en JJ/MM (+ /AAAA si connue), le
// même format que celui déjà utilisé dans l'export PDF de la convention
// (App.jsx, buildAgreementHtml) — extrait ici pour ne pas dupliquer une 3e
// fois cette logique inline (voir ChildInfoModal, App.jsx).
export function formatChildBirthdate(birthDay, birthMonth, birthYear) {
  if (!birthDay || !birthMonth) return "";
  const dd = String(birthDay).padStart(2, "0");
  const mm = String(birthMonth).padStart(2, "0");
  return birthYear ? `${dd}/${mm}/${birthYear}` : `${dd}/${mm}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: PASS — all tests in the file pass, including the 7 new ones (111 total tests in the full suite after this task: 104 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Extract formatChildBirthdate pure helper, with tests

Prep for the read-only child info card (ChildInfoModal): the JJ/MM(/AAAA)
birthdate format already exists inline once (PDF export, App.jsx:12187);
this adds a second call site, so extract it to core.js per this repo's
convention for testable pure logic instead of duplicating it a 3rd time."
```

---

### Task 2: Header button + `ChildInfoModal` + i18n keys

**Files:**
- Modify: `src/App.jsx` (state declaration, header button, new component, render call site, import line)
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js` (2 new keys each)
- Modify: `src/config.js` (`APP_VERSION` bump)
- Modify: `public/sw.js` (`SW_VERSION` bump)

**Interfaces:**
- Consumes: `formatChildBirthdate(birthDay, birthMonth, birthYear)` from Task 1 (`src/utils/core.js`).
- Consumes: `useApp()` context (`App.jsx:2475`) — reads `C`, `t`, `cfg`, and (for the header button only) `isObs`, `isChild`, `isAdm`.
- Produces: nothing consumed by later tasks — this is the final task in the plan.

- [ ] **Step 1: Add the 2 new i18n keys to all 5 languages**

In `src/i18n/fr.js`, after line 677 (`childReadOnly:"(géré par {parent})",`), insert:

```js
    childInfoCardTitle:"🧒 Infos enfant",
    childInfoCardEmpty:"Aucun enfant enregistré pour le moment.",
```

In `src/i18n/en.js`, after line 626 (`childReadOnly:"(managed by {parent})",`), insert:

```js
    childInfoCardTitle:"🧒 Child info",
    childInfoCardEmpty:"No child registered yet.",
```

In `src/i18n/de.js`, after line 624 (`childReadOnly:"(von {parent} verwaltet)",`), insert:

```js
    childInfoCardTitle:"🧒 Kindinfos",
    childInfoCardEmpty:"Noch kein Kind eingetragen.",
```

In `src/i18n/es.js`, after line 624 (`childReadOnly:"(gestionado por {parent})",`), insert:

```js
    childInfoCardTitle:"🧒 Info del niño/a",
    childInfoCardEmpty:"Ningún niño/a registrado todavía.",
```

In `src/i18n/pt.js`, after line 624 (`childReadOnly:"(gerido por {parent})",`), insert:

```js
    childInfoCardTitle:"🧒 Info da criança",
    childInfoCardEmpty:"Nenhuma criança registada por enquanto.",
```

- [ ] **Step 2: Extend the core.js import line in App.jsx**

In `src/App.jsx:23`, the import currently ends with `..., isConsentCharterValid } from './utils/core.js';`. Change it to also import `formatChildBirthdate`:

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName, toggleMessageReaction, isMemberIdentityLocked, toggleGuardId, resolveCustomDateGuardians, guardianStripeBackground, guardianNamesLabel, makeSchoolHolIdentity, isConversationHidden, isConsentCharterValid, formatChildBirthdate } from './utils/core.js';
```

- [ ] **Step 3: Add the `ChildInfoModal` component**

In `src/App.jsx`, immediately after the `InfoBubble` component's closing `}` (currently line 2526, right before the `// ═══ INFO BUBBLE — icône 👋...` banner comment that precedes `StepIdInfoButton` at line 2528), insert:

```js
// ═══════════════════════════════════════════════════════════════════════════════
// CARTE INFO ENFANT (lecture seule) — pour observateurs/enfants, qui n'ont
// pas accès à l'écran Config famille où ces champs vivent normalement.
// Voir docs/superpowers/specs/2026-07-09-child-info-card-readonly-design.md
// ═══════════════════════════════════════════════════════════════════════════════
function ChildInfoModal({onClose}) {
  const {C, t, cfg} = useApp();
  const [selectedChildIdx, setSelectedChildIdx] = useState(0);
  const children = cfg.children || [];
  const ch = children[selectedChildIdx] || children[0] || null;
  const lbl = {fontSize:10,fontWeight:700,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4};
  const val = {fontSize:14,color:C.txt,lineHeight:1.4};
  const fields = ch ? [
    [t.childAllergy, ch.allergy],
    [t.childBloodType, ch.bloodType],
    [t.childSchool, ch.school ?? ch.home?.school],
    [t.childDoctor, ch.doctor ?? ch.home?.doctor],
    [t.childEmergency, ch.emergencyContacts ?? ch.home?.emergencyContacts],
    [t.childNotes, ch.notes ?? ch.home?.notes],
  ].filter(([, v]) => v && String(v).trim()) : [];
  const birthdate = ch ? formatChildBirthdate(ch.birthDay, ch.birthMonth, ch.birthYear) : "";

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.card,borderRadius:16,padding:20,maxWidth:420,width:"100%",maxHeight:"80vh",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexShrink:0}}>
          <div style={{fontSize:16,fontWeight:900,color:C.txt}}>{t.childInfoCardTitle||"🧒 Infos enfant"}</div>
          <button onClick={onClose} style={{width:30,height:30,background:C.sur,border:`1px solid ${C.bor}`,borderRadius:8,color:C.mut,fontSize:14,cursor:"pointer"}}>✕</button>
        </div>
        {children.length === 0 ? (
          <div style={{fontSize:13,color:C.mut,textAlign:"center",padding:"20px 0"}}>{t.childInfoCardEmpty||"Aucun enfant enregistré pour le moment."}</div>
        ) : (
          <div style={{overflowY:"auto",flex:1,display:"flex",flexDirection:"column",gap:14}}>
            {children.length > 1 && (
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {children.map((c,i) => (
                  <button key={i} onClick={()=>setSelectedChildIdx(i)}
                    style={{padding:"6px 12px",borderRadius:20,fontSize:12,fontWeight:700,cursor:"pointer",
                      background:i===selectedChildIdx?C.vio:C.sur,
                      color:i===selectedChildIdx?"#fff":C.txt,
                      border:`1.5px solid ${i===selectedChildIdx?C.vio:C.bor}`}}>
                    {c.name.trim() || `${t.childN} ${i+1}`}
                  </button>
                ))}
              </div>
            )}
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{fontSize:32,width:48,height:48,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:"50%",background:C.sur,flexShrink:0,overflow:"hidden"}}>
                {typeof ch.avatar==="string" && ch.avatar.startsWith("http")
                  ? <img src={ch.avatar} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                  : (ch.avatar || "🧒")}
              </div>
              <div>
                <div style={{fontSize:16,fontWeight:800,color:C.txt}}>{ch.name.trim() || `${t.childN} ${selectedChildIdx+1}`}</div>
                {birthdate && <div style={{fontSize:12,color:C.mut}}>{birthdate}</div>}
              </div>
            </div>
            {fields.map(([label,value],i) => (
              <div key={i}>
                <div style={lbl}>{label}</div>
                <div style={val}>{value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

Note: when `children.length > 0` but the current child has no optional fields filled in (`fields.length === 0`), the modal simply shows the avatar/name/birthdate block with nothing below it — no separate "empty" message is needed there, since `childInfoCardEmpty` is reserved for the family-has-zero-children case above.

- [ ] **Step 4: Add the `showChildInfoModal` state**

In `src/App.jsx`, after line 3208 (`const [showLicenseModal,setShowLicenseModal] = useState(false);`), insert:

```js
  const [showChildInfoModal,setShowChildInfoModal] = useState(false);
```

- [ ] **Step 5: Add the header button**

In `src/App.jsx`, the "Right controls" row closes its 🏆-lots IIFE at line 4410 (`})()}`) and then immediately opens the hamburger button's wrapper `<div style={{position:"relative",flexShrink:0}}>` at line 4411. Insert the new button between them, i.e. right after line 4410 and right before line 4411:

```js
          {(isObs||isChild) && !isAdm && (
            <button onClick={()=>setShowChildInfoModal(true)} title={t.childInfoCardTitle||"Infos enfant"}
              style={{height:36,padding:"0 14px",background:C.card,border:`1.5px solid ${C.bor}`,color:C.txt,fontSize:16,fontWeight:700,borderRadius:20,display:"flex",alignItems:"center",cursor:"pointer",flexShrink:0}}>
              🧒
            </button>
          )}
```

- [ ] **Step 6: Render the modal**

In `src/App.jsx`, the License modal block ends at line 4594 (`})()}`, closing the `{showLicenseModal && (() => { ... })()}` block). Immediately after it, insert:

```js
      {showChildInfoModal && <ChildInfoModal onClose={()=>setShowChildInfoModal(false)} />}
```

- [ ] **Step 7: Build and run the full test suite**

Run: `npm run build`
Expected: succeeds, no new errors (the pre-existing "chunk larger than 500 kB" warning is expected and unrelated).

Run: `TZ=Europe/Paris npm test`
Expected: `111 passing` (104 pre-existing + 7 from Task 1), 0 failing.

- [ ] **Step 8: Manual verification checklist (no automated UI tests in this repo — see CLAUDE.md, `node --test` only covers `src/utils/*.test.js`)**

Describe, for whoever tests this live in the browser (this repo verifies UI changes by hand, not via component tests):
- Logged in as a parent: the 🧒 button must NOT appear in the header.
- Logged in as an observer or a child: the 🧒 button appears in the header, between the 🏆 button and the ☰ menu button.
- Tapping it opens the modal; tapping the ✕ or the dark overlay closes it.
- Family with 0 children: modal shows the `childInfoCardEmpty` message, no crash.
- Family with 1 child: no pill selector shown, card displays directly.
- Family with 2+ children: pill selector shown, switching between children updates the card, selection resets to the first child each time the modal is reopened.
- A child with only some fields filled in (e.g. school but no doctor/notes) shows only the filled-in rows — no empty rows, no placeholder text.
- Existing family data saved before the 2026-07-09 flattening fix (commit `68dde16`, i.e. data still under `ch.home.*` rather than flat `ch.school` etc.) still displays correctly, via the `ch.school ?? ch.home?.school` fallback.

- [ ] **Step 9: Bump the app version**

Per `CLAUDE.md`, increment together in `src/config.js` (`APP_VERSION`) and `public/sw.js` (`SW_VERSION`) — check the current value in `src/config.js` first (it changes with every push, so read it fresh rather than assuming a number) and increment by `0.01`.

- [ ] **Step 10: Commit**

```bash
git add src/App.jsx src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js src/config.js public/sw.js
git commit -m "Add read-only child info card for observers/children

New header icon (🧒, visible only for isObs||isChild) opens ChildInfoModal,
a read-only view of a child's school/doctor/emergency-contacts/notes/
allergy/blood-type/birthdate — data observers and children previously had
no way to see anywhere in the app, since it only lived in the parent-facing
Config famille screen. Pure client-side addition, no backend/RLS changes:
cfg.children was already unfiltered for these roles (same data ContactsTab
already reads). See docs/superpowers/specs/2026-07-09-child-info-card-readonly-design.md."
```
