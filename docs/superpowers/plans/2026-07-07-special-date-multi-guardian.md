# Special Date Multi-Guardian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a custom special date force custody to zero, one, or several people (parents and/or observers marked "peut être gardien"), replacing the current single-parent-only override.

**Architecture:** A new `cd.guardIds: string[]` field (prefixed `p:<id>` / `obs:<id>`) replaces the single `cd.parentId` string going forward, with `parentId` still read as a one-element fallback for old entries. Five pure helpers in `src/utils/core.js` do all the resolution/formatting logic (parsing, resolving to guardian objects, toggling selection, building the CSS stripe gradient, joining names) so `App.jsx` stays thin glue code. Both calendar views (month grid, list) consume the same `resolveCustomDateGuardians` output; 0 guardians = no override (unchanged today), 1 guardian = same single-color override as today but now also supporting an observer, 2+ guardians = a new striped background + joined name label.

**Tech Stack:** React + Vite, `src/utils/core.js` (pure logic), `src/App.jsx` (`StepDates`, month grid, list view), `node --test` for the pure helpers.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-07-07-special-date-multi-guardian-design.md`.
- This is a calendar-**display** change only. Do not touch `resolveGuard()`, expense-split calculations, the week-end summary badge, or `isChangeDay` detection — all of those already read the unmodified `d.guard`, not the custom-date override, and must keep doing so.
- Old entries with `cd.parentId` (no `cd.guardIds`) must keep working — read as `[\`p:${cd.parentId}\`]`. No data migration.
- Observers appear as "Garde chez" options only when `canGuard === true`. Observer color falls back to `C.ora` (existing app-wide convention for observers) since `cfg.observers[].color` is never actually set today.
- No new Premium gating on the guardian-selection buttons (they weren't gated before this change either — only adding a *new* custom date is Premium-gated).
- Tests: `TZ=Europe/Paris npm test` must stay at 100% pass (71/71 as of the last commit on `main`, +10 new tests expected from Task 1 = 81).
- Every task ends with `npm run build` passing. No automated UI test harness exists in this project — verify UI changes with the manual browser check described in each task, on `app.duvia.fr` after pushing (no local `.env` in this environment).
- `node_modules` isn't committed; run `npm install` once if `npm run build`/`npm test` fail with a "command not found" error.

---

### Task 1: Pure helpers in `core.js`

**Files:**
- Modify: `src/utils/core.js`
- Test: `src/utils/core.test.js`

**Interfaces:**
- Produces:
  - `parseGuardId(idStr: string): {type: "parent"|"observer", id: string} | null`
  - `resolveCustomDateGuardians(cd: object, parents: array, observers: array): Array<{type, id, name, color, avatar}>`
  - `toggleGuardId(guardIds: string[]|null|undefined, idStr: string): string[]`
  - `guardianStripeBackground(guardians: array, opacityHex?: string): string | null`
  - `guardianNamesLabel(guardians: array): string`
- Consumed by: Task 2 (`toggleGuardId`, `resolveCustomDateGuardians` indirectly via same shape), Task 3 and Task 4 (all five, via `resolveCustomDateGuardians`, `guardianStripeBackground`, `guardianNamesLabel`).

- [ ] **Step 1: Write the failing tests**

Open `src/utils/core.test.js` first to confirm its exact style (each topic section adds its own `import {...} from "./core.js";` right before its tests — see the `isMemberIdentityLocked` section near the end of the file for the most recent example). Add at the end of the file:

```js
import { parseGuardId, resolveCustomDateGuardians, toggleGuardId, guardianStripeBackground, guardianNamesLabel } from "./core.js";

test("parseGuardId : parent préfixé p:", () => {
  assert.deepEqual(parseGuardId("p:123"), { type: "parent", id: "123" });
});

test("parseGuardId : observateur préfixé obs:", () => {
  assert.deepEqual(parseGuardId("obs:abc-def"), { type: "observer", id: "abc-def" });
});

test("parseGuardId : préfixe inconnu ou vide → null", () => {
  assert.equal(parseGuardId("xyz:1"), null);
  assert.equal(parseGuardId(""), null);
  assert.equal(parseGuardId(null), null);
  assert.equal(parseGuardId(undefined), null);
});

test("resolveCustomDateGuardians : lit guardIds (parent + observateur)", () => {
  const parents = [{ id: 1, name: "Alberto", color: "#0000ff" }, { id: 2, name: "Sissi", color: "#ec4899" }];
  const observers = [{ id: "obs-1", name: "Isa", color: null, canGuard: true }];
  const cd = { guardIds: ["p:2", "obs:obs-1"] };
  const result = resolveCustomDateGuardians(cd, parents, observers);
  assert.deepEqual(result, [
    { type: "parent", id: "2", name: "Sissi", color: "#ec4899", avatar: null },
    { type: "observer", id: "obs-1", name: "Isa", color: null, avatar: null },
  ]);
});

test("resolveCustomDateGuardians : fallback legacy parentId (une seule chaîne, pas de préfixe)", () => {
  const parents = [{ id: 1, name: "Alberto", color: "#0000ff" }];
  const cd = { parentId: "1" };
  const result = resolveCustomDateGuardians(cd, parents, []);
  assert.deepEqual(result, [{ type: "parent", id: "1", name: "Alberto", color: "#0000ff", avatar: null }]);
});

test("resolveCustomDateGuardians : guardIds vide ou absent → tableau vide (calendrier par défaut)", () => {
  assert.deepEqual(resolveCustomDateGuardians({ guardIds: [] }, [], []), []);
  assert.deepEqual(resolveCustomDateGuardians({}, [], []), []);
  assert.deepEqual(resolveCustomDateGuardians(null, [], []), []);
});

test("resolveCustomDateGuardians : id qui ne correspond plus à personne est ignoré silencieusement", () => {
  const parents = [{ id: 1, name: "Alberto", color: "#0000ff" }];
  const cd = { guardIds: ["p:1", "p:999", "obs:ghost"] };
  const result = resolveCustomDateGuardians(cd, parents, []);
  assert.deepEqual(result, [{ type: "parent", id: "1", name: "Alberto", color: "#0000ff", avatar: null }]);
});

test("toggleGuardId : ajoute si absent", () => {
  assert.deepEqual(toggleGuardId(["p:1"], "obs:2"), ["p:1", "obs:2"]);
});

test("toggleGuardId : retire si déjà présent", () => {
  assert.deepEqual(toggleGuardId(["p:1", "obs:2"], "p:1"), ["obs:2"]);
});

test("toggleGuardId : tableau absent traité comme vide", () => {
  assert.deepEqual(toggleGuardId(null, "p:1"), ["p:1"]);
  assert.deepEqual(toggleGuardId(undefined, "p:1"), ["p:1"]);
});

test("guardianStripeBackground : null si moins de 2 gardiens", () => {
  assert.equal(guardianStripeBackground([]), null);
  assert.equal(guardianStripeBackground([{ color: "#ec4899" }]), null);
});

test("guardianStripeBackground : dégradé à bandes égales pour 2 gardiens", () => {
  const result = guardianStripeBackground([{ color: "#ec4899" }, { color: "#0000ff" }]);
  assert.equal(result, "linear-gradient(to right, #ec489940 0%, #ec489940 50%, #0000ff40 50%, #0000ff40 100%)");
});

test("guardianStripeBackground : couleur de repli si un gardien n'a pas de couleur", () => {
  const result = guardianStripeBackground([{ color: null }, { color: "#0000ff" }]);
  assert.equal(result, "linear-gradient(to right, #71717a40 0%, #71717a40 50%, #0000ff40 50%, #0000ff40 100%)");
});

test("guardianNamesLabel : joint les prénoms avec ' + '", () => {
  assert.equal(guardianNamesLabel([{ name: "Sissi" }, { name: "Alberto" }]), "Sissi + Alberto");
});

test("guardianNamesLabel : ignore les entrées sans nom, tableau vide → chaîne vide", () => {
  assert.equal(guardianNamesLabel([{ name: "" }, { name: "Isa" }]), "Isa");
  assert.equal(guardianNamesLabel([]), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `parseGuardId is not a function` (or undefined) on all new tests.

- [ ] **Step 3: Implement the five functions**

Add to the end of `src/utils/core.js`:

```js
// ── Dates personnalisées : garde forcée sur 0, 1 ou plusieurs personnes ──────
// Un id de gardien est une chaîne préfixée : "p:<id_parent>" ou "obs:<id_observateur>".
export function parseGuardId(idStr) {
  if (!idStr || typeof idStr !== "string") return null;
  if (idStr.startsWith("p:")) return { type: "parent", id: idStr.slice(2) };
  if (idStr.startsWith("obs:")) return { type: "observer", id: idStr.slice(4) };
  return null;
}

// Résout cd.guardIds (ou cd.parentId en repli, ancien format à un seul parent)
// en liste de gardiens {type, id, name, color, avatar}, dans l'ordre de
// sélection. Les ids qui ne correspondent plus à personne sont ignorés.
export function resolveCustomDateGuardians(cd, parents, observers) {
  if (!cd) return [];
  const ids = Array.isArray(cd.guardIds) && cd.guardIds.length > 0
    ? cd.guardIds
    : (cd.parentId ? [`p:${cd.parentId}`] : []);
  const result = [];
  for (const idStr of ids) {
    const parsed = parseGuardId(idStr);
    if (!parsed) continue;
    if (parsed.type === "parent") {
      const p = (parents || []).find(pp => String(pp.id) === String(parsed.id));
      if (p) result.push({ type: "parent", id: String(p.id), name: p.name || "", color: p.color || null, avatar: p.avatar || null });
    } else {
      const o = (observers || []).find(oo => String(oo.id) === String(parsed.id));
      if (o) result.push({ type: "observer", id: String(o.id), name: o.name || "", color: o.color || null, avatar: o.avatar || null });
    }
  }
  return result;
}

// Bascule idStr dans/hors du tableau de sélection (ajoute si absent, retire si présent).
export function toggleGuardId(guardIds, idStr) {
  const arr = guardIds || [];
  return arr.includes(idStr) ? arr.filter(x => x !== idStr) : [...arr, idStr];
}

// Dégradé CSS en bandes verticales égales, une par gardien — null si moins de 2
// (dans ce cas l'appelant garde son traitement "couleur pleine" existant pour 0/1).
export function guardianStripeBackground(guardians, opacityHex = "40") {
  if (!guardians || guardians.length < 2) return null;
  const n = guardians.length;
  const stops = [];
  guardians.forEach((g, i) => {
    const color = (g.color || "#71717a") + opacityHex;
    const from = (i / n) * 100;
    const to = ((i + 1) / n) * 100;
    stops.push(`${color} ${from}%`, `${color} ${to}%`);
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

// Joint les prénoms des gardiens avec " + " (ex: "Sissi + Alberto").
export function guardianNamesLabel(guardians) {
  return (guardians || []).map(g => g.name).filter(Boolean).join(" + ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: all tests pass, including the 15 new ones.

- [ ] **Step 5: Run the full suite and build**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 86`, `pass 86`, `fail 0` (71 pre-existing + 15 new).

Run: `npm run build`
Expected: succeeds (this task only touches `core.js`, no App.jsx changes yet, so this is mostly a sanity check).

- [ ] **Step 6: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Add pure helpers for multi-guardian custom special dates"
```

---

### Task 2: `StepDates` — multi-select "Garde chez" with observers

**Files:**
- Modify: `src/App.jsx` — the import line near the top (`from './utils/core.js'`), and the "Garde chez" block inside `StepDates` (~line 8843-8855).

**Interfaces:**
- Consumes: `toggleGuardId` (Task 1).
- Produces: `cd.guardIds` gets written by user interaction, consumed by Task 3 and Task 4.

- [ ] **Step 1: Add the new imports**

Find the big import line from `./utils/core.js` (already modified many times this project — match whatever the current full list is and just append the four names below; do not remove any existing imported name):

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName, toggleMessageReaction, isMemberIdentityLocked } from './utils/core.js';
```

Replace with (append at the end of the destructured list):

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName, toggleMessageReaction, isMemberIdentityLocked, toggleGuardId, resolveCustomDateGuardians, guardianStripeBackground, guardianNamesLabel } from './utils/core.js';
```

- [ ] **Step 2: Replace the single-select "Garde chez" block**

Find (inside `StepDates`, the custom-date card, currently single-parent-only):

```jsx
              {/* Which parent */}
              <div className="field">
                <label className="lbl">👤 {t.cdCustodyAt||"Garde chez"}</label>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {parents.map((p,pIdx)=>(
                    <button key={p.id} onClick={()=>updCd("parentId",String(p.id))} style={{flex:1,minWidth:80,padding:"9px",background:cd.parentId===String(p.id)?p.color:C.sur,color:cd.parentId===String(p.id)?"#fff":C.mut,border:`2px solid ${cd.parentId===String(p.id)?p.color:C.bor}`,borderRadius:10,fontSize:13,fontWeight:800,display:"flex",alignItems:"center",gap:6,justifyContent:"center"}}>
                      {p.avatar&&(typeof p.avatar==="string"&&p.avatar.startsWith("http")
                        ? <img src={p.avatar} alt="" style={{width:22,height:22,borderRadius:"50%",objectFit:"cover",verticalAlign:"middle"}} />
                        : <span style={{fontSize:18}}>{p.avatar}</span>)}{p.name||`${t.parentN||"Parent"} ${pIdx+1}`}
                    </button>
                  ))}
                </div>
              </div>
```

Replace with:

```jsx
              {/* Garde chez — sélection multiple : parents + observateurs "peut être gardien" */}
              <div className="field">
                <label className="lbl">👤 {t.cdCustodyAt||"Garde chez"}</label>
                {(() => {
                  const guardIds = Array.isArray(cd.guardIds) && cd.guardIds.length>0 ? cd.guardIds : (cd.parentId?[`p:${cd.parentId}`]:[]);
                  const guardOptions = [
                    ...parents.map((p,pIdx)=>({key:`p:${p.id}`, name:p.name||`${t.parentN||"Parent"} ${pIdx+1}`, color:p.color, avatar:p.avatar})),
                    ...(cfg.observers||[]).filter(o=>o.canGuard).map(o=>({key:`obs:${o.id}`, name:o.name||"?", color:o.color||C.ora, avatar:o.avatar})),
                  ];
                  return (
                    <>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        {guardOptions.map(opt=>{
                          const active = guardIds.includes(opt.key);
                          return (
                            <button key={opt.key} onClick={()=>updCd("guardIds", toggleGuardId(guardIds, opt.key))} style={{flex:1,minWidth:80,padding:"9px",background:active?opt.color:C.sur,color:active?"#fff":C.mut,border:`2px solid ${active?opt.color:C.bor}`,borderRadius:10,fontSize:13,fontWeight:800,display:"flex",alignItems:"center",gap:6,justifyContent:"center"}}>
                              {opt.avatar&&(typeof opt.avatar==="string"&&opt.avatar.startsWith("http")
                                ? <img src={opt.avatar} alt="" style={{width:22,height:22,borderRadius:"50%",objectFit:"cover",verticalAlign:"middle"}} />
                                : <span style={{fontSize:18}}>{opt.avatar}</span>)}{opt.name}
                            </button>
                          );
                        })}
                      </div>
                      {guardIds.length===0 && <div style={{fontSize:11,color:C.mut,fontStyle:"italic",marginTop:6}}>{t.cdDefaultCalendar||"📅 Calendrier par défaut"}</div>}
                    </>
                  );
                })()}
              </div>
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 86`, `pass 86`, `fail 0` (unchanged from Task 1 — this task touches no pure function).

- [ ] **Step 5: Manual check**

On `app.duvia.fr` after pushing (Configuration famille → Dates personnalisées → ouvrir une date existante ou en créer une) : les boutons parents apparaissent comme avant, plus un bouton par observateur ayant "peut être gardien" activé. Cliquer un bouton l'active (fond coloré) ; le recliquer le désactive. Désélectionner tout le monde fait apparaître "📅 Calendrier par défaut". Sélectionner 2+ personnes fonctionne (plusieurs boutons actifs en même temps).

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Add multi-select guardian picker (parents + observers) to custom special dates"
```

---

### Task 3: Month grid view — multi-guardian cell rendering

**Files:**
- Modify: `src/App.jsx` — the `days` computation (~line 10339-10353) and `renderDayCell` (~line 10433-10473), both in the calendar grid component.

**Interfaces:**
- Consumes: `resolveCustomDateGuardians`, `guardianStripeBackground`, `guardianNamesLabel` (Task 1), `cd.guardIds` (Task 2).
- Produces: `d.customGuardians: array` replaces `d.customParent: object|null` on each day object.

- [ ] **Step 1: Replace `customParent` with `customGuardians` in the days computation**

Find:

```js
    const guard=resolveGuard(ds,cfg,activeChildId);
    // Custom date avec parentId → override couleur de la case
    const customParent = (cfg.specialDates?.custom||[]).reduce((found,cd)=>{
      if(!cd.parentId||!cd.day||!cd.month) return found;
      const yearMatch = cd.yearly||!cd.year||+cd.year===y;
      return (+cd.day===day && +cd.month===m+1 && yearMatch) ? (cfg.parents.find(p=>String(p.id)===String(cd.parentId))||null) : found;
    },null);
    return {day,ds,dw,fer,ferName,sco,scoName,specials,isBirthday,guard,customParent,isToday:ds===todayStr,isWE:dw>=5};
```

Replace with:

```js
    const guard=resolveGuard(ds,cfg,activeChildId);
    // Custom date avec guardIds → override garde/couleur de la case (0, 1 ou 2+ personnes)
    const matchingCd = (cfg.specialDates?.custom||[]).reduce((found,cd)=>{
      if(!cd.day||!cd.month) return found;
      const yearMatch = cd.yearly||!cd.year||+cd.year===y;
      return (+cd.day===day && +cd.month===m+1 && yearMatch) ? cd : found;
    },null);
    // Repli de couleur ici (pas dans core.js, qui n'a pas accès au thème C) :
    // un observateur sans couleur propre (cfg.observers[].color n'est jamais
    // renseigné aujourd'hui) doit quand même ressortir en orange, comme
    // partout ailleurs où un observateur est représenté dans l'app.
    const customGuardians = matchingCd
      ? resolveCustomDateGuardians(matchingCd, cfg.parents, cfg.observers)
          .map(g=>({...g, color:g.color||(g.type==="observer"?C.ora:C.vio)}))
      : [];
    return {day,ds,dw,fer,ferName,sco,scoName,specials,isBirthday,guard,customGuardians,isToday:ds===todayStr,isWE:dw>=5};
```

- [ ] **Step 2: Update `renderDayCell` to use `customGuardians`**

Find:

```js
  function renderDayCell(d){
    const hasSplit = d.splitBefore && d.splitAfter;
    // Custom date → couleur de fond du parent concerné (override garde normale)
    const customBg = d.customParent?.color ? d.customParent.color+"40" : null;
    const bg = customBg || (hasSplit
```

Replace with:

```js
  function renderDayCell(d){
    const hasSplit = d.splitBefore && d.splitAfter;
    // Custom date → override couleur de la case (1 personne = teinte pleine, 2+ = bandes)
    const customStripes = guardianStripeBackground(d.customGuardians);
    const customBg = customStripes || (d.customGuardians?.[0]?.color ? d.customGuardians[0].color+"40" : null);
    const bg = customBg || (hasSplit
```

Then find (a few lines below, the cell's `title` attribute):

```js
      <div key={d.ds} onClick={()=>openDay(d.ds)}
        title={d.ferName||d.scoName||d.specials[0]?.label||undefined}
```

Replace with:

```js
      <div key={d.ds} onClick={()=>openDay(d.ds)}
        title={(d.customGuardians?.length ? guardianNamesLabel(d.customGuardians) : null)||d.ferName||d.scoName||d.specials[0]?.label||undefined}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 86`, `pass 86`, `fail 0`.

- [ ] **Step 5: Manual check**

On `app.duvia.fr`, vue Mois du calendrier : une date personnalisée avec 1 personne sélectionnée colore la case comme avant (et fonctionne maintenant aussi pour un observateur, pas seulement un parent). Une date avec 2+ personnes sélectionnées affiche une case divisée en bandes verticales de couleur. Survoler la case (desktop) montre les prénoms combinés en infobulle.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Render multi-guardian custom dates as striped cells in the month grid"
```

---

### Task 4: List view — multi-guardian row rendering

**Files:**
- Modify: `src/App.jsx` — the list-view day loop (~line 10265-10304), same calendar component as Task 3.

**Interfaces:**
- Consumes: `resolveCustomDateGuardians`, `guardianNamesLabel` (Task 1).
- Produces: nothing consumed further — this is the last task.

- [ ] **Step 1: Replace `_cdList`/`effectiveGuard` computation**

Find:

```js
          const guard=resolveGuard(ds,cfg,activeChildId),wk=wkNum(date),isInl=inlineDs===ds;
          // Custom date → override garde dans la vue liste (même logique que vue grille)
          const _cdList=(cfg.specialDates?.custom||[]).reduce((f,cd)=>{
            if(!cd.parentId||!cd.day||!cd.month) return f;
            const yr=cd.yearly||!cd.year||+cd.year===date.getFullYear();
            return (+cd.day===day && +cd.month===m+1 && yr) ? cd : f;
          },null);
          const effectiveGuard = _cdList
            ? (()=>{ const pi=cfg.parents.findIndex(p=>String(p.id)===String(_cdList.parentId)); return pi>=0?{...guard,parentIdx:pi,allParents:false,obsId:undefined}:guard; })()
            : guard;
```

Replace with:

```js
          const guard=resolveGuard(ds,cfg,activeChildId),wk=wkNum(date),isInl=inlineDs===ds;
          // Custom date → override garde dans la vue liste (même logique que vue grille)
          const _cdList=(cfg.specialDates?.custom||[]).reduce((f,cd)=>{
            if(!cd.day||!cd.month) return f;
            const yr=cd.yearly||!cd.year||+cd.year===date.getFullYear();
            return (+cd.day===day && +cd.month===m+1 && yr) ? cd : f;
          },null);
          // Même repli de couleur que la vue grille (Task 3) — voir ce commentaire là-bas.
          const customGuardians = _cdList
            ? resolveCustomDateGuardians(_cdList, cfg.parents, cfg.observers)
                .map(g=>({...g, color:g.color||(g.type==="observer"?C.ora:C.vio)}))
            : [];
          const effectiveGuard = customGuardians.length===1
            ? (()=>{ const cg=customGuardians[0]; return cg.type==="parent"
                ? {...guard, parentIdx:cfg.parents.findIndex(p=>String(p.id)===String(cg.id)), obsId:undefined, allParents:false}
                : {...guard, obsId:cg.id, parentIdx:undefined, allParents:false}; })()
            : guard;
```

- [ ] **Step 2: Render the multi-guardian row instead of `GuardCell` when 2+ selected**

Find:

```jsx
                <GuardCell guard={effectiveGuard} readOnly={readOnly} isOpen={isInl}
                  onClick={()=>{if(!readOnly){setInlineDs(isInl?null:ds);setFullDs(null);}}}
                  onFull={()=>{if(!editBlocked){setFullDs(ds);setInlineDs(null);}}} />
```

Replace with:

```jsx
                {customGuardians.length>=2 ? (
                  <div style={{display:"flex",alignItems:"center",gap:4,padding:"4px 8px",fontSize:11,fontWeight:700,color:C.txt,minWidth:0}}>
                    {customGuardians.map(g=>(
                      <span key={g.type+g.id} style={{width:8,height:8,borderRadius:"50%",background:g.color||C.mut,flexShrink:0}} />
                    ))}
                    <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{guardianNamesLabel(customGuardians)}</span>
                  </div>
                ) : (
                  <GuardCell guard={effectiveGuard} readOnly={readOnly} isOpen={isInl}
                    onClick={()=>{if(!readOnly){setInlineDs(isInl?null:ds);setFullDs(null);}}}
                    onFull={()=>{if(!editBlocked){setFullDs(ds);setInlineDs(null);}}} />
                )}
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 86`, `pass 86`, `fail 0`.

- [ ] **Step 5: Manual check**

On `app.duvia.fr`, vue Liste du calendrier : une date personnalisée avec 1 personne sélectionnée affiche la même carte de garde qu'avant (fonctionne maintenant aussi pour un observateur). Une date avec 2+ personnes sélectionnées affiche une petite ligne avec un point de couleur par personne et les prénoms joints, à la place de la carte de garde habituelle. Un jour sans date personnalisée (ou sans personne sélectionnée) affiche la garde normale, inchangée.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Render multi-guardian custom dates in the calendar list view"
```
