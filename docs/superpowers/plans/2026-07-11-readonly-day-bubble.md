# Read-Only Day Info Bubble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let children and observers tap a day in the calendar to see a read-only info bubble (who has custody, day badges, time/location/note), instead of taps doing nothing as they do today.

**Architecture:** Extend the existing `InlinePicker` component (already used for parents) with a `readOnly` prop that swaps its editable action row for a single text summary. Re-enable the several `readOnly`-gated click handlers that currently prevent the bubble from ever opening for these roles. No new files, no new state, no new network calls — everything needed is already in props these components already receive.

**Tech Stack:** React (single-file `src/App.jsx`).

## Global Constraints

- New prop name: `readOnly` (boolean, default `false`) on `InlinePicker`.
- Fallback text when a day has no guardian set: exactly `"Non défini"`.
- In `readOnly` mode, `InlinePicker` must render zero interactive elements in its bottom row — no reassignment buttons, no "✕" clear button, no "modifier en détail" button.
- The `EditDay` modal (full edit screen) must remain completely inaccessible to `readOnly` callers — this plan does not touch its render guard.
- `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) must both be bumped from `"1.44"` to `"1.45"` together, per CLAUDE.md.
- Test command: `TZ=Europe/Paris npm test` (122 passing at plan time — no new pure-logic function is added by this feature, so the count should stay 122 after this change). Build command: `npm run build`.

---

### Task 1: Read-only day bubble for children/observers

**Files:**
- Modify: `src/App.jsx` (6 touch points, all detailed below with exact current code and exact replacement)
- Modify: `src/config.js:13` (`APP_VERSION`)
- Modify: `public/sw.js:13` (`SW_VERSION`)

**Interfaces:**
- Consumes: nothing from other tasks (this is the only task).
- Produces: nothing consumed elsewhere (this is the only task).

This task has no automated test — it's a UI rendering change with no new pure-logic function, per the spec's Tests section. Its "test" is: `TZ=Europe/Paris npm test` still shows 122/122 passing (confirms nothing existing broke), `npm run build` succeeds, and a manual read-through of the final code confirms all 6 touch points below are applied correctly (no browser tooling exists in this environment to click-test it — the user will verify live after this ships).

- [ ] **Step 1: Add the `readOnly` prop and read-only rendering branch to `InlinePicker`**

Find this exact block in `src/App.jsx` (currently at line 11287):

```js
function InlinePicker({ds,guard,onClose,onFull,dayInfo}) {
  const {C,t,cfg,updateCal} = useApp();
  const guardianObs=(cfg.observers||[]).filter(o=>o.status==="active"&&o.canGuard);
```

Replace with:

```js
function InlinePicker({ds,guard,onClose,onFull,dayInfo,readOnly=false}) {
  const {C,t,cfg,updateCal} = useApp();
  const guardianObs=(cfg.observers||[]).filter(o=>o.status==="active"&&o.canGuard);
  // 🔧 Résumé texte utilisé uniquement en mode lecture seule (enfants/observateurs) :
  // dérivé du même objet `guard` que la ligne de boutons ci-dessous utilise pour
  // savoir quel bouton est actif — mais ici on affiche juste le nom, sans action.
  const readOnlyGuardLabel = (() => {
    if (guard?.allParents) return cfg.parents.map(p=>p.name).filter(Boolean).join(" & ") || "Non défini";
    if (guard?.obsId) {
      const o = guardianObs.find(o=>String(o.id)===String(guard.obsId));
      return o ? `🏠 ${obsLabel(o)}` : "Non défini";
    }
    if (guard?.parentIdx !== undefined && guard.parentIdx >= 0) {
      const p = cfg.parents[guard.parentIdx];
      return p?.name || `P${guard.parentIdx+1}`;
    }
    return "Non défini";
  })();
```

Now find this exact block (the bottom action row, currently right after the `hasRdv` block):

```js
      <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
        {cfg.parents.map((p,pi)=>(
          <button key={pi} onClick={()=>{updateCal(ds,{parentIdx:pi,obsId:undefined,timeType:"full",startTime:"",endTime:"",location:"",note:""});onClose();}}
            style={{padding:"5px 12px",background:guard?.parentIdx===pi&&!guard?.obsId?p.color:`${p.color}22`,color:guard?.parentIdx===pi&&!guard?.obsId?"#fff":p.color,border:`2px solid ${p.color}`,borderRadius:20,fontSize:13,fontWeight:700}}>
            {p.name||`P${pi+1}`}
          </button>
        ))}
        {guardianObs.map(o=>(
          <button key={o.id} onClick={()=>{updateCal(ds,{parentIdx:undefined,obsId:o.id,obsName:o.name,timeType:"full",startTime:"",endTime:"",location:"",note:""});onClose();}}
            style={{padding:"5px 12px",background:guard?.obsId===o.id?"#f59e0b":"#f59e0b18",color:guard?.obsId===o.id?"#fff":"#f59e0b",border:"2px solid #f59e0b",borderRadius:20,fontSize:13,fontWeight:700}}>
            🏠 {obsLabel(o)}
          </button>
        ))}
        <button onClick={()=>{updateCal(ds,{parentIdx:undefined,obsId:undefined});onClose();}} style={{padding:"5px 10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:20,fontSize:12}}>✕</button>
        {onFull
          ? <button onClick={onFull} style={{padding:"5px 10px",background:"transparent",color:C.vio,border:`1.5px solid ${C.vio}`,borderRadius:20,fontSize:12,marginLeft:"auto"}}>{t.fullEdit}</button>
          : <button disabled style={{padding:"5px 10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:20,fontSize:12,marginLeft:"auto",opacity:.6,cursor:"not-allowed",display:"flex",alignItems:"center",gap:5}}>🔒 {t.fullEdit}</button>
        }
      </div>
    </div>
  );
}
```

Replace with:

```js
      {readOnly ? (
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 2px",fontSize:13,fontWeight:700,color:C.txt}}>
          {t.calWhoHasChild||"Aujourd'hui :"} <span style={{fontWeight:800}}>{readOnlyGuardLabel}</span>
        </div>
      ) : (
      <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
        {cfg.parents.map((p,pi)=>(
          <button key={pi} onClick={()=>{updateCal(ds,{parentIdx:pi,obsId:undefined,timeType:"full",startTime:"",endTime:"",location:"",note:""});onClose();}}
            style={{padding:"5px 12px",background:guard?.parentIdx===pi&&!guard?.obsId?p.color:`${p.color}22`,color:guard?.parentIdx===pi&&!guard?.obsId?"#fff":p.color,border:`2px solid ${p.color}`,borderRadius:20,fontSize:13,fontWeight:700}}>
            {p.name||`P${pi+1}`}
          </button>
        ))}
        {guardianObs.map(o=>(
          <button key={o.id} onClick={()=>{updateCal(ds,{parentIdx:undefined,obsId:o.id,obsName:o.name,timeType:"full",startTime:"",endTime:"",location:"",note:""});onClose();}}
            style={{padding:"5px 12px",background:guard?.obsId===o.id?"#f59e0b":"#f59e0b18",color:guard?.obsId===o.id?"#fff":"#f59e0b",border:"2px solid #f59e0b",borderRadius:20,fontSize:13,fontWeight:700}}>
            🏠 {obsLabel(o)}
          </button>
        ))}
        <button onClick={()=>{updateCal(ds,{parentIdx:undefined,obsId:undefined});onClose();}} style={{padding:"5px 10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:20,fontSize:12}}>✕</button>
        {onFull
          ? <button onClick={onFull} style={{padding:"5px 10px",background:"transparent",color:C.vio,border:`1.5px solid ${C.vio}`,borderRadius:20,fontSize:12,marginLeft:"auto"}}>{t.fullEdit}</button>
          : <button disabled style={{padding:"5px 10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:20,fontSize:12,marginLeft:"auto",opacity:.6,cursor:"not-allowed",display:"flex",alignItems:"center",gap:5}}>🔒 {t.fullEdit}</button>
        }
      </div>
      )}
    </div>
  );
}
```

Note: `t.calWhoHasChild` is used with a hardcoded French fallback (`"Aujourd'hui :"`) exactly like every other `t.xxx||"..."` usage already in this file (see `t.fullEdit` above, which has no fallback because it's already a complete i18n key elsewhere) — no i18n file changes are required for this task; the fallback string covers it, consistent with this repo's documented pattern of incomplete non-French translations (CLAUDE.md: "the code falls back with `t.key || "..."` where a translation is missing").

- [ ] **Step 2: Re-enable `openDay()` for read-only calendars**

Find this exact block in `src/App.jsx` (currently at line 11092):

```js
  function openDay(ds){
    if(readOnly) return;
    setInlineDs(inlineDs===ds?null:ds);
  }
```

Replace with:

```js
  function openDay(ds){
    setInlineDs(inlineDs===ds?null:ds);
  }
```

- [ ] **Step 3: Re-enable the two list-view tap handlers**

Find this exact block in `src/App.jsx` (currently around line 10945-10957):

```js
                {customGuardians.length>=2 ? (
                  <div onClick={()=>{if(!readOnly){setInlineDs(isInl?null:ds);setFullDs(null);}}}
                    style={{display:"flex",alignItems:"center",gap:4,padding:"4px 8px",fontSize:11,fontWeight:700,color:C.txt,minWidth:0,cursor:readOnly?"default":"pointer",borderRadius:8,border:`1.5px solid ${isInl?C.vio:"transparent"}`,background:isInl?`${C.vio}11`:"transparent"}}>
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

Replace with:

```js
                {customGuardians.length>=2 ? (
                  <div onClick={()=>{setInlineDs(isInl?null:ds);setFullDs(null);}}
                    style={{display:"flex",alignItems:"center",gap:4,padding:"4px 8px",fontSize:11,fontWeight:700,color:C.txt,minWidth:0,cursor:"pointer",borderRadius:8,border:`1.5px solid ${isInl?C.vio:"transparent"}`,background:isInl?`${C.vio}11`:"transparent"}}>
                    {customGuardians.map(g=>(
                      <span key={g.type+g.id} style={{width:8,height:8,borderRadius:"50%",background:g.color||C.mut,flexShrink:0}} />
                    ))}
                    <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{guardianNamesLabel(customGuardians)}</span>
                  </div>
                ) : (
                  <GuardCell guard={effectiveGuard} readOnly={readOnly} isOpen={isInl}
                    onClick={()=>{setInlineDs(isInl?null:ds);setFullDs(null);}}
                    onFull={()=>{if(!editBlocked){setFullDs(ds);setInlineDs(null);}}} />
                )}
```

(The `customGuardians.length>=2` branch's own `cursor:readOnly?"default":"pointer"` is changed to always `"pointer"` since it's now always clickable — same reasoning as `openDay`'s cursor, covered in Step 5 for the grid view's equivalent cell.)

- [ ] **Step 4: Re-enable `GuardCell`'s own click handler**

Find this exact line in `src/App.jsx` (currently at line 11237, inside the `GuardCell` component's returned `<div>`):

```js
    <div onClick={readOnly?undefined:onClick} style={{display:"flex",alignItems:"center",justifyContent:"flex-start",gap:7,cursor:readOnly?"default":"pointer",padding:"4px 7px",borderRadius:8,border:`1.5px solid ${isOpen&&(gP||isAllParents||gObs)?borderColor:isOpen?C.vio:"transparent"}`,background:isOpen?`${borderColor}11`:"transparent",transition:"all .15s"}}>
```

Replace with:

```js
    <div onClick={onClick} style={{display:"flex",alignItems:"center",justifyContent:"flex-start",gap:7,cursor:"pointer",padding:"4px 7px",borderRadius:8,border:`1.5px solid ${isOpen&&(gP||isAllParents||gObs)?borderColor:isOpen?C.vio:"transparent"}`,background:isOpen?`${borderColor}11`:"transparent",transition:"all .15s"}}>
```

`GuardCell` still receives and uses its `readOnly` prop elsewhere (the "—" vs `t.whichParent` placeholder text at the bottom of the component, line ~11281) — only this one `onClick`/`cursor` line changes. Do not remove the `readOnly` prop from `GuardCell`'s signature.

- [ ] **Step 5: Render the bubble (in read-only mode) in the list view**

Find this exact line in `src/App.jsx` (currently at line 10959):

```js
              {isInl&&!readOnly&&<InlinePicker ds={ds} guard={guard} onClose={()=>setInlineDs(null)} onFull={!editBlocked?()=>{setFullDs(ds);setInlineDs(null);}:null} />}
```

Replace with:

```js
              {isInl&&<InlinePicker ds={ds} guard={guard} onClose={()=>setInlineDs(null)} onFull={!editBlocked&&!readOnly?()=>{setFullDs(ds);setInlineDs(null);}:null} readOnly={readOnly} />}
```

(`onFull` is now also explicitly gated on `!readOnly` in addition to `!editBlocked` — belt-and-suspenders, since `editBlocked` defaults to `false` and is unrelated to the `readOnly` role gate, so without this the "modifier en détail" button could theoretically appear disabled-but-visible instead of fully absent for a read-only caller. In the `readOnly` branch of `InlinePicker` itself (Step 1) this button is never rendered anyway regardless of `onFull`'s value, but pass the correct value here for consistency.)

- [ ] **Step 6: Render the bubble (in read-only mode) in the grid view**

Find this exact block in `src/App.jsx` (currently at lines 11211-11224, inside `MonthGridCalendar`):

```js
      {inlineDs && !readOnly && (() => {
        const d = days.find(d=>d.ds===inlineDs);
        if(!d) return null;
        const dayInfo = [];
        if(d.fer) dayInfo.push({icon:"📍",label:d.ferName||t.holiday||"Férié",color:C.red});
        if(d.sco) dayInfo.push({icon:"🌿",label:d.scoName||t.vacation||"Vacances",color:C.grn});
        d.specials.forEach(ev=>dayInfo.push({icon:"",label:ev.label,color:ev.color}));
        return (
          <div style={{marginTop:10}}>
            <InlinePicker ds={inlineDs} guard={d.guard} onClose={()=>setInlineDs(null)} dayInfo={dayInfo}
              onFull={!editBlocked?()=>{setFullDs(inlineDs);setInlineDs(null);}:null} />
          </div>
        );
      })()}
```

Replace with:

```js
      {inlineDs && (() => {
        const d = days.find(d=>d.ds===inlineDs);
        if(!d) return null;
        const dayInfo = [];
        if(d.fer) dayInfo.push({icon:"📍",label:d.ferName||t.holiday||"Férié",color:C.red});
        if(d.sco) dayInfo.push({icon:"🌿",label:d.scoName||t.vacation||"Vacances",color:C.grn});
        d.specials.forEach(ev=>dayInfo.push({icon:"",label:ev.label,color:ev.color}));
        return (
          <div style={{marginTop:10}}>
            <InlinePicker ds={inlineDs} guard={d.guard} onClose={()=>setInlineDs(null)} dayInfo={dayInfo}
              onFull={!editBlocked&&!readOnly?()=>{setFullDs(inlineDs);setInlineDs(null);}:null} readOnly={readOnly} />
          </div>
        );
      })()}
```

- [ ] **Step 7: Update the grid cell's cursor styling to always be clickable**

Find this exact line in `src/App.jsx` (currently at line 11140, inside `renderDayCell`'s returned `<div>` style object):

```js
          cursor:readOnly?"default":"pointer",position:"relative",
```

Replace with:

```js
          cursor:"pointer",position:"relative",
```

- [ ] **Step 8: Verify `EditDay`'s render guard is untouched**

Run this check and confirm the output still shows `!readOnly` in the condition (do not edit this line — this step is verification only):

```bash
grep -n "fullDs&&!readOnly&&!editBlocked" src/App.jsx
```

Expected output: one match, at the line containing `{fullDs&&!readOnly&&!editBlocked&&(<div style={{position:"fixed"...`. If this line's condition has changed from what Steps 1-7 describe, stop and report — it means an earlier step accidentally touched code it shouldn't have.

- [ ] **Step 9: Bump the version**

In `src/config.js`, change:
```js
export const APP_VERSION = "1.44";
```
to:
```js
export const APP_VERSION = "1.45";
```

In `public/sw.js`, change:
```js
const SW_VERSION = "1.44";
```
to:
```js
const SW_VERSION = "1.45";
```

- [ ] **Step 10: Run the test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 122`, `pass 122`, `fail 0` (no new tests are added by this task — this confirms nothing existing broke).

- [ ] **Step 11: Build**

Run: `npm run build`
Expected: build succeeds with no errors (the pre-existing chunk-size warning is expected and not a failure).

- [ ] **Step 12: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Add read-only day info bubble for children/observers on the calendar"
git push
```

- [ ] **Step 13: Report manual verification needed**

In your DONE report, explicitly state: "No browser tooling exists in this environment — the user must verify live: as a child or observer account, tap a day in both list view and grid view of the calendar, confirm the bubble opens with the correct guardian name/badges/time/location, confirm a day with a note shows that note (never visible to this role before), and confirm no button in the bubble is clickable (no reassignment, no clear, no 'modifier en détail')."
