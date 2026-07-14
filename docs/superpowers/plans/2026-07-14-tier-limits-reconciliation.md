# Tier Limits Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `getPerms()`'s numeric plan limits and three previously-ungated features (weather, messaging, observer "peut être gardien") in line with the user's confirmed Freemium/Trial/Premium reference grid, and fix the marketing/error copy that would otherwise contradict the new numbers.

**Architecture:** All numeric caps (`maxObservers`, `maxChildren`, `maxStorageMB`) are already consumed generically by existing index-based lock overlays and quota-error messages — changing the constants in `getPerms()` (`App.jsx:318-348`) is sufficient, no new enforcement mechanism needed, including for the just-shipped observer-quota RPC path (`familyMaxObservers()` already calls `getPerms(bestParentSub).maxObservers` dynamically). The three newly-gated features each get a new boolean `getPerms()` field and a locked-state render at their own call site, reusing this codebase's existing lock-UI conventions (dashed-border upgrade button, or full-tab blur overlay) rather than inventing new visual patterns.

**Tech Stack:** React (`src/App.jsx` only, no new files, no Supabase changes).

## Global Constraints

- Reference grid (all confirmed by the user, see `docs/superpowers/specs/2026-07-14-tier-limits-reconciliation-design.md`): `maxObservers` 0/2/5, `maxChildren` 1/2/5, `maxStorageMB` 0/50/200 (Freemium/Trial/Premium respectively). Weather, messaging, and observer "peut être gardien" are off in Freemium, on in Trial and Premium.
- A pre-existing observer/child already over a NEW (lower) limit is NOT deleted — the existing index-based lock-overlay behavior (already shipped for both children and observers) applies automatically once the constant changes; no new grandfathering logic needed or wanted (explicit product decision).
- Children do NOT get a real own-session access block the way observers do (no RPC/gate architecture for children) — only the existing parent-side config-screen lock applies, with the new number. Do not build a child-side equivalent of `get_family_billing_context`.
- `maxCustomDates` is unchanged (the grid only specifies on/off for that row, already correct).
- `TZ=Europe/Paris npm test` must stay green (136 tests — no new pure logic is added by this plan, so no new tests are required) after every task.
- `npm run build` must succeed after every task.
- Bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) together by +0.01 only in the FINAL task.
- The current version at plan start is **v1.81**.

---

### Task 1: Numeric plafonds + copy corrections

**Files:**
- Modify: `src/App.jsx` (`getPerms()` at `App.jsx:318-348`; four copy strings at `App.jsx:9145`, `App.jsx:12665`, `App.jsx:15112`, `App.jsx:15113`, `App.jsx:15131`)

**Interfaces:**
- Consumes: nothing new — this task only changes existing constants/strings.
- Produces: `getPerms().maxObservers`/`.maxChildren`/`.maxStorageMB`/`.maxVaultSizeGB` now return the new values; every existing consumer (the index-based lock overlays for children `App.jsx:8998`/observers `App.jsx:10805`, `addChild()` `App.jsx:8352`, the vault quota message `App.jsx:12665`, `familyMaxObservers()` in the observer-quota RPC path) picks these up automatically with no changes of their own.

- [ ] **Step 1: Update the three numeric fields in `getPerms()`**

Current code (`App.jsx:325`, `App.jsx:335`, `App.jsx:343-344`):
```js
    maxChildren:   isFree?1:isTrial?2:Infinity,
```
```js
    maxObservers:  isPremium?Infinity:1,
```
```js
    maxStorageMB:   isPremium ? 500 : isTrial ? 50 : 5,   // Stockage total : Premium 500 Mo · Trial 50 Mo · Freemium 5 Mo
    maxVaultSizeGB: isPremium ? 500/1024 : isTrial ? 50/1024 : 5/1024, // dérivé de maxStorageMB
```

Replace with:
```js
    maxChildren:   isFree?1:isTrial?2:5,
```
```js
    maxObservers:  isFree?0:isTrial?2:5,
```
```js
    maxStorageMB:   isPremium ? 200 : isTrial ? 50 : 0,   // Stockage total : Premium 200 Mo · Trial 50 Mo · Freemium 0 Mo
    maxVaultSizeGB: isPremium ? 200/1024 : isTrial ? 50/1024 : 0, // dérivé de maxStorageMB
```

(Leave every other line in `getPerms()` — `maxParents`, `sameGuardAll`, `zoneChoice`, `feteMere`, `fetePere`, `birthParents`, `birthChildren`, `customDates`, `maxCustomDates`, `customGuard`, `calendarEdit`, `scheduleAdd`, `expenseAdd`, `refundAdd`, `balanceVisible`, `contactAdd`, `maxVaultDocs`, `canSpin`, `spinWinSub` — completely untouched; the grid confirmed these are already correct.)

- [ ] **Step 2: Fix the child-lock overlay copy**

Current code (`App.jsx:9145`):
```jsx
                <div style={{fontSize:11,color:C.mut,marginBottom:8}}>{i===1?"Trial Premium : jusqu'à 2 enfants":"Premium : enfants illimités"}</div>
```
Replace with:
```jsx
                <div style={{fontSize:11,color:C.mut,marginBottom:8}}>{i===1?"Trial Premium : jusqu'à 2 enfants":"Premium : jusqu'à 5 enfants"}</div>
```

- [ ] **Step 3: Fix the vault quota-error copy**

Current code (`App.jsx:12665`):
```jsx
            setAttErr(`Quota atteint (${usedMB} Mo / ${perms.maxStorageMB} Mo). ${!prem?"Passez en Premium pour 500 Mo.":"Supprimez des fichiers pour libérer de l'espace."}`);
```
Replace with:
```jsx
            setAttErr(`Quota atteint (${usedMB} Mo / ${perms.maxStorageMB} Mo). ${!prem?"Passez en Premium pour 200 Mo.":"Supprimez des fichiers pour libérer de l'espace."}`);
```

- [ ] **Step 4: Fix the pricing page (`PremiumTab`) feature list**

Current code (`App.jsx:15112-15131`, three lines within the same `items` array — find each by its exact current text, they are not contiguous with each other in this range):
```js
    {icon:"👥", label:"2 parents · 1 enfant (Trial : 2, Premium : illimité)", badge:"free"},
    {icon:"👁️", label:"Observateurs (1 en Trial/Gratuit → illimité en Premium)", badge:"premium"},
```
and, a few lines later in the same array:
```js
    {icon:"🔐", label:"Coffre-fort illimité — 1 Go",            badge:"premium"},
```

Replace with:
```js
    {icon:"👥", label:"2 parents · 1 enfant (Trial : 2, Premium : 5)", badge:"free"},
    {icon:"👁️", label:"Observateurs (0 Freemium, 2 Trial, 5 Premium)", badge:"trial"},
```
and:
```js
    {icon:"🔐", label:"Coffre-fort — 200 Mo",            badge:"premium"},
```

(The observer row's badge changes from `"premium"` back to `"trial"` since Trial now genuinely unlocks more than 0 — 2 — matching the badge legend's own convention, "trial" = unlocks starting at Trial/Bêta, seen elsewhere in this same `items` array, e.g. `{icon:"🌸", label:"Fête des mères / des pères", badge:"trial"}`.)

- [ ] **Step 5: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 136`, `pass 136`, `fail 0`.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: build succeeds, no new warnings beyond the pre-existing chunk-size notice.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "Reconcile Freemium/Trial/Premium numeric limits with the confirmed grid"
```

---

### Task 2: Gate weather behind Trial/Premium

**Files:**
- Modify: `src/App.jsx` (`getPerms()` at `App.jsx:318-348`; `CalTab`'s weather block at `App.jsx:11634-11642`)

**Interfaces:**
- Consumes: `perms` and `onUpgrade`, both already destructured from `useApp()` at the top of `CalTab` (`App.jsx:11163`) — no new prop threading needed.
- Produces: new `getPerms().weatherEnabled` boolean field.

- [ ] **Step 1: Add the new field to `getPerms()`**

Insert as a new line inside the returned object, anywhere among the other boolean fields (e.g. right after the `customGuard:   !isFree,` line, `App.jsx:334`):
```js
    weatherEnabled: !isFree,
```

- [ ] **Step 2: Gate the weather block in `CalTab`**

Current code (`App.jsx:11634-11642`):
```jsx
      {!isObs && !isChild && (
        <div style={{marginBottom:8}}>
          <ParentCityField isMine={true} C={C} t={t} familyId={familySync?.familyId}
            onLocationChange={(loc)=>{ fetchMyWeatherForecast(loc.lat, loc.lon).then(setMyForecast).catch(()=>{}); }} />
        </div>
      )}
      {myForecast.length > 0 && (
```

Replace with:
```jsx
      {!isObs && !isChild && (
        <div style={{marginBottom:8}}>
          {perms?.weatherEnabled ? (
            <ParentCityField isMine={true} C={C} t={t} familyId={familySync?.familyId}
              onLocationChange={(loc)=>{ fetchMyWeatherForecast(loc.lat, loc.lon).then(setMyForecast).catch(()=>{}); }} />
          ) : (
            <button type="button" onClick={onUpgrade}
              style={{width:"100%",height:36,padding:"0 14px",background:`${C.vio}11`,color:C.vio,border:`1.5px dashed ${C.vio}`,borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",textAlign:"left"}}>
              🔒 Météo — Plan supérieur requis
            </button>
          )}
        </div>
      )}
      {perms?.weatherEnabled && myForecast.length > 0 && (
```

(Only the `myForecast.length > 0` condition's line gains the `perms?.weatherEnabled &&` prefix — everything inside that block, starting from `<div style={{display:"flex",gap:8,...` on the next line, is unchanged.)

- [ ] **Step 3: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 136`, `pass 136`, `fail 0`.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Gate the calendar weather strip behind Trial/Premium"
```

---

### Task 3: Gate messaging behind Trial/Premium

**Files:**
- Modify: `src/App.jsx` (`getPerms()` at `App.jsx:318-348`; `MessagingTab` at `App.jsx:15556` — destructuring line and a new early return)

**Interfaces:**
- Consumes: `useApp()`'s `prem` and `onUpgrade` (not currently destructured in `MessagingTab` — must be added to its destructuring line).
- Produces: new `getPerms().messagingEnabled` boolean field (defined for consistency with the other two new flags, but `MessagingTab`'s own lock check uses the simpler existing `prem` boolean directly — same value, matching how `NotifTab`'s analogous full-tab lock at `App.jsx:6672` already does `if(!prem) return (...)` rather than going through `perms`).

- [ ] **Step 1: Add the new field to `getPerms()`** (for consistency/documentation — not directly consumed by Step 3 below, which uses `prem`)

Insert as a new line inside the returned object, right after the `weatherEnabled: !isFree,` line added in Task 2:
```js
    messagingEnabled: !isFree,
```

- [ ] **Step 2: Add `prem`/`onUpgrade` to `MessagingTab`'s destructuring**

Current code (`App.jsx:15557`):
```jsx
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,reactToCloudMessage,deleteCloudMessage,myUid,uidToLocal,localToUid,emailToUid,familySync,isChild,isObs,hiddenConvs,hideConversation}=useApp();
```
Replace with:
```jsx
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,reactToCloudMessage,deleteCloudMessage,myUid,uidToLocal,localToUid,emailToUid,familySync,isChild,isObs,hiddenConvs,hideConversation,prem,onUpgrade}=useApp();
```

- [ ] **Step 3: Add the full-tab lock, after every hook call in the component**

`MessagingTab`'s last hook call is the `useEffect` at `App.jsx:15798`:
```jsx
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"});},[currentMsgs.length,view]);

  function _afterSend(toIds){
```

Insert a new block between these two lines (i.e., right after the `useEffect(...)` line, right before the blank line that precedes `function _afterSend`):
```jsx
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"});},[currentMsgs.length,view]);

  if(!prem) return (
    <div style={{textAlign:"center",padding:"48px 20px"}}>
      <div style={{fontSize:40,marginBottom:12}}>💬</div>
      <div style={{fontWeight:900,fontSize:17,marginBottom:8,color:C.txt}}>Messagerie</div>
      <div style={{fontWeight:700,fontSize:14,color:C.ora,marginBottom:8}}>🔒 {t.lockSection}</div>
      <div style={{fontSize:13,color:C.mut,marginBottom:20,lineHeight:1.6}}>{t.lockDesc}</div>
      <button onClick={onUpgrade} style={{height:44,padding:"0 26px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",borderRadius:12,fontSize:15,fontWeight:800}}>{t.upgradeCTA}</button>
    </div>
  );

  function _afterSend(toIds){
```

This exactly mirrors `NotifTab`'s existing full-tab lock pattern at `App.jsx:6672-6680` (same `t.lockSection`/`t.lockDesc`/`t.upgradeCTA` keys, same visual structure) — only the icon (💬 instead of 🔔) and title (hardcoded "Messagerie" instead of `t.tabNotifs`, since no existing i18n key names this tab) differ.

This early return sits after ALL of `MessagingTab`'s hook calls (verified: no `useState`/`useEffect`/`useRef`/`useMemo`/`useCallback` call exists anywhere later in this function) — required per this codebase's hook-ordering rule (a real production crash, commit `db4e532`, came from violating this exact rule elsewhere).

- [ ] **Step 4: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 136`, `pass 136`, `fail 0`.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Gate messaging behind Trial/Premium"
```

---

### Task 4: Gate observer "peut être gardien" behind Trial/Premium

**Files:**
- Modify: `src/App.jsx` (`getPerms()` at `App.jsx:318-348`; `StepAccess`'s invite-form checkbox at `App.jsx:10778-10789`; the active-observer-card checkbox at `App.jsx:10890-10897`)

**Interfaces:**
- Consumes: `prem` and `onUpgrade`, both already destructured at the top of `StepAccess` (`App.jsx:10501`: `const {C,t,cfg,setCfg,pushNotif,prem,perms,onUpgrade,user,familySync,isObs,isChild,addHist} = useApp();`) — no new prop threading needed, both checkboxes live inside this same component.
- Produces: new `getPerms().obsCanGuardEnabled` boolean field (defined for consistency — the two checkboxes below use `prem` directly, same value, matching the convention already established by `App.jsx:9605-9622`'s "même garde pour tous les enfants" toggle, which is also gated by `prem` directly rather than a dedicated named `perms` field).

- [ ] **Step 1: Add the new field to `getPerms()`** (for consistency/documentation)

Insert as a new line inside the returned object, right after the `messagingEnabled: !isFree,` line added in Task 3:
```js
    obsCanGuardEnabled: !isFree,
```

- [ ] **Step 2: Gate the invite-form "Peut être gardien" checkbox**

Current code (`App.jsx:10778-10789`):
```jsx
            <div onClick={()=>setCanGuard(v=>!v)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginBottom:10,background:canGuard?`#f59e0b18`:`${C.sur}`,border:`1.5px solid ${canGuard?"#f59e0b":C.bor}`,borderRadius:10,cursor:"pointer",transition:"all .15s"}}>
              <div style={{width:20,height:20,borderRadius:6,border:`2px solid ${canGuard?"#f59e0b":C.bor}`,background:canGuard?"#f59e0b":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .15s"}}>
                {canGuard&&<span style={{color:"#fff",fontSize:13,fontWeight:900}}>✓</span>}
              </div>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:canGuard?"#f59e0b":C.txt}}>🏠 {t.obsCanGuard||"Peut être gardien"}</div>
                <div style={{fontSize:11,color:C.mut}}>{t.obsCanGuardDesc||"Apparaît dans le calendrier comme option de garde"}</div>
              </div>
            </div>
```
Replace with:
```jsx
            <div onClick={()=>{if(!prem)return onUpgrade();setCanGuard(v=>!v);}} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginBottom:10,background:canGuard?`#f59e0b18`:`${C.sur}`,border:`1.5px solid ${canGuard?"#f59e0b":C.bor}`,borderRadius:10,cursor:"pointer",transition:"all .15s",opacity:prem?1:0.7}}>
              <div style={{width:20,height:20,borderRadius:6,border:`2px solid ${canGuard?"#f59e0b":C.bor}`,background:canGuard?"#f59e0b":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .15s"}}>
                {canGuard&&<span style={{color:"#fff",fontSize:13,fontWeight:900}}>✓</span>}
              </div>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:canGuard?"#f59e0b":C.txt,display:"flex",alignItems:"center",gap:6}}>🏠 {t.obsCanGuard||"Peut être gardien"}{!prem&&<span className="badge" style={{background:`${C.ora}10`,color:C.ora,border:`1px dashed ${C.ora}66`}}>🔒 Réservé Premium</span>}</div>
                <div style={{fontSize:11,color:C.mut}}>{t.obsCanGuardDesc||"Apparaît dans le calendrier comme option de garde"}</div>
              </div>
            </div>
```

- [ ] **Step 3: Gate the active-observer-card "Peut être gardien" checkbox**

Current code (`App.jsx:10890-10897`):
```jsx
          <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",marginTop:10,padding:"10px 14px",borderRadius:10,background:o.canGuard?`#f59e0b18`:`${C.bor}22`,border:`1.5px solid ${o.canGuard?"#f59e0b":C.bor}`,transition:"all .2s"}}>
            <input type="checkbox" checked={!!o.canGuard} onChange={e=>setObsField("canGuard",e.target.checked)}
              style={{width:18,height:18,accentColor:"#f59e0b",cursor:"pointer",flexShrink:0}} />
            <div>
              <div style={{fontSize:13,fontWeight:800,color:o.canGuard?"#f59e0b":C.txt}}>🏠 {t.obsCanGuard||"Peut être gardien"}</div>
              <div style={{fontSize:11,color:C.mut}}>{t.obsCanGuardDesc||"Apparaît dans le calendrier comme option de garde"}</div>
            </div>
          </label>
```
Replace with:
```jsx
          <label style={{display:"flex",alignItems:"center",gap:10,cursor:prem?"pointer":"not-allowed",marginTop:10,padding:"10px 14px",borderRadius:10,background:o.canGuard?`#f59e0b18`:`${C.bor}22`,border:`1.5px solid ${o.canGuard?"#f59e0b":C.bor}`,transition:"all .2s",opacity:prem?1:0.7}} onClick={!prem?onUpgrade:undefined}>
            <input type="checkbox" checked={!!o.canGuard} disabled={!prem} onChange={e=>prem&&setObsField("canGuard",e.target.checked)}
              style={{width:18,height:18,accentColor:"#f59e0b",cursor:prem?"pointer":"not-allowed",flexShrink:0}} />
            <div>
              <div style={{fontSize:13,fontWeight:800,color:o.canGuard?"#f59e0b":C.txt,display:"flex",alignItems:"center",gap:6}}>🏠 {t.obsCanGuard||"Peut être gardien"}{!prem&&<span className="badge" style={{background:`${C.ora}10`,color:C.ora,border:`1px dashed ${C.ora}66`}}>🔒 Réservé Premium</span>}</div>
              <div style={{fontSize:11,color:C.mut}}>{t.obsCanGuardDesc||"Apparaît dans le calendrier comme option de garde"}</div>
            </div>
          </label>
```

- [ ] **Step 4: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 136`, `pass 136`, `fail 0`.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Bump the version**

In `src/config.js`:
```js
export const APP_VERSION = "1.82";
```
In `public/sw.js`:
```js
const SW_VERSION = "1.82";
```

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Gate observer 'peut être gardien' behind Trial/Premium"
```

---

## Post-plan manual verification (not automatable in this environment)

1. Freemium account: confirm the weather strip, messaging tab, and observer "peut être gardien" checkbox (both in the invite form and on an active observer's card) all show a lock/upgrade state; confirm max 1 child and 0 observers (any existing observer shows the already-built lock overlay).
2. Trial account: confirm weather/messaging/canGuard are usable; confirm up to 2 children and 2 observers are allowed, a 3rd of either is locked.
3. Premium account: confirm up to 5 children and 5 observers are allowed, a 6th of either is locked; confirm vault storage error message now says "200 Mo".
4. Confirm the pricing page (`PremiumTab`) shows the corrected numbers for parents/children, observers, and vault storage.
