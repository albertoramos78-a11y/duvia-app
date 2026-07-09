# Thème licorne Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the already-earnable "licorne" (unicorn) prize into a real, activatable theme — replacing the static "Bientôt" placeholder with a working palette + toggle, matching how the video/summer/RG/WC themes work.

**Architecture:** One new flat color-palette export in `src/theme.js` (no date-gating, mirrors `VIDEO`), plus mirrored edits in `src/App.jsx` everywhere the existing `videoActive` theme is wired — state, theme-resolution priority chain, context, header toggle button, and the Preferences-tab earned-prize row. Two small pre-existing logic bugs (both caused by licorne never having had a real activation state to check against) are fixed in the same pass, since they live in the exact lines this task touches anyway.

**Tech Stack:** React (single-file `src/App.jsx`), `src/theme.js` (plain JS palette objects), i18n via `src/i18n/{fr,en,de,es,pt}.js`. No backend/RLS/tests beyond the existing suite — this feature has no pure logic to extract (same as the other 4 reward themes, none of which have dedicated `core.js` coverage).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-licorne-theme-design.md` — every requirement in it must map to a step below.
- Palette (exact values, from the spec, chosen via visual-companion comparison — "Pastel Doux"): `{ bg:"#fdf2fb",card:"#ffffff",sur:"#fce7f8",bor:"#f0abfc",txt:"#581c62",mut:"#a855c7",inp:"#ffffff",vio:"#c026d3",blu:"#818cf8",grn:"#34d399",yel:"#fbbf24",red:"#fb7185",ora:"#fb923c",pin:"#f472b6",_licorne:true }`.
- No date-gating — licorne is permanently available once earned, like `VIDEO`, unlike `SUMMER`/`RG`/`WC`.
- Mutual exclusivity with the 4 existing themes must be bidirectional: activating licorne turns the other 4 off, and activating any of the other 4 must turn licorne off (the spec calls this out explicitly — the 4 existing buttons must each gain a `setLicorneActive(false)` call).
- French (`fr.js`) is the reference language; the new `wheelLicorneActiveInfo` i18n key must be genuinely translated (not copy-pasted) in `en.js`, `de.js`, `es.js`, `pt.js` too.
- Tests: `TZ=Europe/Paris npm test` must still show all tests passing (111 total — this task adds no new test files, since there's no new pure logic).
- Build: `npm run build` must succeed with no new errors/warnings beyond the pre-existing chunk-size warning.
- Per `CLAUDE.md`: bump `APP_VERSION` in `src/config.js` and `SW_VERSION` in `public/sw.js` together (same new value, `1.30` → `1.31`) as the final step before committing — this is the only task in this plan and it ships user-visible app code.

---

### Task 1: Licorne palette + activation wiring

**Files:**
- Modify: `src/theme.js` (new `LICORNE` export)
- Modify: `src/App.jsx` (import line, state, theme-resolution `useMemo`, `ctxValue`, header toggle button, `hasActivatable`, `EarnedPrizeRow`)
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js` (1 new key each)
- Modify: `src/config.js`, `public/sw.js` (version bump)

**Interfaces:**
- Produces: `LICORNE` (exported palette object from `src/theme.js`), `licorneActive`/`setLicorneActive` (App.jsx local state, also exposed via `ctxValue` for any future consumer, mirroring `videoActive`/`setVideoActive`). Nothing else in this plan consumes these — this is the only task.

- [ ] **Step 1: Add the `LICORNE` palette to `src/theme.js`**

Open `src/theme.js`. After the `VIDEO` line (currently the last theme before the `BRAND` comment block):

```js
export const VIDEO = { bg:"#07071a",card:"#0f0f2a",sur:"#181835",bor:"#5b21b6",txt:"#ede9fe",mut:"#7c6fa0",inp:"#0b0b22",vio:"#8b5cf6",blu:"#06b6d4",grn:"#22c55e",yel:"#fbbf24",red:"#f43f5e",ora:"#fb923c",pin:"#ec4899",_video:true };
```

insert immediately after it:

```js
// ─── THÈME LICORNE ────────────────────────────────────────────────────────────
export const LICORNE = { bg:"#fdf2fb",card:"#ffffff",sur:"#fce7f8",bor:"#f0abfc",txt:"#581c62",mut:"#a855c7",inp:"#ffffff",vio:"#c026d3",blu:"#818cf8",grn:"#34d399",yel:"#fbbf24",red:"#fb7185",ora:"#fb923c",pin:"#f472b6",_licorne:true };
```

No date-gating function (unlike `isRGPeriod`/`isWCPeriod`/`isSummerPeriod`) — licorne has no calendar window.

- [ ] **Step 2: Import `LICORNE` in `App.jsx`**

`src/App.jsx:24` currently reads:

```js
import { DARK, LIGHT, SUMMER, RG, RG_START, RG_END, WC, WC_START, WC_END, SUMMER_START, SUMMER_END, VIDEO, BRAND, PCOLS, isRGPeriod, isWCPeriod, isSummerPeriod } from './theme.js';
```

Change it to also import `LICORNE`:

```js
import { DARK, LIGHT, SUMMER, RG, RG_START, RG_END, WC, WC_START, WC_END, SUMMER_START, SUMMER_END, VIDEO, LICORNE, BRAND, PCOLS, isRGPeriod, isWCPeriod, isSummerPeriod } from './theme.js';
```

- [ ] **Step 3: Add the `licorneActive` state**

`src/App.jsx:3061-3064` currently reads:

```js
  const [summerActive,setSummerActive] = useLocalStorage("duvia_summer", false);
  const [rgActive,setRgActive]         = useLocalStorage("duvia_rg", false);
  const [wcActive,setWcActive]         = useLocalStorage("duvia_wc", false);
  const [videoActive,setVideoActive]   = useLocalStorage("duvia_video", false);
```

Add immediately after line 3064:

```js
  const [licorneActive,setLicorneActive] = useLocalStorage("duvia_licorne", false);
```

- [ ] **Step 4: Wire `licorneActive` into the theme-resolution `useMemo`**

`src/App.jsx:3678-3682` currently reads:

```js
  const C = useMemo(() =>
    videoActive ? VIDEO : wcActive ? WC : rgActive ? RG :
    summerActive ? SUMMER : themeMode==="sombre" ? DARK :
    themeMode==="clair" ? LIGHT : BRAND,
  [videoActive, wcActive, rgActive, summerActive, themeMode]); // ✅ recalculé uniquement si le thème change
```

Replace with:

```js
  const C = useMemo(() =>
    licorneActive ? LICORNE : videoActive ? VIDEO : wcActive ? WC : rgActive ? RG :
    summerActive ? SUMMER : themeMode==="sombre" ? DARK :
    themeMode==="clair" ? LIGHT : BRAND,
  [licorneActive, videoActive, wcActive, rgActive, summerActive, themeMode]); // ✅ recalculé uniquement si le thème change
```

- [ ] **Step 5: Expose `licorneActive`/`setLicorneActive` via `ctxValue`**

`src/App.jsx:4244` currently reads:

```js
    summerActive, setSummerActive, rgActive, setRgActive, wcActive, setWcActive, videoActive, setVideoActive,
```

Change to:

```js
    summerActive, setSummerActive, rgActive, setRgActive, wcActive, setWcActive, videoActive, setVideoActive, licorneActive, setLicorneActive,
```

- [ ] **Step 6: Add `setLicorneActive(false)` to the 4 existing theme toggle buttons**

These 4 buttons must each turn licorne off when the user picks a different theme (bidirectional mutual exclusion — see Global Constraints). Each is a one-line change to the existing `onClick`.

`src/App.jsx:4438` (été/summer button), currently:

```js
                        <button onClick={()=>{setSummerActive(s=>!s);setRgActive(false);setWcActive(false);setVideoActive(false);setShowPrizesMenu(false);}}
```

becomes:

```js
                        <button onClick={()=>{setSummerActive(s=>!s);setRgActive(false);setWcActive(false);setVideoActive(false);setLicorneActive(false);setShowPrizesMenu(false);}}
```

`src/App.jsx:4446` (vidéo button), currently:

```js
                        <button onClick={()=>{setVideoActive(s=>!s);setSummerActive(false);setRgActive(false);setWcActive(false);setShowPrizesMenu(false);}}
```

becomes:

```js
                        <button onClick={()=>{setVideoActive(s=>!s);setSummerActive(false);setRgActive(false);setWcActive(false);setLicorneActive(false);setShowPrizesMenu(false);}}
```

`src/App.jsx:4461` (WC button), currently:

```js
                        <button onClick={()=>{setWcActive(s=>!s);setSummerActive(false);setRgActive(false);setVideoActive(false);setShowPrizesMenu(false);}}
```

becomes:

```js
                        <button onClick={()=>{setWcActive(s=>!s);setSummerActive(false);setRgActive(false);setVideoActive(false);setLicorneActive(false);setShowPrizesMenu(false);}}
```

`src/App.jsx:4469` (RG button), currently:

```js
                        <button onClick={()=>{setRgActive(s=>!s);setSummerActive(false);setWcActive(false);setVideoActive(false);setShowPrizesMenu(false);}}
```

becomes:

```js
                        <button onClick={()=>{setRgActive(s=>!s);setSummerActive(false);setWcActive(false);setVideoActive(false);setLicorneActive(false);setShowPrizesMenu(false);}}
```

- [ ] **Step 6b: Reset `licorneActive` on logout, alongside the other 3 theme states**

`src/App.jsx:3377-3383` resets every theme state to its default when the user logs out, so an activated theme never "leaks" into the next account on a shared device. Currently:

```js
      setSummerActive(false);
      setRgActive(false);
      setWcActive(false);
      setVideoActive(false);
      setThemeMode("palette");
      setShowPrizesMenu(false);
```

Add `setLicorneActive(false);` to this block (position doesn't matter, keep it grouped with the other theme resets):

```js
      setSummerActive(false);
      setRgActive(false);
      setWcActive(false);
      setVideoActive(false);
      setLicorneActive(false);
      setThemeMode("palette");
      setShowPrizesMenu(false);
```

`src/App.jsx:3407` is this effect's dependency array:

```js
  }, [sessionEmail, setSessionEmail, setSummerActive, setRgActive, setWcActive, setVideoActive, setThemeMode, setShowPrizesMenu]); // ✅ tous les setters existent à ce stade
```

Add `setLicorneActive`:

```js
  }, [sessionEmail, setSessionEmail, setSummerActive, setRgActive, setWcActive, setVideoActive, setLicorneActive, setThemeMode, setShowPrizesMenu]); // ✅ tous les setters existent à ce stade
```

- [ ] **Step 7: Replace the static licorne badge with a real toggle button, and fix `hasActivatable`**

`src/App.jsx:4409` currently reads (inside the `hasActivatable` computation, this is the licorne line — note it has no `&& !xActive` check unlike its 4 neighbors, a pre-existing bug):

```js
              ((sub.earnedLicorne||myG.licorne||selfB.licorne)) ||
```

Change to:

```js
              ((sub.earnedLicorne||myG.licorne||selfB.licorne) && !licorneActive) ||
```

`src/App.jsx:4453-4458` currently reads:

```jsx
                      {(sub.earnedLicorne||myG.licorne||sub.earnedSelf_licorne) && (
                        <div style={{padding:"0 14px",height:40,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,color:"#ec4899",background:"#ec489908"}}>
                          <span style={{fontSize:16}}>🦄</span>
                          <span style={{flex:1}}>{t.shopLicorne}{sub.earnedSelf_licorne&&!sub.earnedLicorne?" 🛒":myG.licorne&&!sub.earnedLicorne?" 🎁":""}</span>
                          <span style={{background:"#ec489922",color:"#ec4899",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{t.wheelSoon}</span>
                        </div>
                      )}
```

Replace with:

```jsx
                      {(sub.earnedLicorne||myG.licorne||sub.earnedSelf_licorne) && (
                        <button onClick={()=>{setLicorneActive(s=>!s);setSummerActive(false);setRgActive(false);setWcActive(false);setVideoActive(false);setShowPrizesMenu(false);}}
                          style={{width:"100%",padding:"0 14px",height:40,background:licorneActive?"#ec489915":"#ec489908",color:"#ec4899",textAlign:"left",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                          <span style={{fontSize:16}}>🦄</span>
                          <span style={{flex:1}}>{t.shopLicorne}{sub.earnedSelf_licorne&&!sub.earnedLicorne?" 🛒":myG.licorne&&!sub.earnedLicorne?" 🎁":""}</span>
                          <span style={{background:licorneActive?"#ec489933":"#ec489918",color:"#ec4899",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{licorneActive?t.wheelActiveCheck:t.wheelApply}</span>
                        </button>
                      )}
```

- [ ] **Step 8: Fix the hardcoded "always active" status in the Preferences tab's `EarnedPrizeRow`**

This component reads `videoActive` directly (not via a prop) to show the video row's real status, so it must gain `licorneActive` the same way or Step 8's code below would reference an undefined variable. `src/App.jsx:16674` currently reads:

```js
  const {C,t,sub,setSub,prem,onUpgrade,st,isChild,isObs,isAdm,user,videoActive} = useApp();
```

Change to:

```js
  const {C,t,sub,setSub,prem,onUpgrade,st,isChild,isObs,isAdm,user,videoActive,licorneActive} = useApp();
```

`src/App.jsx:16754-16758` currently reads:

```jsx
            {(sub.earnedLicorne||myGifted.licorne) && (() => {
              const g = !!myGifted.licorne;
              return <EarnedPrizeRow emoji="🦄" label={t.shopLicorne} color="#ec4899"
                info={t.wheelActivateViaMenu} status={t.wheelActive} gift={g} />;
            })()}
```

Replace with (mirroring the vidéo row immediately above it, `App.jsx:16749-16753`, which already does this correctly):

```jsx
            {(sub.earnedLicorne||myGifted.licorne) && (() => {
              const g = !!myGifted.licorne;
              return <EarnedPrizeRow emoji="🦄" label={t.shopLicorne} color="#ec4899"
                info={licorneActive?t.wheelLicorneActiveInfo:t.wheelActivateViaButton} status={licorneActive?t.wheelActiveCheck:t.wheelApply} gift={g} />;
            })()}
```

- [ ] **Step 9: Add the `wheelLicorneActiveInfo` i18n key to all 5 languages**

In `src/i18n/fr.js`, after line 357 (`wheelVideoActiveInfo:"Thème actif · Désactivez via le menu ☰ ou 🏆",`), insert:

```js
    wheelLicorneActiveInfo:"Thème actif · Désactivez via le menu ☰ ou 🏆",
```

In `src/i18n/en.js`, after line 333 (`wheelVideoActiveInfo:"Theme active · Disable via the ☰ menu or 🏆",`), insert:

```js
    wheelLicorneActiveInfo:"Theme active · Disable via the ☰ menu or 🏆",
```

In `src/i18n/de.js`, after line 331 (`wheelVideoActiveInfo:"Design aktiv · Über das ☰ Menü oder 🏆 deaktivieren",`), insert:

```js
    wheelLicorneActiveInfo:"Design aktiv · Über das ☰ Menü oder 🏆 deaktivieren",
```

In `src/i18n/es.js`, after line 331 (`wheelVideoActiveInfo:"Tema activo · Desactívalo desde el menú ☰ o 🏆",`), insert:

```js
    wheelLicorneActiveInfo:"Tema activo · Desactívalo desde el menú ☰ o 🏆",
```

In `src/i18n/pt.js`, after line 331 (`wheelVideoActiveInfo:"Tema ativo · Desative através do menu ☰ ou 🏆",`), insert:

```js
    wheelLicorneActiveInfo:"Tema ativo · Desative através do menu ☰ ou 🏆",
```

- [ ] **Step 10: Build and run the full test suite**

Run: `npm run build`
Expected: succeeds, no new errors (the pre-existing "chunk larger than 500 kB" warning is expected and unrelated).

Run: `TZ=Europe/Paris npm test`
Expected: `111 passing`, 0 failing — unchanged from before this task, since it adds no new test files.

- [ ] **Step 11: Manual verification checklist (no automated UI tests in this repo)**

Describe, for whoever tests this live in the browser:
- As a user with `sub.earnedLicorne` (or `myGifted.licorne`, or `sub.earnedSelf_licorne`) true: open the 🏆 menu in the header — the licorne row is now a clickable button, not a static "Bientôt" badge.
- Tapping it applies the Pastel Doux palette app-wide (soft pink/lavender background, magenta-purple accents) and the row shows "✓ Actif".
- Tapping any of the other 4 theme buttons (été/vidéo/RG/WC — RG/WC only visible during their active periods) while licorne is active switches to that theme and licorne's row reverts to "Appliquer".
- Tapping the licorne button again while active turns it off, reverting to the normal light/dark/palette theme.
- In the Préférences tab's "Mes lots" card, the licorne row's status text matches the header's real state (not hardcoded "Actif ✓" anymore).
- The 🏆 header button's dot indicator (small colored circle signaling "something is activatable") no longer shows when licorne is already active — only when it's earned but not yet turned on.
- With licorne active, log out — the app must NOT still be showing the Pastel Doux palette on the login screen or for the next account that logs in on the same device/browser.

- [ ] **Step 12: Bump the app version**

Per `CLAUDE.md`, increment together in `src/config.js` (`APP_VERSION`) and `public/sw.js` (`SW_VERSION`) — check the current value in `src/config.js` first (it changes with every push) and increment by `0.01` (expected: `1.30` → `1.31`, but verify against the live file rather than assuming).

- [ ] **Step 13: Commit**

```bash
git add src/theme.js src/App.jsx src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js src/config.js public/sw.js
git commit -m "Add real activatable licorne theme, fix 2 pre-existing state bugs

Licorne was earnable via the wheel/shop/gifts like the other 4 reward
themes, but had no real palette or activation state — the header's earned-
prizes menu showed a static 'Bientôt' badge instead of a toggle. Adds the
LICORNE palette (Pastel Doux, no date-gating, permanent like the video
theme), wires licorneActive through the theme-resolution chain with
bidirectional mutual exclusion against the other 4 themes, and fixes 2
bugs the missing state was masking: hasActivatable never checked whether
licorne was already active, and the Préférences tab's EarnedPrizeRow
hardcoded status='Actif ✓' regardless of real state.
See docs/superpowers/specs/2026-07-09-licorne-theme-design.md."
```
