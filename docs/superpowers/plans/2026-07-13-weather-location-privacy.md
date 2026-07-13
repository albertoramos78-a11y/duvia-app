# Weather Location Privacy Fix Implementation Plan

> **For agentic workers:** this plan is executed directly by the controller (not dispatched to subagents), matching this project's established precedent for security-sensitive Supabase work (RLS policies, Edge Functions). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop leaking a parent's home location to other family members. Move `city`/`lat`/`lon` out of the shared `cfg.parents[i]` blob into a dedicated RLS-restricted table, and route all weather lookups through a new Edge Function that never returns raw coordinates to any client.

**Architecture:** New table `parent_locations` (RLS: own row only, no family-wide read policy at all — the key structural difference from every other table in this app). New Edge Function `get-family-weather` resolves a target family member's location server-side (service role) and returns only the weather summary. Client-side: a new `locationService.ts` replaces direct `cfg.parents[i].city/lat/lon` reads/writes; `ParentCityField` no longer renders at all for a parent who isn't the viewer; the calendar's today-weather summary line calls the Edge Function instead of fetching Open-Meteo directly.

**Tech Stack:** PostgreSQL/RLS (Supabase), Deno Edge Function, React (`src/App.jsx`), `src/services/supabase/*.ts`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-weather-location-privacy-design.md` — read it first.
- `parent_locations` has **no** family-wide SELECT policy — only `user_id = auth.uid()` for every operation. This is intentionally different from every other table in this codebase.
- The client must never receive another family member's raw `lat`/`lon` under any circumstance, including via a cache key, a debug log, or an error message.
- The Edge Function is brand new (no drift risk — safe to write directly, no need to paste live dashboard content first).
- Bump `APP_VERSION`/`SW_VERSION` once, at the end (this is a client-facing behavior change).
- `TZ=Europe/Paris npm test` must stay green.
- This supersedes parts of the already-shipped `2026-07-13-calendar-weather.md` plan (Tasks 2 and 3) — those commits stay in history, this plan's commits correct them forward, not by reverting.

---

### Step 1: Migration — `parent_locations` table with owner-only RLS

Create `supabase/migrations/0035_parent_locations.sql`:

```sql
-- 0035_parent_locations.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Localisation d'un parent pour la météo du calendrier (backlog 18a) — table
-- dédiée, JAMAIS incluse dans families.data (le blob partagé synchronisé à
-- toute la famille). RLS restreint à la ligne du propriétaire UNIQUEMENT :
-- contrairement à toutes les autres tables de cet app, il n'y a ici AUCUNE
-- policy de lecture "tout membre de la famille" — un parent ne doit jamais
-- pouvoir lire la ligne d'un autre, seule la fonction Edge get-family-weather
-- (service role) peut lire une ligne qui n'est pas la sienne.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.parent_locations (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id  UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  city       TEXT NOT NULL DEFAULT '',
  lat        DOUBLE PRECISION NOT NULL,
  lon        DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.parent_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "parent_locations_own_select" ON public.parent_locations FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "parent_locations_own_insert" ON public.parent_locations FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "parent_locations_own_update" ON public.parent_locations FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "parent_locations_own_delete" ON public.parent_locations FOR DELETE
  USING (user_id = auth.uid());

-- ⚠️ Pas de policy family-wide : c'est volontaire, ne pas en ajouter une plus
-- tard sans revalider explicitement avec l'utilisateur (ce serait exactement
-- le bug de confidentialité que cette migration corrige).
```

- [ ] Write the migration file exactly as above.
- [ ] Commit: `git add supabase/migrations/0035_parent_locations.sql && git commit -m "Add parent_locations table with owner-only RLS (no family-wide read)"`

### Step 2: Edge Function `get-family-weather`

Create `supabase/functions/get-family-weather/index.ts`:

```typescript
// supabase/functions/get-family-weather/index.ts — syntaxe Deno.serve (moderne)
// ─────────────────────────────────────────────────────────────────────────────
// Seul chemin autorisé pour connaître la météo d'un AUTRE membre de la
// famille : le client envoie {family_id, target_user_id, date}, jamais de
// coordonnées. Cette fonction vérifie l'appartenance à la famille avec le JWT
// de l'appelant (RLS naturelle sur family_members), puis lit la ligne
// parent_locations de target_user_id AVEC le client service-role (contourne
// volontairement le RLS, uniquement pour cette lecture interne — jamais
// renvoyée telle quelle). Ne renvoie que {code, tempMax, tempMin} — jamais
// lat/lon, jamais city. Voir docs/superpowers/specs/2026-07-13-weather-
// location-privacy-design.md.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: CORS });
  }

  const familyId = payload?.family_id;
  const targetUserId = payload?.target_user_id;
  const date = payload?.date; // "YYYY-MM-DD"
  if (!familyId || !targetUserId || !date) {
    return new Response("Missing family_id/target_user_id/date", { status: 400, headers: CORS });
  }

  // 🔒 Le client appelant s'identifie avec son propre JWT (Authorization
  // header transmis automatiquement par supabase.functions.invoke côté
  // client). On l'utilise pour vérifier son appartenance à la famille via la
  // RLS existante sur family_members — pas besoin de service role ici.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("Missing authorization", { status: 401, headers: CORS });

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerUser, error: callerErr } = await callerClient.auth.getUser(token);
  if (callerErr || !callerUser?.user) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }

  const { data: membership } = await callerClient
    .from("family_members")
    .select("user_id")
    .eq("family_id", familyId)
    .eq("user_id", callerUser.user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!membership) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }

  // 🔒 Client service-role UNIQUEMENT pour cette lecture précise — la ligne
  // n'est jamais renvoyée telle quelle au client, seul le résumé météo dérivé
  // l'est.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: loc } = await admin
    .from("parent_locations")
    .select("lat, lon")
    .eq("user_id", targetUserId)
    .eq("family_id", familyId)
    .maybeSingle();
  if (!loc) {
    return new Response(JSON.stringify({ error: "no_location" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=16`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("weather fetch failed");
    const data = await res.json();
    const idx = (data?.daily?.time || []).indexOf(date);
    if (idx === -1) {
      return new Response(JSON.stringify({ error: "no_forecast_for_date" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    const result = {
      code: data.daily.weathercode[idx],
      tempMax: data.daily.temperature_2m_max[idx],
      tempMin: data.daily.temperature_2m_min[idx],
    };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (e) {
    console.error("get-family-weather: forecast fetch failed", e);
    return new Response(JSON.stringify({ error: "fetch_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});
```

- [ ] Write the Edge Function file exactly as above.
- [ ] Commit: `git add supabase/functions/get-family-weather/index.ts && git commit -m "Add get-family-weather Edge Function (never returns raw coordinates)"`

### Step 3: Client service — `src/services/supabase/locationService.ts`

```typescript
import { supabase } from "../../supabaseClient";

export interface ParentLocation {
  city: string;
  lat: number;
  lon: number;
}

export async function getMyLocation(): Promise<ParentLocation | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from("parent_locations")
    .select("city, lat, lon")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export async function setMyLocation(familyId: string, city: string, lat: number, lon: number): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) throw new Error("not-authenticated");
  const { error } = await supabase.from("parent_locations").upsert({
    user_id: userData.user.id,
    family_id: familyId,
    city,
    lat,
    lon,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function getFamilyWeather(familyId: string, targetUserId: string, date: string): Promise<{code: number, tempMax: number, tempMin: number} | null> {
  const { data, error } = await supabase.functions.invoke("get-family-weather", {
    body: { family_id: familyId, target_user_id: targetUserId, date },
  });
  if (error || !data || data.error) return null;
  return data;
}
```

- [ ] Write this file exactly as above.
- [ ] Commit: `git add src/services/supabase/locationService.ts && git commit -m "Add locationService (owner-only reads, edge-function weather lookups)"`

### Step 4: Rework `ParentCityField` — no cross-parent visibility, uses the new service

Find `function ParentCityField({parent, isMine, C, t, onSelect}) {` (`src/App.jsx`, currently ~line 6756) through its closing `}` (currently ~line 6837). Replace the entire function with:

```javascript
function ParentCityField({isMine, C, t, familyId}) {
  const [location, setLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => {
    if (!isMine) return;
    getMyLocation().then(loc => { setLocation(loc); setLoading(false); }).catch(() => setLoading(false));
  }, [isMine]);

  if (!isMine) return null; // 🔒 jamais affiché pour un autre parent — voir spec vie privée

  async function save(city, lat, lon) {
    try {
      await setMyLocation(familyId, city, lat, lon);
      setLocation({ city, lat, lon });
    } catch (e) {
      console.error("[Duvia] setMyLocation error:", e);
    }
  }

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
    save(label, r.latitude, r.longitude);
    setShowSearch(false); setQuery(""); setResults([]);
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { save(t.myLocation||"📍 Ma position", pos.coords.latitude, pos.coords.longitude); setLocating(false); },
      () => { setLocating(false); },
      { timeout: 10000 }
    );
  }

  if (loading) return null;

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
        <div style={{fontSize:13,color:location?.city?C.txt:C.mut}}>{location?.city || (t.noCitySet||"Non renseignée")}</div>
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

Add `getMyLocation, setMyLocation` to a new import near the top of `App.jsx` (alongside the other `src/services/supabase/*` imports — check what's already imported from sibling services like `useVault`/`useMessages` for the existing import style; add `import { getMyLocation, setMyLocation } from "./services/supabase/locationService";`).

- [ ] Rewrite `ParentCityField` as above.
- [ ] Add the new import.

### Step 5: Rework Row 4 wiring (the parent card)

Find (`src/App.jsx`, currently ~line 8852-8855):
```javascript
            <ParentCityField parent={p} isMine={isMine} C={C} t={t}
              onSelect={(city,lat,lon)=>{ setParent(i,"city",city); setParent(i,"lat",lat); setParent(i,"lon",lon); }} />
```
Replace with:
```javascript
            {isMine && <ParentCityField isMine={isMine} C={C} t={t} familyId={familySync?.familyId} />}
```
(The row's outer wrapper and label — "🏙️ Ville" etc. — stay as-is; only render the field itself when `isMine`, so the row shows a label with nothing under it for the other parent rather than any city information. If this reads oddly with just a bare label and no content for the other parent, that's an acceptable, deliberate trade-off for this fix — showing literally nothing is safer than inventing a new placeholder without being asked.)

`familySync` must already be in scope at this call site (it's used elsewhere in the same component for family operations) — if not directly available, check how the enclosing component (`StepId`) accesses it (likely via `useApp()` or a prop already threaded through).

- [ ] Make this change.

### Step 6: Remove the old client-side fetch/cache, replace the weather summary line

Find and delete (`src/App.jsx`, currently ~lines 591-610):
```javascript
const WEATHER_CACHE = {};
function weatherCacheKey(lat, lon) { return `${Number(lat).toFixed(2)}|${Number(lon).toFixed(2)}`; }

async function fetchWeatherForecast(lat, lon) {
  ... (full existing body) ...
}
```
Replace with a new cache keyed by target user + date (no coordinates ever touch this cache):
```javascript
const WEATHER_CACHE = {};
function weatherCacheKey(targetUserId, dateStr) { return `${targetUserId}|${dateStr}`; }
```

Find and delete the `App()`-level weather-fetching effect and state (`src/App.jsx`, currently ~lines 3901-3913):
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
Delete this block entirely (no replacement in `App()` — the fetch now lives in `CalTab`, see Step 7).

Find and remove `weatherData` from `ctxValue` (currently `apiData, apiLoading, weatherData,` — remove just `weatherData,`, leave `apiData, apiLoading,` untouched).

- [ ] Make these three deletions.

### Step 7: Move weather-fetching into `CalTab`, call the Edge Function

`CalTab` currently destructures `weatherData` from `useApp()` (currently ~line 11031) — remove `weatherData` from that destructure (it no longer comes from context).

Add local state + effect inside `CalTab` (place it near its other `useEffect`s):
```javascript
  const [todayWeather, setTodayWeather] = useState(null);
  useEffect(() => {
    const todayStr = toStr(new Date());
    const todayGuard = resolveGuard(todayStr, cfg, activeChildId);
    const pIdx = todayGuard?.parentIdx;
    const targetUserId = (pIdx >= 0) ? cfg.parents?.[pIdx]?.userId : null;
    const familyId = familySync?.familyId;
    if (!targetUserId || !familyId) { setTodayWeather(null); return; }
    const cacheKey = weatherCacheKey(targetUserId, todayStr);
    if (WEATHER_CACHE[cacheKey]) { setTodayWeather({ ...WEATHER_CACHE[cacheKey], parentIdx: pIdx }); return; }
    getFamilyWeather(familyId, targetUserId, todayStr).then(result => {
      if (!result) return;
      WEATHER_CACHE[cacheKey] = result;
      setTodayWeather({ ...result, parentIdx: pIdx });
    }).catch(() => {});
  }, [cfg, activeChildId, familySync?.familyId]);
```

Add `getFamilyWeather` to the same new import added in Step 4 (`import { getMyLocation, setMyLocation, getFamilyWeather } from "./services/supabase/locationService";` — one combined import line, adjust Step 4's import accordingly).

Find the weather summary IIFE (currently ~lines 11526-11542, right after `</MonthGridCalendar>`):
```javascript
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
```
Replace with (reads the new `todayWeather` state instead of context `weatherData`, drops the now-redundant `isWithinForecastWindow` check since this is always "today"):
```javascript
        {todayWeather && (() => {
          const { emoji, label } = weatherIconFor(todayWeather.code);
          const parentName = cfg.parents[todayWeather.parentIdx]?.name?.trim() || `${t.parentFallback||"Parent"} ${todayWeather.parentIdx+1}`;
          const todayLabel = (t.weatherTodayAt||"Aujourd'hui chez {name}").replace("{name}", parentName);
          return (
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 14px",marginTop:8,background:C.sur,borderRadius:12,fontSize:12,color:C.txt}}>
              <span style={{fontSize:20}}>{emoji}</span>
              <span>{todayLabel} : <strong>{Math.round(todayWeather.tempMax)}°C</strong> — {label}</span>
            </div>
          );
        })()}
```

`isWithinForecastWindow` (from Task 1) becomes unused in `App.jsx` after this change — remove it from the `./utils/core.js` import line in `App.jsx` (keep the function itself in `core.js`/its tests; it's still a legitimately reusable utility, just not called from this file anymore after this fix). `weatherIconFor` stays imported (still used).

- [ ] Make all of the above changes in `CalTab`.

### Step 8: Verify and finalize

- [ ] Run `npm run build` — expect success.
- [ ] Run `TZ=Europe/Paris npm test` — expect `pass 130`, `fail 0` (unchanged — this fix touches no pure-logic functions from Task 1, other than removing one now-unused import).
- [ ] Bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) by +0.01 from their current value.
- [ ] Commit: `git add src/App.jsx src/config.js public/sw.js && git commit -m "Route calendar weather through get-family-weather, remove shared-blob location storage"` then `git push`.

### Step 9 (manual, user only): Deploy and live-test

1. Run `supabase/migrations/0035_parent_locations.sql` in the Supabase SQL editor.
2. Create the `get-family-weather` Edge Function in the dashboard (paste `supabase/functions/get-family-weather/index.ts`'s contents), deploy — it uses `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, both of which are default secrets already available to every Edge Function in this project (per `CLAUDE.md`), no new secret to add.
3. With 2 parent test accounts in the same family: each sets their own city. Confirm the "Ville" field/row does not appear at all on the OTHER parent's card.
4. Confirm the today's-weather summary line under the month-grid calendar still shows correctly for whichever parent has custody today.
5. Open browser DevTools → Network tab while viewing the calendar as one parent on a day the OTHER parent has custody — inspect the `get-family-weather` response body and confirm it contains only `{code, tempMax, tempMin}`, never `lat`/`lon`/`city`.
