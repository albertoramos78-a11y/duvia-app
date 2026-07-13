# Calendar Weather Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a parent set their city (via browser geolocation or manual search), and show a one-line "today's weather at the custody-holding parent's home" summary below the month-grid calendar — to help decide what to dress the child in.

**Architecture:** Two new pure functions in `src/utils/core.js` (WMO-code→emoji mapping, forecast-window check). A new `ParentCityField` component in `src/App.jsx` wired into the existing parent config card, storing `city`/`lat`/`lon` on `cfg.parents[i]` via the existing `setParent(i,f,v)` setter — no new migration, this is a plain extension of the existing `cfg` blob shape. A module-level fetch+cache layer (mirrors the existing `OH_CACHE`/`ohCacheKey` pattern for school holidays) calls the free Open-Meteo forecast API, wired into `App()` via a `useEffect` exposed through `useApp()` context as `weatherData`. `CalTab` reads it and renders one summary line under `MonthGridCalendar` using the existing `resolveGuard()` function to find today's custody-holding parent — no changes inside `MonthGridCalendar` itself.

**Tech Stack:** React (`src/App.jsx`), pure JS (`src/utils/core.js`), Open-Meteo REST APIs (forecast + geocoding), `node --test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-calendar-weather-design.md` — read it first.
- Open-Meteo APIs are free, keyless, **non-commercial use only** — acceptable today (Duvia has no active real payments yet), flagged for re-evaluation once Stripe billing (backlog item 22) goes live.
- No reverse geocoding available from Open-Meteo — the "use my location" button stores raw coordinates with a generic label (`📍 Ma position`), not a real city name.
- Weather only shown for **today**, only for the **month-grid view** (`calView==="grid"`) — the list view ("détaillée") is explicitly out of scope for this plan.
- Bump `src/config.js`'s `APP_VERSION` and `public/sw.js`'s `SW_VERSION` together (this changes `App.jsx`).
- `TZ=Europe/Paris npm test` must stay green.
- No automated test can cover live API calls or geolocation — final verification is a manual live test by the user.

---

### Task 1: Add weather helper functions to core.js

**Files:**
- Modify: `src/utils/core.js` (append at end of file)
- Modify: `src/utils/core.test.js` (append new tests, add new names to the existing import block)

**Interfaces:**
- Produces: `weatherIconFor(code: number): {emoji: string, label: string}`, `isWithinForecastWindow(dateStr: string, maxDays?: number): boolean`. Both are pure, no dependencies on other tasks.

- [ ] **Step 1: Write the failing tests**

Add `weatherIconFor` and `isWithinForecastWindow` to the import list at the top of `src/utils/core.test.js`:

```javascript
import {
  toStr, pad,
  validatePassword,
  isValidEmail,
  normalizePhoneDigits, isLikelyPhoneIdentifier, identifierToAuthEmail,
  makeRefCode,
  validateVaultFile,
  makeMsgRateLimiter,
  easterDate, pentecostDate, nthWeekday, sameDay, getMothersDayDate,
  containsBadWord, isCleanText,
  upsertMessageById, addReader,
  insertValidatedParent, reconcileOwnParentSlot, placeholderNameFromEmail,
  weatherIconFor, isWithinForecastWindow,
} from "./core.js";
```

Append at the end of `src/utils/core.test.js`:

```javascript
// ── weatherIconFor / isWithinForecastWindow (backlog 18a — météo calendrier) ──
test("weatherIconFor : code 0 -> ciel clair", () => {
  const w = weatherIconFor(0);
  assert.strictEqual(w.emoji, "☀️");
  assert.strictEqual(w.label, "Ciel clair");
});
test("weatherIconFor : code 61 -> pluie légère", () => {
  const w = weatherIconFor(61);
  assert.strictEqual(w.emoji, "🌧️");
});
test("weatherIconFor : code inconnu -> emoji et label vides", () => {
  const w = weatherIconFor(999);
  assert.strictEqual(w.emoji, "");
  assert.strictEqual(w.label, "");
});

function daysFromNow(n) {
  const d = new Date(Date.now() + n * 86400000);
  return toStr(d);
}
test("isWithinForecastWindow : aujourd'hui -> true", () => {
  assert.strictEqual(isWithinForecastWindow(daysFromNow(0)), true);
});
test("isWithinForecastWindow : hier -> false", () => {
  assert.strictEqual(isWithinForecastWindow(daysFromNow(-1)), false);
});
test("isWithinForecastWindow : dans 15 jours (dans la fenêtre de 16) -> true", () => {
  assert.strictEqual(isWithinForecastWindow(daysFromNow(15)), true);
});
test("isWithinForecastWindow : dans 20 jours (au-delà de 16) -> false", () => {
  assert.strictEqual(isWithinForecastWindow(daysFromNow(20)), false);
});
test("isWithinForecastWindow : fenêtre personnalisée à 3 jours", () => {
  assert.strictEqual(isWithinForecastWindow(daysFromNow(2), 3), true);
  assert.strictEqual(isWithinForecastWindow(daysFromNow(4), 3), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `weatherIconFor is not a function` / `isWithinForecastWindow is not a function`.

- [ ] **Step 3: Implement the functions**

Append to the end of `src/utils/core.js`:

```javascript
// ── Météo calendrier (backlog 18a) ────────────────────────────────────────────
// Codes météo WMO (Open-Meteo) → {emoji, label}. Sous-ensemble couvrant les
// codes réellement documentés par Open-Meteo (0-3, 45-48, 51-67, 71-77, 80-99).
const WMO_WEATHER = {
  0:  { emoji: "☀️",  label: "Ciel clair" },
  1:  { emoji: "🌤️", label: "Peu nuageux" },
  2:  { emoji: "⛅",  label: "Partiellement nuageux" },
  3:  { emoji: "☁️",  label: "Couvert" },
  45: { emoji: "🌫️", label: "Brouillard" },
  48: { emoji: "🌫️", label: "Brouillard givrant" },
  51: { emoji: "🌦️", label: "Bruine légère" },
  53: { emoji: "🌦️", label: "Bruine" },
  55: { emoji: "🌦️", label: "Bruine dense" },
  56: { emoji: "🌧️", label: "Bruine verglaçante" },
  57: { emoji: "🌧️", label: "Bruine verglaçante dense" },
  61: { emoji: "🌧️", label: "Pluie légère" },
  63: { emoji: "🌧️", label: "Pluie" },
  65: { emoji: "🌧️", label: "Pluie forte" },
  66: { emoji: "🌧️", label: "Pluie verglaçante" },
  67: { emoji: "🌧️", label: "Pluie verglaçante forte" },
  71: { emoji: "🌨️", label: "Neige légère" },
  73: { emoji: "🌨️", label: "Neige" },
  75: { emoji: "🌨️", label: "Neige forte" },
  77: { emoji: "🌨️", label: "Grains de neige" },
  80: { emoji: "🌦️", label: "Averses légères" },
  81: { emoji: "🌧️", label: "Averses" },
  82: { emoji: "⛈️",  label: "Averses violentes" },
  85: { emoji: "🌨️", label: "Averses de neige légères" },
  86: { emoji: "🌨️", label: "Averses de neige" },
  95: { emoji: "⛈️",  label: "Orage" },
  96: { emoji: "⛈️",  label: "Orage avec grêle légère" },
  99: { emoji: "⛈️",  label: "Orage avec grêle forte" },
};

export function weatherIconFor(code) {
  return WMO_WEATHER[code] || { emoji: "", label: "" };
}

// dateStr au format "YYYY-MM-DD" (même format que `ds`/toStr() partout ailleurs
// dans ce fichier). true si dateStr tombe entre aujourd'hui inclus et
// aujourd'hui + maxDays exclu (fenêtre de prévision gratuite Open-Meteo : 16
// jours par défaut).
export function isWithinForecastWindow(dateStr, maxDays = 16) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  const diffDays = Math.round((target - today) / 86400000);
  return diffDays >= 0 && diffDays < maxDays;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: all tests pass, including the 8 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Add weather helper functions (WMO icon mapping, forecast window)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Add a city field to each parent's config card

**Files:**
- Modify: `src/App.jsx` — new component `ParentCityField` (place it near `AvatarPicker`, ~line 6718, same file region as other small parent-config sub-components); new "Row 4" in the parent card inside `StepId`, right after the Téléphone/Email row (`App.jsx:~8701-8729`)
- Modify: `src/i18n/fr.js` — new keys

**Interfaces:**
- Consumes: none from Task 1 (independent). Depends on the existing `setParent(i,f,v)` closure already defined in `StepId` (`App.jsx:7953`) and the existing `isMine`/`p`/`i`/`lbl`/`C`/`t` variables already in scope at the parent-card render site.
- Produces: `cfg.parents[i].city` (string, display label), `cfg.parents[i].lat` / `cfg.parents[i].lon` (numbers) — consumed by Task 3's weather-fetch effect.

- [ ] **Step 1: Add i18n keys**

In `src/i18n/fr.js`, in the `// --- i18n additions ---` section, add:
```javascript
    cityLabel:"Ville",
    weatherHint:"pour la météo du calendrier",
    noCitySet:"Non renseignée",
    useMyLocation:"Utiliser ma position",
    searchCity:"Rechercher",
    cityPlaceholder:"Nom de la ville",
    searchBtn:"OK",
    myLocation:"📍 Ma position",
    weatherTodayAt:"Aujourd'hui chez {name}",
    parentFallback:"Parent",
```

- [ ] **Step 2: Add the `ParentCityField` component**

Insert this new function right before `function AvatarPicker({current, onSelect, pool, color}) {` (~`App.jsx:6718`):

```javascript
function ParentCityField({parent, isMine, C, t, onSelect}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  async function doSearch() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setResults([]);
    try {
      const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=fr`);
      const data = await res.json();
      setResults(data?.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function pick(r) {
    const label = [r.name, r.admin1, r.country].filter(Boolean).join(", ");
    onSelect(label, r.latitude, r.longitude);
    setShowSearch(false); setQuery(""); setResults([]);
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { onSelect(t.myLocation||"📍 Ma position", pos.coords.latitude, pos.coords.longitude); setLocating(false); },
      () => { setLocating(false); },
      { timeout: 10000 }
    );
  }

  if (!isMine) {
    return <div style={{fontSize:13,color:parent.city?C.txt:C.mut}}>{parent.city || (t.noCitySet||"Non renseignée")}</div>;
  }

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <div style={{fontSize:13,color:parent.city?C.txt:C.mut}}>{parent.city || (t.noCitySet||"Non renseignée")}</div>
        <button type="button" onClick={useMyLocation} disabled={locating}
          style={{height:26,padding:"0 10px",background:C.sur,border:`1.5px solid ${C.bor}`,borderRadius:16,fontSize:11,fontWeight:700,color:C.txt,cursor:locating?"wait":"pointer"}}>
          {locating ? "…" : `📍 ${t.useMyLocation||"Utiliser ma position"}`}
        </button>
        <button type="button" onClick={()=>setShowSearch(v=>!v)}
          style={{height:26,padding:"0 10px",background:C.sur,border:`1.5px solid ${C.bor}`,borderRadius:16,fontSize:11,fontWeight:700,color:C.txt,cursor:"pointer"}}>
          🔍 {t.searchCity||"Rechercher"}
        </button>
      </div>
      {showSearch && (
        <div style={{marginTop:8}}>
          <div style={{display:"flex",gap:6}}>
            <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()}
              placeholder={t.cityPlaceholder||"Nom de la ville"}
              style={{flex:1,height:32,padding:"0 10px",borderRadius:8,border:`1.5px solid ${C.bor}`,background:C.inp,color:C.txt,fontSize:12,boxSizing:"border-box"}} />
            <button type="button" onClick={doSearch} disabled={searching}
              style={{height:32,padding:"0 12px",borderRadius:8,border:"none",background:C.vio,color:"#fff",fontSize:12,fontWeight:700,cursor:searching?"wait":"pointer"}}>
              {searching ? "…" : (t.searchBtn||"OK")}
            </button>
          </div>
          {results.length > 0 && (
            <div style={{marginTop:6,display:"flex",flexDirection:"column",gap:4}}>
              {results.map((r,idx)=>(
                <button key={idx} type="button" onClick={()=>pick(r)}
                  style={{textAlign:"left",padding:"6px 10px",borderRadius:8,border:`1px solid ${C.bor}`,background:C.card,color:C.txt,fontSize:12,cursor:"pointer"}}>
                  {[r.name, r.admin1, r.country].filter(Boolean).join(", ")}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire it into the parent config card**

Find (`App.jsx:~8701-8729`, immediately after the Téléphone/Email row's closing `</div>`):
```javascript
          {/* Row 3 : Téléphone + Email */}
          <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:0}}>
```
...(existing row content unchanged)...
Immediately after that row's closing `</div>` (right before whatever comes next in the parent card, e.g. the closing of the card or a next section), insert:

```javascript
          {/* Row 4 : Ville (météo calendrier) */}
          <div style={{marginTop:12,...(isMine?{}:lockStyle)}}>
            <span style={lbl}>🏙️ {t.cityLabel||"Ville"} <span style={{color:C.mut,fontWeight:400,fontSize:10}}>({t.weatherHint||"pour la météo du calendrier"})</span></span>
            <ParentCityField parent={p} isMine={isMine} C={C} t={t}
              onSelect={(city,lat,lon)=>{ setParent(i,"city",city); setParent(i,"lat",lat); setParent(i,"lon",lon); }} />
          </div>
```

(If the exact surrounding whitespace/structure differs slightly from this plan due to earlier edits, locate the Téléphone/Email row by its content — `t.contactsPhone` and the Email `<input>` — and insert this new block as a sibling immediately after that row's closing `</div>`, still inside the same parent-card wrapper.)

- [ ] **Step 4: Run the build to check for syntax errors**

Run: `npm run build`
Expected: builds successfully, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/i18n/fr.js
git commit -m "Add a city field to each parent's config card (for calendar weather)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Fetch weather and show today's summary under the calendar grid

**Files:**
- Modify: `src/App.jsx` — new module-level cache + fetch function (near `OH_CACHE`/`ohCacheKey`, ~line 587); new `useEffect` + state inside `App()` (near the existing holiday-fetching effect, ~line 3851-3875); add `weatherData` to `ctxValue` (~line 4483); add the summary line in `CalTab`'s `calView==="grid"` block (~line 11390-11400)
- Modify: `src/config.js` (`APP_VERSION`)
- Modify: `public/sw.js` (`SW_VERSION`)

**Interfaces:**
- Consumes: `weatherIconFor`, `isWithinForecastWindow` from Task 1 (import them in `App.jsx`'s existing `from './utils/core.js'` import line). Consumes `cfg.parents[i].lat/lon` from Task 2.
- Produces: `weatherData` — shape `{ [parentIdx: number]: { [dateStr: string]: {code: number, tempMax: number, tempMin: number} } }`, exposed via `useApp()` context, consumed only by `CalTab` in this plan.

- [ ] **Step 1: Add the fetch+cache layer**

In `src/App.jsx`'s import line from `./utils/core.js`, add `weatherIconFor, isWithinForecastWindow` to the existing named imports.

Right after the existing holiday cache block (`App.jsx:~587-588`, `const OH_CACHE = {}; function ohCacheKey(...) {...}`), add:

```javascript
// In-memory cache: key → { [dateStr]: {code, tempMax, tempMin} }
const WEATHER_CACHE = {};
function weatherCacheKey(lat, lon) { return `${Number(lat).toFixed(2)}|${Number(lon).toFixed(2)}`; }

async function fetchWeatherForecast(lat, lon) {
  const key = weatherCacheKey(lat, lon);
  if (WEATHER_CACHE[key]) return WEATHER_CACHE[key];
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=16`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("weather fetch failed");
  const data = await res.json();
  const days = {};
  (data?.daily?.time || []).forEach((dateStr, idx) => {
    days[dateStr] = {
      code: data.daily.weathercode[idx],
      tempMax: data.daily.temperature_2m_max[idx],
      tempMin: data.daily.temperature_2m_min[idx],
    };
  });
  WEATHER_CACHE[key] = days;
  return days;
}
```

- [ ] **Step 2: Add the fetching effect inside `App()`**

Right after the existing holiday-fetching effect (`App.jsx:~3875`, ends with `}, [cfg.country, cfg.subdivisionCode, cfg.zone]);`), add:

```javascript
  // ─── Météo (Open-Meteo) — une prévision par parent ayant une ville ────────
  const [weatherData, setWeatherData] = useState({});
  const p0lat = cfg.parents?.[0]?.lat, p0lon = cfg.parents?.[0]?.lon;
  const p1lat = cfg.parents?.[1]?.lat, p1lon = cfg.parents?.[1]?.lon;
  useEffect(() => {
    (cfg.parents || []).forEach((p, idx) => {
      if (p?.lat == null || p?.lon == null) return;
      fetchWeatherForecast(p.lat, p.lon)
        .then(days => setWeatherData(w => ({ ...w, [idx]: days })))
        .catch(() => {});
    });
  }, [p0lat, p0lon, p1lat, p1lon]);
  // ─────────────────────────────────────────────────────────────────────────
```

- [ ] **Step 3: Expose `weatherData` via context**

In `ctxValue` (`App.jsx:~4483`, right after `apiData, apiLoading,`), add `weatherData,` on its own or appended to that same line.

- [ ] **Step 4: Render the summary line in `CalTab`**

In `CalTab` (`App.jsx:~10904`), add `weatherData` to the `useApp()` destructure:
```javascript
const {C,t,cfg,setCfg,updateCal: ctxUpdateCal,apiData,weatherData,setMenuTab,setConfigStep,prem,perms,onUpgrade,isObs,isChild,user,sub,addHist,pushNotif,custodyShadow,familySync} = useApp();
```

Find (`App.jsx:~11390-11400`):
```javascript
      {calView==="grid" && (
        <div style={{animation:`calSlideIn${calViewDir.current==="right"?"Right":"Left"} 0.28s cubic-bezier(.22,.68,0,1.2) both`}}>
        <MonthGridCalendar
          y={y} m={m} dc={dc} cfg={cfg} t={t} C={C} apiData={apiData}
          multiChild={multiChild} activeChildId={activeChildId}
          readOnly={readOnly} editBlocked={editBlocked}
          inlineDs={inlineDs} setInlineDs={setInlineDs}
          setFullDs={setFullDs}
        />
        </div>
      )}
```

Replace with (adds the summary line right after `</MonthGridCalendar>`, still inside the same wrapping `<div>`):
```javascript
      {calView==="grid" && (
        <div style={{animation:`calSlideIn${calViewDir.current==="right"?"Right":"Left"} 0.28s cubic-bezier(.22,.68,0,1.2) both`}}>
        <MonthGridCalendar
          y={y} m={m} dc={dc} cfg={cfg} t={t} C={C} apiData={apiData}
          multiChild={multiChild} activeChildId={activeChildId}
          readOnly={readOnly} editBlocked={editBlocked}
          inlineDs={inlineDs} setInlineDs={setInlineDs}
          setFullDs={setFullDs}
        />
        {(() => {
          const todayStr = toStr(new Date());
          if (!isWithinForecastWindow(todayStr)) return null;
          const todayGuard = resolveGuard(todayStr, cfg, activeChildId);
          const pIdx = todayGuard?.parentIdx;
          const wx = (pIdx >= 0 && weatherData?.[pIdx]) ? weatherData[pIdx][todayStr] : null;
          if (!wx) return null;
          const { emoji, label } = weatherIconFor(wx.code);
          const parentName = cfg.parents[pIdx]?.name?.trim() || `${t.parentFallback||"Parent"} ${pIdx+1}`;
          const todayLabel = (t.weatherTodayAt||"Aujourd'hui chez {name}").replace("{name}", parentName);
          return (
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 14px",marginTop:8,background:C.sur,borderRadius:12,fontSize:12,color:C.txt}}>
              <span style={{fontSize:20}}>{emoji}</span>
              <span>{todayLabel} : <strong>{Math.round(wx.tempMax)}°C</strong> — {label}</span>
            </div>
          );
        })()}
        </div>
      )}
```

- [ ] **Step 5: Run the build and test suite**

Run: `npm run build`
Expected: builds successfully.

Run: `TZ=Europe/Paris npm test`
Expected: `pass 130` (122 existing + 8 from Task 1), `fail 0`.

- [ ] **Step 6: Bump the version**

In `src/config.js`, increment `APP_VERSION` by 0.01 from its current value.
In `public/sw.js`, set `SW_VERSION` to the same new value.

- [ ] **Step 7: Commit and push**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Show today's weather under the month-grid calendar

Fetches a 16-day forecast per parent (Open-Meteo, free, keyless) once
they've set a city, and shows a one-line summary — today's weather at
whichever parent has custody today — under the grid view. Helps decide
what to dress the child in. List view and per-day-in-grid icons
deliberately out of scope (grid cells are already crowded).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 8 (manual, user only): Live-test**

1. As each of 2 parent test accounts, set a city on the "Ville" field — one via "Utiliser ma position" (grant the browser permission), one via "Rechercher" (type a city name, pick a result).
2. Open the calendar in grid view (☰ "Mois" toggle) — confirm the summary line appears under the grid with today's weather, showing the name of whichever parent has custody today.
3. Confirm the line does **not** appear if neither parent has a city set (test with a fresh family with no cities configured).
