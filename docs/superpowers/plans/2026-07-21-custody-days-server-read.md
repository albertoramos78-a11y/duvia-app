# Lecture fiable de la garde côté serveur + calcul des jours de garde par le chatbot — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI chatbot a reliable, verified way to count custody days per parent over a period, by reading the 5 already-populated (write-only) custody tables instead of the JSON blob — without touching the client calendar at all.

**Architecture:** Two parallel TypeScript ports of `resolveGuard` (App.jsx's pure custody-resolution function): `resolveCustodyDayFromJson` (reads `families.data`, used only as the trusted reference) and `resolveCustodyDayFromTables` (reads the 5 dedicated tables + a small JSON annex, used by both the new chatbot tool and a new admin parity-verification action). Both are duplicated verbatim into each Edge Function that needs them (no shared imports possible — Edge Functions are deployed by pasting code into the Supabase dashboard).

**Tech Stack:** React/Vite (`src/App.jsx`, `src/utils/core.js`), Deno Edge Functions (`supabase/functions/ai-chatbot`, `supabase/functions/admin-manage-subscriptions`), Supabase Postgres (5 existing `custody_*` tables, no new migration needed).

## Global Constraints

- Full design doc: `docs/superpowers/specs/2026-07-21-custody-days-server-read-design.md` — read it first if anything below is unclear on intent.
- **Non-objectifs (do NOT do these):** no changes to `CalTab`/`resolveGuard`'s call sites/the client calendar rendering; no Stage-2 cutover of the client to the dedicated tables; no automatic/cron scheduling of the verification action; no day-level custody Q&A (only period counting); `get_custody_days` caps ranges at 730 days.
- **RLS confirmed** (via live `pg_policies` query): all 5 `custody_*` tables have a `_select` policy (any active family member, any role) and a `_write` policy (active parents only). The chatbot tool can use the caller's own JWT-scoped client — no service-role exception needed. The admin verification action must use the service-role client (it reads across ALL families, which RLS blocks for a normal JWT).
- **`custody_overrides` only stores manual overrides** — confirmed via `src/services/supabase/custodyService.ts`: `source: "manual"` is hardcoded in every write path. School-holiday assignments (`cfg.specialDates.schoolHolDetails` / `schoolHolDetailsPerChild`) are never mirrored into any of the 5 tables — both server-side resolvers must still read that one slice from `families.data`.
- **Edge Functions drift from this repo** (documented, recurring problem — see CLAUDE.md). Before editing `admin-manage-subscriptions` (Task 3), ask the user to paste its current live dashboard content (Supabase Dashboard → Edge Functions → admin-manage-subscriptions → Code) and diff it against this repo's copy before writing any code — do not assume the repo copy is what's actually deployed.
- **Version bump discipline**: any commit touching `src/` or `public/` must bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) together, in lockstep, even for a change with no visible UI effect. Current value at plan-writing time: `"2.86"`. Edge-Function-only commits (Tasks 2 and 3) do NOT need this bump — Edge Functions aren't part of the Vite/service-worker bundle.
- Tests: `TZ=Europe/Paris npm test` must pass before every commit that touches `src/`. `npm run build` must pass before every commit that touches `src/App.jsx`.
- After each Edge Function task's review passes, the controller must paste the Edge Function's full updated file content back to the user with the exact deploy location (Supabase Dashboard → Edge Functions → `<name>` → Code → Deploy) — per standing project convention, do this unasked, every time, in full.

---

### Task 1: Extract `wkNum`, `getFathersDayDate`, `resolveGuard` into `core.js`, with tests

**Files:**
- Modify: `src/utils/core.js`
- Modify: `src/utils/core.test.js`

**Interfaces:**
- Consumes: existing `core.js` exports — `pad`, `toStr`, `easterDate`, `pentecostDate`, `nthWeekday`, `sameDay`, `getEventDate`, `getMothersDayDate`, `MOTHERS_DAY`.
- Produces (new exports from `core.js`): `wkNum(date: Date): number`, `FATHERS_DAY: object`, `getFathersDayDate(y: number, country: string): Date|null`, `resolveGuard(ds: string, cfg: object, childId: number|null): {parentIdx:number|null, timeType?:string, source?:string, obsId?:string, ...} | null`. These become the authoritative reference algorithm that Tasks 2 and 3 hand-transcribe into TypeScript (Deno can't import from `src/`, so this isn't a code dependency — it's the tested source of truth those tasks copy from).

This task also fixes a real discrepancy found while auditing `core.js`: its `MOTHERS_DAY.BE` entry is `[4, 0, 2]` (2nd Sunday of May), but the version actually running in production (`App.jsx:11706`) has `BE: [4, 0, -1]` (last Sunday of May). Since `resolveCustodyDayFromJson` (Task 3) must be a **faithful port of what's actually running today** — it's the trusted baseline the parity check compares against — `core.js` must match production exactly, bug or not. This task corrects `core.js`'s entry to match `App.jsx`'s current (possibly incorrect) value. Whether Belgium's real legal Mother's Day is the 2nd-to-last Sunday is a separate correctness question, out of scope here — flag it to the user as a side finding, don't fix it as part of this refactor.

- [ ] **Step 1: Write the failing tests**

Add this import line to the top of `src/utils/core.test.js`, replacing the existing import block:

```js
import {
  toStr, pad,
  validatePassword,
  isValidEmail,
  normalizePhoneDigits, isLikelyPhoneIdentifier, identifierToAuthEmail,
  makeRefCode,
  validateVaultFile,
  makeMsgRateLimiter,
  easterDate, pentecostDate, nthWeekday, sameDay, getMothersDayDate,
  getFathersDayDate, wkNum, resolveGuard,
  containsBadWord, isCleanText,
  upsertMessageById, addReader,
  insertValidatedParent, reconcileOwnParentSlot, placeholderNameFromEmail,
  weatherIconFor, isWithinForecastWindow, aggregateHourlyPeriods,
  getInitials,
  nextPensionDueDate,
} from "./core.js";
```

Append this block at the end of `src/utils/core.test.js`:

```js
// ── resolveGuard / getFathersDayDate / wkNum — extraits pour la fonctionnalité
// "jours de garde IA" (2026-07-21). Comble un trou de test préexistant sur une
// logique déjà critique aujourd'hui (calendrier), indépendamment de cette
// fonctionnalité — sert aussi de référence pour le portage serveur.
function makeTestCfg(overrides = {}) {
  return {
    parents: [
      { id: 1, name: "Maman", gender: "F", birthDay: "10", birthMonth: "3" },
      { id: 2, name: "Papa", gender: "M", birthDay: "20", birthMonth: "7" },
    ],
    children: [{ id: 1, name: "Enfant1", birthDay: "5", birthMonth: "9" }],
    sameGuardAll: true,
    country: "FR",
    specialDates: { motherDay: { enabled: false }, fatherDay: { enabled: false }, parentBirths: [], schoolHolDetails: {} },
    custody: {
      type: "weekAlt", weekAlt: { evenIdx: 0 }, exclusive: { mainIdx: 0, weIdx: 1, parity: "even" },
      pattern: [], startMonth: "01", startYear: "2024", confirmed: true,
    },
    custodyPerChild: {},
    overrides: {},
    ...overrides,
  };
}

test("getFathersDayDate DE : Ascension (Pâques + 39 jours)", () => {
  const d = getFathersDayDate(2026, "DE");
  const easter = easterDate(2026);
  const expected = new Date(easter); expected.setDate(easter.getDate() + 39);
  assert.equal(toStr(d), toStr(expected));
});

test("getFathersDayDate FR : tombe un dimanche", () => {
  const d = getFathersDayDate(2026, "FR");
  assert.equal(d.getDay(), 0);
});

test("wkNum : constant sur toute une semaine, incrémente la semaine suivante", () => {
  const d = new Date(2026, 6, 1);
  const monday = new Date(d);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const nextMonday = new Date(monday); nextMonday.setDate(monday.getDate() + 7);
  assert.equal(wkNum(monday), wkNum(sunday));
  assert.notEqual(wkNum(monday), wkNum(nextMonday));
});

test("resolveGuard : override manuel prioritaire sur tout le reste", () => {
  const cfg = makeTestCfg({ overrides: { "2026-07-21": { parentIdx: 1, timeType: "full", source: "manual" } } });
  const result = resolveGuard("2026-07-21", cfg, null);
  assert.deepEqual(result, { parentIdx: 1, timeType: "full", source: "manual" });
});

test("resolveGuard : Fête des Mères forcée sur la mère", () => {
  const cfg = makeTestCfg({ specialDates: { motherDay: { enabled: true }, fatherDay: { enabled: false }, parentBirths: [], schoolHolDetails: {} } });
  const mdDate = getMothersDayDate(2026, "FR");
  const result = resolveGuard(toStr(mdDate), cfg, null);
  assert.equal(result.parentIdx, 0);
  assert.equal(result.source, "motherDay");
});

test("resolveGuard : Fête des Pères forcée sur le père", () => {
  const cfg = makeTestCfg({ specialDates: { motherDay: { enabled: false }, fatherDay: { enabled: true }, parentBirths: [], schoolHolDetails: {} } });
  const fdDate = getFathersDayDate(2026, "FR");
  const result = resolveGuard(toStr(fdDate), cfg, null);
  assert.equal(result.parentIdx, 1);
  assert.equal(result.source, "fatherDay");
});

test("resolveGuard : anniversaire d'un parent forcé", () => {
  const cfg = makeTestCfg({ specialDates: { motherDay: { enabled: false }, fatherDay: { enabled: false }, parentBirths: [{ enabled: false }, { enabled: true }], schoolHolDetails: {} } });
  const result = resolveGuard("2026-07-20", cfg, null); // anniversaire de Papa : 20/7
  assert.equal(result.parentIdx, 1);
  assert.equal(result.source, "parentBirthday");
});

test("resolveGuard : anniversaire d'un enfant — garde paire/impaire selon l'année", () => {
  const cfg = makeTestCfg({ specialDates: { motherDay: { enabled: false }, fatherDay: { enabled: false }, parentBirths: [], schoolHolDetails: {}, evenParentIdx: 0, oddParentIdx: 1 } });
  const r2026 = resolveGuard("2026-09-05", cfg, null); // 2026 = année paire
  assert.equal(r2026.parentIdx, 0);
  const r2027 = resolveGuard("2027-09-05", cfg, null); // 2027 = année impaire
  assert.equal(r2027.parentIdx, 1);
});

test("resolveGuard : vacances scolaires (global)", () => {
  const cfg = makeTestCfg({ specialDates: { motherDay: { enabled: false }, fatherDay: { enabled: false }, parentBirths: [], schoolHolDetails: { "Été": { "2026-07-21": 1 } } } });
  const result = resolveGuard("2026-07-21", cfg, null);
  assert.equal(result.parentIdx, 1);
  assert.equal(result.source, "schoolHol");
});

test("resolveGuard : vacances scolaires per-child prioritaires sur le global", () => {
  const cfg = makeTestCfg({
    specialDates: {
      motherDay: { enabled: false }, fatherDay: { enabled: false }, parentBirths: [],
      schoolHolDetails: { "Été": { "2026-07-21": 1 } },
      schoolHolDetailsPerChild: { 1: { "Été": { "2026-07-21": 0 } } },
    },
  });
  const result = resolveGuard("2026-07-21", cfg, 1);
  assert.equal(result.parentIdx, 0);
});

test("resolveGuard : motif weekAlt — alterne d'une semaine à l'autre", () => {
  const cfg = makeTestCfg();
  const r1 = resolveGuard("2026-07-20", cfg, null);
  const r2 = resolveGuard("2026-07-27", cfg, null);
  assert.notEqual(r1.parentIdx, r2.parentIdx);
});

test("resolveGuard : motif exclusive — jour de semaine toujours chez le parent principal", () => {
  const cfg = makeTestCfg({ custody: { type: "exclusive", weekAlt: { evenIdx: 0 }, exclusive: { mainIdx: 0, weIdx: 1, parity: "even" }, pattern: [], startMonth: "01", startYear: "2024", confirmed: true } });
  const d = new Date(2026, 6, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1); // premier lundi de juillet 2026
  const result = resolveGuard(toStr(d), cfg, null);
  assert.equal(result.parentIdx, 0);
});

test("resolveGuard : motif custom — respecte la grille jour par jour", () => {
  const cfg = makeTestCfg({
    custody: {
      type: "custom", weekAlt: { evenIdx: 0 }, exclusive: { mainIdx: 0, weIdx: 1, parity: "even" },
      pattern: [
        { parentIdx: 0, timeType: "full" }, { parentIdx: 0, timeType: "full" }, { parentIdx: 1, timeType: "full" },
        { parentIdx: 1, timeType: "full" }, { parentIdx: 1, timeType: "full" }, { parentIdx: 0, timeType: "full" }, { parentIdx: 0, timeType: "full" },
      ],
      startMonth: "01", startYear: "2024", confirmed: true,
    },
  });
  const start = new Date(2024, 0, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const result = resolveGuard(toStr(start), cfg, null);
  assert.equal(result.parentIdx, 0); // jour 0 de la grille
});

test("resolveGuard : motif non confirmé renvoie null", () => {
  const cfg = makeTestCfg({ custody: { type: "weekAlt", weekAlt: { evenIdx: 0 }, exclusive: { mainIdx: 0, weIdx: 1, parity: "even" }, pattern: [], startMonth: "01", startYear: "2024", confirmed: false } });
  const result = resolveGuard("2026-07-21", cfg, null);
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `getFathersDayDate`, `wkNum`, `resolveGuard` are not exported yet (import error or `undefined is not a function`).

- [ ] **Step 3: Implement the extraction**

In `src/utils/core.js`, fix the existing `MOTHERS_DAY` constant's `BE` entry (currently wrong — diverged from production):

```js
export const MOTHERS_DAY = {
  FR: [4, 0, -1],
  // 🔧 Corrigé 2026-07-21 : cette copie avait BE: [4, 0, 2] (2e dimanche de
  // mai), mais la version qui tourne réellement en prod (App.jsx:11706) a
  // BE: [4, 0, -1] (dernier dimanche de mai, comme la France). Cette fonction
  // sert de référence fidèle à la production (voir resolveCustodyDayFromJson,
  // 2026-07-21-custody-days-server-read-design.md) — elle doit donc matcher
  // le comportement RÉEL, pas une correction non déployée. Si la vraie date
  // légale belge est bien le 2e dimanche de mai, c'est une correction séparée
  // et délibérée à faire ailleurs, pas ici.
  BE: [4, 0, -1], LU: [4, 0, -1], CH: [4, 0, 2], AT: [4, 0, 2],
  DE: [4, 0, 2], NL: [4, 0, 2], IT: [4, 0, 2], ES: [4, 0, 1], PT: [4, 0, 1],
  GB: [2, 0, 4], IE: [2, 0, 4], CA: [4, 0, 2], PL: { fixed: [4, 26] },
  CZ: [4, 0, 2], SK: [4, 0, 2], HR: { fixed: [4, 22] },
};
```

Then append these exports at the end of `src/utils/core.js` (after `aggregateHourlyPeriods`):

```js
// ── Fête des Pères, numéro de semaine, résolution de garde ───────────────────
// Extraits de App.jsx (2026-07-21) pour la fonctionnalité "jours de garde IA" :
// resolveGuard n'avait aucun test jusqu'ici malgré son rôle critique dans le
// calendrier. Cette version sert aussi de référence testée pour le portage
// serveur (resolveCustodyDayFromJson / resolveCustodyDayFromTables, voir
// supabase/functions/ai-chatbot et admin-manage-subscriptions).
export const FATHERS_DAY = {
  FR: [5, 0, 3], BE: [5, 0, 2], LU: [5, 0, 3], CH: [5, 0, 3], AT: [5, 0, 2],
  DE: null, NL: [5, 0, 3], IT: { fixed: [2, 19] }, ES: { fixed: [2, 19] }, PT: { fixed: [2, 19] },
  GB: [5, 0, 3], IE: [5, 0, 3], CA: [5, 0, 3], PL: { fixed: [5, 23] },
  CZ: [5, 0, 3], SK: [5, 0, 3], HR: [5, 0, 3],
};

export function getFathersDayDate(y, country) {
  if (country === "DE") {
    // Himmelfahrt = Ascension = Pâques + 39 jours
    const easter = easterDate(y);
    const asc = new Date(easter); asc.setDate(easter.getDate() + 39);
    return asc;
  }
  return getEventDate(y, FATHERS_DAY[country]);
}

export function wkNum(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil((((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 864e5) + 1) / 7);
}

export function resolveGuard(ds, cfg, childId) {
  // 1. Sélectionner le bon planning : per-child ou global
  const usePerChild = !cfg.sameGuardAll && childId && cfg.custodyPerChild?.[childId]?.confirmed;
  const custody = usePerChild ? cfg.custodyPerChild[childId] : cfg.custody;

  // 2. Manual overrides (global)
  if (cfg.overrides?.[ds]) return cfg.overrides[ds];

  // 3. Fête des Mères / Fête des Pères — garde forcée si activée
  const sd = cfg.specialDates || {};
  const country = cfg.country || "FR";
  const dsDate = new Date(ds + "T12:00:00");
  const y = dsDate.getFullYear();
  if (sd.motherDay?.enabled) {
    const mdDate = getMothersDayDate(y, country);
    if (sameDay(mdDate, dsDate)) {
      const motherIdx = cfg.parents.findIndex(p => p.gender === "F");
      if (motherIdx !== -1) return { parentIdx: motherIdx, timeType: "full", source: "motherDay" };
    }
  }
  if (sd.fatherDay?.enabled) {
    const fdDate = getFathersDayDate(y, country);
    if (sameDay(fdDate, dsDate)) {
      const fatherIdx = cfg.parents.findIndex(p => p.gender === "M");
      if (fatherIdx !== -1) return { parentIdx: fatherIdx, timeType: "full", source: "fatherDay" };
    }
  }

  // 4. Anniversaires des parents — garde forcée si activée
  const parentBirths = sd.parentBirths || [];
  const dsM = dsDate.getMonth() + 1;
  const dsD = dsDate.getDate();
  for (let pi = 0; pi < cfg.parents.length; pi++) {
    const pb = parentBirths[pi];
    if (!pb?.enabled) continue;
    const p = cfg.parents[pi];
    if (!p?.birthDay || !p?.birthMonth) continue;
    if (+p.birthDay === dsD && +p.birthMonth === dsM) {
      return { parentIdx: pi, timeType: "full", source: "parentBirthday" };
    }
  }

  // 4b. Anniversaires des enfants — garde paire/impaire si configurée
  const perChildSD = cfg.specialDates?.perChild || {};
  for (let ci = 0; ci < cfg.children.length; ci++) {
    const ch = cfg.children[ci];
    if (!ch?.birthDay || !ch?.birthMonth) continue;
    if (+ch.birthDay !== dsD || +ch.birthMonth !== dsM) continue;
    const chSdLocal = childId && perChildSD[ch.id] ? perChildSD[ch.id] : null;
    const evenIdx = chSdLocal?.evenParentIdx ?? sd.evenParentIdx ?? 0;
    const oddIdx = chSdLocal?.oddParentIdx ?? sd.oddParentIdx ?? 1;
    const parentIdx = y % 2 === 0 ? evenIdx : oddIdx;
    if (parentIdx === -1) return { parentIdx: -1, timeType: "full", source: "childBirthday", allParents: true };
    return { parentIdx, timeType: "full", source: "childBirthday" };
  }

  // 5. Vacances scolaires — per-child si disponible, sinon global
  const holDetails = (childId && cfg.specialDates?.schoolHolDetailsPerChild?.[childId])
    || cfg.specialDates?.schoolHolDetails || {};
  const holIdentities = (childId && cfg.specialDates?.schoolHolIdentitiesPerChild?.[childId])
    || cfg.specialDates?.schoolHolIdentities || {};
  for (const holName of Object.keys(holDetails)) {
    const det = holDetails[holName];
    if (det[ds] !== undefined) {
      const v = det[ds];
      if (typeof v === "string" && v.startsWith("obs:"))
        return { obsId: v.slice(4), timeType: "full", source: "schoolHol" };
      const idn = holIdentities[holName]?.[ds];
      return { parentIdx: v, timeType: "full", source: "schoolHol", parentUserId: idn?.u || null, parentName: idn?.n || null };
    }
  }

  // 6. Pattern de garde
  if (!custody?.confirmed) return null;
  const { type, weekAlt, exclusive, pattern } = custody;
  const startYear = custody.startYear || cfg.custody.startYear;
  const startMonth = custody.startMonth || cfg.custody.startMonth;
  const start = new Date(+startYear, +startMonth - 1, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const target = new Date(ds + "T12:00:00");
  const diff = Math.floor((target - start) / 864e5);
  if (diff < 0) return null;
  if (type === "weekAlt") {
    const wn = wkNum(target);
    return { parentIdx: wn % 2 === 0 ? weekAlt.evenIdx : 1 - weekAlt.evenIdx, timeType: "full" };
  }
  if (type === "exclusive") {
    const dw = (target.getDay() + 6) % 7;
    if (dw < 5) return { parentIdx: exclusive.mainIdx, timeType: "full" };
    const wn = wkNum(target);
    return { parentIdx: wn % 2 === (exclusive.parity === "even" ? 0 : 1) ? exclusive.weIdx : exclusive.mainIdx, timeType: "full" };
  }
  if (type === "custom" && pattern?.length) return pattern[diff % pattern.length] || null;
  return null;
}
```

Note: this is a verbatim copy of `App.jsx:1091-1196`'s current logic (same algorithm, same bugs if any — e.g. the childBirthday loop checks every child's birthday regardless of the `childId` being resolved for, which looks odd but is intentional/existing behavior, not something to fix here).

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris npm test`
Expected: all tests pass (145 existing + 13 new = 158).

- [ ] **Step 5: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "$(cat <<'EOF'
Extract wkNum/getFathersDayDate/resolveGuard into core.js with tests

Closes a pre-existing test gap on custody resolution logic and gives the
upcoming server-side custody-day tools a tested reference implementation
to transcribe from. Also fixes core.js's MOTHERS_DAY.BE entry, which had
diverged from the value actually running in production.
EOF
)"
```

This task doesn't touch `src/App.jsx` or anything shipped differently to users (the new exports aren't imported/used anywhere yet) — no version bump needed for this commit.

---

### Task 2: Add the `get_custody_days` tool to the `ai-chatbot` Edge Function

**Files:**
- Modify: `supabase/functions/ai-chatbot/index.ts`

**Interfaces:**
- Consumes: Task 1's tested `resolveGuard` algorithm (hand-transcribed below into TypeScript reading from tables instead of JSON — Deno can't import from `src/`, so this is a deliberate duplicate, not a shared import, per this project's established convention for Edge Functions).
- Produces: a new `get_custody_days` entry in `TOOLS`, a `toolGetCustodyDays` function wired into `executeTool`'s switch, and a small addition to `get_family_config`'s response (`id` field on each child) so the model can reference a specific child in a follow-up `get_custody_days` call.

- [ ] **Step 1: Add `id` to `get_family_config`'s children output**

In `supabase/functions/ai-chatbot/index.ts`, find `toolGetFamilyConfig` and change:

```ts
    children: (cfgData.children || []).map((c: any) => ({ name: c.name, birth_day: c.birthDay, birth_month: c.birthMonth, birth_year: c.birthYear })),
```

to:

```ts
    children: (cfgData.children || []).map((c: any) => ({ id: c.id, name: c.name, birth_day: c.birthDay, birth_month: c.birthMonth, birth_year: c.birthYear })),
```

Without this, the model has no valid value to pass as `child_id` to `get_custody_days` when a question names a specific child.

- [ ] **Step 2: Add the date-math helpers this tool needs**

Edge Functions here are deployed by pasting code into the Supabase dashboard — no shared imports across functions — so these are duplicated from `src/utils/core.js` (Task 1), not imported. Insert this block right after the existing `parisMidnightISO` function (before `const SYSTEM_PROMPT = ...`):

```ts
// ── Dates spéciales (Fête des Mères/Pères, Pâques) — porté depuis
// src/utils/core.js (voir Task 1 du plan 2026-07-21-custody-days-server-read),
// dupliqué ici car les Edge Functions sont déployées par copier-coller
// dashboard (pas de build/import partagé) — même convention que
// parisMidnightISO() ci-dessus et _shared/push.ts. Toute correction faite ici
// doit être répercutée dans core.js et vice-versa.
function easterDateX(y: number): Date {
  const a = y % 19, b = ~~(y / 100), c = y % 100, d = ~~(b / 4), e = b % 4,
    f = ~~((b + 8) / 25), g = ~~((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = ~~(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m2 = ~~((a + 11 * h + 22 * l) / 451),
    mo = ~~((h + l - 7 * m2 + 114) / 31), dy = ((h + l - 7 * m2 + 114) % 31) + 1;
  return new Date(y, mo - 1, dy);
}
function pentecostDateX(y: number): Date {
  const e = easterDateX(y);
  const p = new Date(e); p.setDate(e.getDate() + 49);
  return p;
}
function nthWeekdayX(y: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    let d = new Date(y, month, 1), count = 0;
    while (count < n) { if (d.getDay() === weekday) count++; if (count < n) d.setDate(d.getDate() + 1); }
    return d;
  } else {
    let d = new Date(y, month + 1, 0);
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d;
  }
}
function sameDayX(d1: Date | null, d2: Date | null): boolean {
  return !!(d1 && d2 && d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate());
}
function getEventDateX(y: number, rule: any): Date | null {
  if (!rule) return null;
  if (rule.fixed) return new Date(y, rule.fixed[0], rule.fixed[1]);
  const [month, weekday, nth] = rule;
  return nthWeekdayX(y, month, weekday, nth);
}
const MOTHERS_DAY_X: Record<string, any> = {
  FR: [4, 0, -1], BE: [4, 0, -1], LU: [4, 0, -1], CH: [4, 0, 2], AT: [4, 0, 2],
  DE: [4, 0, 2], NL: [4, 0, 2], IT: [4, 0, 2], ES: [4, 0, 1], PT: [4, 0, 1],
  GB: [2, 0, 4], IE: [2, 0, 4], CA: [4, 0, 2], PL: { fixed: [4, 26] },
  CZ: [4, 0, 2], SK: [4, 0, 2], HR: { fixed: [4, 22] },
};
const FATHERS_DAY_X: Record<string, any> = {
  FR: [5, 0, 3], BE: [5, 0, 2], LU: [5, 0, 3], CH: [5, 0, 3], AT: [5, 0, 2],
  DE: null, NL: [5, 0, 3], IT: { fixed: [2, 19] }, ES: { fixed: [2, 19] }, PT: { fixed: [2, 19] },
  GB: [5, 0, 3], IE: [5, 0, 3], CA: [5, 0, 3], PL: { fixed: [5, 23] },
  CZ: [5, 0, 3], SK: [5, 0, 3], HR: [5, 0, 3],
};
function getMothersDayDateX(y: number, country: string): Date | null {
  const base = getEventDateX(y, MOTHERS_DAY_X[country] || MOTHERS_DAY_X["FR"]);
  if (country === "FR" && base && sameDayX(base, pentecostDateX(y))) return nthWeekdayX(y, 5, 0, 1);
  return base;
}
function getFathersDayDateX(y: number, country: string): Date | null {
  if (country === "DE") {
    const easter = easterDateX(y);
    const asc = new Date(easter); asc.setDate(easter.getDate() + 39);
    return asc;
  }
  return getEventDateX(y, FATHERS_DAY_X[country]);
}
function wkNumX(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil((((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1) / 7);
}

interface CustodyDayResult { parentIdx: number | null; source: string | null; }
interface CustodyTablesCtx {
  ruleRows: any[];
  patternDaysByRuleId: Record<string, any[]>;
  overridesByDate: Map<string, number | null>;
  globalSD: any;
  perChildSDByChild: Record<string, any>;
  annex: {
    country: string; sameGuardAll: boolean;
    parents: Array<{ gender: string; birthDay: string; birthMonth: string }>;
    children: Array<{ id: number; birthDay: string; birthMonth: string }>;
    schoolHolDetails: Record<string, Record<string, any>>;
    schoolHolDetailsPerChild: Record<string, Record<string, Record<string, any>>>;
  };
}

// ── resolveCustodyDayFromTables : lecture hybride (5 tables dédiées + petite
// tranche de families.data) — même algorithme que resolveGuard (core.js),
// sourcé depuis les tables Phase 3 plutôt que le JSON. Utilisée par le
// chatbot (ce fichier) ET l'action admin verify_custody_parity
// (admin-manage-subscriptions/index.ts, copie identique). Voir
// docs/superpowers/specs/2026-07-21-custody-days-server-read-design.md. ──
function resolveCustodyDayFromTables(ds: string, childId: number | null, ctx: CustodyTablesCtx): CustodyDayResult {
  const usePerChild = !ctx.annex.sameGuardAll && childId != null
    && ctx.ruleRows.some((r: any) => r.child_id === childId && r.confirmed);
  const rule = usePerChild
    ? ctx.ruleRows.find((r: any) => r.child_id === childId)
    : ctx.ruleRows.find((r: any) => r.child_id === null);

  // 2. Override manuel (global uniquement — cfg.overrides n'a pas de
  // dimension par enfant dans le modèle JSON actuel, voir design doc).
  if (ctx.overridesByDate.has(ds)) return { parentIdx: ctx.overridesByDate.get(ds) ?? null, source: "override" };

  // 3. Fête des Mères / Fête des Pères
  const dsDate = new Date(ds + "T12:00:00");
  const y = dsDate.getFullYear();
  const country = ctx.annex.country || "FR";
  if (ctx.globalSD.mother_day_enabled) {
    const mdDate = getMothersDayDateX(y, country);
    if (mdDate && sameDayX(mdDate, dsDate)) {
      const motherIdx = ctx.annex.parents.findIndex((p) => p.gender === "F");
      if (motherIdx !== -1) return { parentIdx: motherIdx, source: "motherDay" };
    }
  }
  if (ctx.globalSD.father_day_enabled) {
    const fdDate = getFathersDayDateX(y, country);
    if (fdDate && sameDayX(fdDate, dsDate)) {
      const fatherIdx = ctx.annex.parents.findIndex((p) => p.gender === "M");
      if (fatherIdx !== -1) return { parentIdx: fatherIdx, source: "fatherDay" };
    }
  }

  // 4. Anniversaires des parents
  const parentBirths = ctx.globalSD.parent_births || [];
  const dsM = dsDate.getMonth() + 1, dsD = dsDate.getDate();
  for (let pi = 0; pi < ctx.annex.parents.length; pi++) {
    const pb = parentBirths[pi];
    if (!pb?.enabled) continue;
    const p = ctx.annex.parents[pi];
    if (!p?.birthDay || !p?.birthMonth) continue;
    if (+p.birthDay === dsD && +p.birthMonth === dsM) return { parentIdx: pi, source: "parentBirthday" };
  }

  // 4b. Anniversaires des enfants
  for (let ci = 0; ci < ctx.annex.children.length; ci++) {
    const ch = ctx.annex.children[ci];
    if (!ch?.birthDay || !ch?.birthMonth) continue;
    if (+ch.birthDay !== dsD || +ch.birthMonth !== dsM) continue;
    const chSdLocal = childId != null ? ctx.perChildSDByChild[String(ch.id)] : null;
    const evenIdx = chSdLocal?.even_parent_idx ?? ctx.globalSD.even_parent_idx ?? 0;
    const oddIdx = chSdLocal?.odd_parent_idx ?? ctx.globalSD.odd_parent_idx ?? 1;
    const parentIdx = y % 2 === 0 ? evenIdx : oddIdx;
    if (parentIdx === -1) return { parentIdx: null, source: "childBirthday" };
    return { parentIdx, source: "childBirthday" };
  }

  // 5. Vacances scolaires — SEUL champ qui n'existe pas dans les 5 tables,
  // reste lu depuis l'annexe JSON (voir design doc, custody_overrides ne
  // stocke que les overrides manuels).
  const holDetails = (childId != null && ctx.annex.schoolHolDetailsPerChild?.[String(childId)])
    || ctx.annex.schoolHolDetails || {};
  for (const holName of Object.keys(holDetails)) {
    const det = holDetails[holName];
    if (det[ds] !== undefined) {
      const v = det[ds];
      if (typeof v === "string" && v.startsWith("obs:")) return { parentIdx: null, source: "schoolHol" };
      return { parentIdx: v, source: "schoolHol" };
    }
  }

  // 6. Motif par défaut
  if (!rule?.confirmed) return { parentIdx: null, source: null };
  const start = new Date(+rule.start_year, +rule.start_month - 1, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const target = new Date(ds + "T12:00:00");
  const diff = Math.floor((target.getTime() - start.getTime()) / 864e5);
  if (diff < 0) return { parentIdx: null, source: null };

  if (rule.type === "weekAlt") {
    const wn = wkNumX(target);
    return { parentIdx: wn % 2 === 0 ? rule.week_alt_even_idx : 1 - rule.week_alt_even_idx, source: "pattern" };
  }
  if (rule.type === "exclusive") {
    const dw = (target.getDay() + 6) % 7;
    if (dw < 5) return { parentIdx: rule.exclusive_main_idx, source: "pattern" };
    const wn = wkNumX(target);
    const parity = rule.exclusive_parity === "even" ? 0 : 1;
    return { parentIdx: wn % 2 === parity ? rule.exclusive_we_idx : rule.exclusive_main_idx, source: "pattern" };
  }
  if (rule.type === "custom") {
    const days = ctx.patternDaysByRuleId[rule.id] || [];
    if (!days.length) return { parentIdx: null, source: null };
    const day = days[diff % days.length];
    return { parentIdx: day?.parent_idx ?? null, source: day ? "pattern" : null };
  }
  return { parentIdx: null, source: null };
}
```

- [ ] **Step 3: Add the `get_custody_days` tool definition**

In `TOOLS`, after the `get_messages` entry, add:

```ts
  {
    name: "get_custody_days",
    description: "Compte le nombre de jours de garde de chaque parent sur une période donnée, à partir du planning de garde réel de la famille (motif configuré, overrides manuels, dates spéciales, vacances scolaires). Ne réponds jamais à une question de comptage de jours de garde sans cet outil.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Date de début, format YYYY-MM-DD. Obligatoire." },
        to_date: { type: "string", description: "Date de fin, format YYYY-MM-DD. Obligatoire. Écart maximum avec from_date : 730 jours." },
        child_id: { type: "number", description: "Id de l'enfant concerné (voir get_family_config), si la famille a une garde différenciée par enfant et que la question précise un enfant. Sinon, ne pas fournir : utilise le planning global de la famille." },
      },
      required: ["from_date", "to_date"],
    },
  },
```

- [ ] **Step 4: Add the tool implementation**

After `toolGetMessages`, add:

```ts
async function toolGetCustodyDays(userClient: ReturnType<typeof createClient>, familyId: string, args: any) {
  const fromDate = String(args?.from_date || "");
  const toDate = String(args?.to_date || "");
  if (!fromDate || !toDate) return { error: "missing_dates" };
  const fromMs = new Date(fromDate + "T00:00:00").getTime();
  const toMs = new Date(toDate + "T00:00:00").getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) return { error: "invalid_range" };
  const rangeDays = Math.round((toMs - fromMs) / 86400000) + 1;
  if (rangeDays > 730) return { error: "range_too_large" };

  const childId = args?.child_id != null ? Number(args.child_id) : null;

  const { data: family, error: famErr } = await userClient.from("families").select("data").eq("id", familyId).maybeSingle();
  if (famErr || !family) return { error: "family_not_found_or_no_access" };
  const cfgData = family.data || {};
  const annex = {
    country: cfgData.country || "FR",
    sameGuardAll: cfgData.sameGuardAll !== false,
    parents: (cfgData.parents || []).map((p: any) => ({ gender: p.gender || "M", birthDay: p.birthDay || "", birthMonth: p.birthMonth || "" })),
    children: (cfgData.children || []).map((c: any) => ({ id: c.id, birthDay: c.birthDay || "", birthMonth: c.birthMonth || "" })),
    schoolHolDetails: cfgData.specialDates?.schoolHolDetails || {},
    schoolHolDetailsPerChild: cfgData.specialDates?.schoolHolDetailsPerChild || {},
  };

  const { data: ruleRows, error: ruleErr } = await userClient
    .from("custody_rules")
    .select("id, child_id, type, start_month, start_year, week_alt_even_idx, exclusive_main_idx, exclusive_we_idx, exclusive_parity, confirmed")
    .eq("family_id", familyId);
  if (ruleErr) return { error: ruleErr.message };

  const customRuleIds = (ruleRows || []).filter((r: any) => r.type === "custom").map((r: any) => r.id);
  const patternDaysByRuleId: Record<string, any[]> = {};
  if (customRuleIds.length) {
    const { data: pdRows, error: pdErr } = await userClient
      .from("custody_pattern_days").select("rule_id, day_index, parent_idx").in("rule_id", customRuleIds).order("day_index");
    if (pdErr) return { error: pdErr.message };
    for (const row of pdRows || []) (patternDaysByRuleId[row.rule_id] ||= []).push(row);
  }

  const { data: overrideRows, error: ovErr } = await userClient
    .from("custody_overrides").select("override_date, parent_idx")
    .eq("family_id", familyId).eq("source", "manual").is("child_id", null)
    .gte("override_date", fromDate).lte("override_date", toDate);
  if (ovErr) return { error: ovErr.message };
  const overridesByDate = new Map((overrideRows || []).map((r: any) => [r.override_date, r.parent_idx]));

  const { data: sdRows, error: sdErr } = await userClient
    .from("custody_special_dates").select("child_id, mother_day_enabled, father_day_enabled, parent_births, even_parent_idx, odd_parent_idx")
    .eq("family_id", familyId);
  if (sdErr) return { error: sdErr.message };
  const globalSD = (sdRows || []).find((r: any) => r.child_id === null) || {};
  const perChildSDByChild: Record<string, any> = {};
  for (const r of sdRows || []) if (r.child_id !== null) perChildSDByChild[String(r.child_id)] = r;

  const ctx: CustodyTablesCtx = { ruleRows: ruleRows || [], patternDaysByRuleId, overridesByDate, globalSD, perChildSDByChild, annex };

  let parent0 = 0, parent1 = 0, unassigned = 0;
  for (let ms = fromMs; ms <= toMs; ms += 86400000) {
    const ds = new Date(ms).toISOString().slice(0, 10);
    const { parentIdx } = resolveCustodyDayFromTables(ds, childId, ctx);
    if (parentIdx === 0) parent0++;
    else if (parentIdx === 1) parent1++;
    else unassigned++;
  }

  return { parent_0_days: parent0, parent_1_days: parent1, unassigned_days: unassigned, total_days: rangeDays, from_date: fromDate, to_date: toDate };
}
```

- [ ] **Step 5: Wire the tool into `executeTool` and the system prompt**

In `executeTool`'s switch, add a case right after `get_messages`:

```ts
    case "get_custody_days": return toolGetCustodyDays(ctx.userClient, ctx.familyId, args);
```

In `SYSTEM_PROMPT`, add a new capability line right after point 5 ("5. Traduire du texte..."):

```
6. Calculer le nombre de jours de garde de chaque parent sur une période donnée (ex. "combien de jours de garde ce mois-ci ?", "et entre le 15 mars et le 10 avril ?") — utilise l'outil get_custody_days, jamais un calcul approximatif ou une déduction manuelle du planning.
```

- [ ] **Step 6: Manual verification (no automated test harness exists for Deno Edge Functions in this repo)**

There is no `node --test` coverage for `supabase/functions/*` today (same as the existing `computeExpenseBalance` in this same file — Deno-only, TypeScript, not part of the `src/**/*.test.js` glob). Verification is manual, after deployment:
- Ask the user to paste this file's full updated content into Supabase Dashboard → Edge Functions → `ai-chatbot` → Code, then Deploy (per standing project convention — the controller does this unasked after review passes, not the implementer).
- Ask a real test account with `ai_enabled` a counting question ("combien de jours de garde ce mois-ci ?") and manually cross-check the answer against the calendar shown in `CalTab` for that family.
- If the family has per-child custody (`sameGuardAll: false`), ask a question naming one child and confirm the count changes accordingly, and that omitting the child falls back to the global schedule.
- Ask a question spanning more than 730 days and confirm a polite refusal, not a crash.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/ai-chatbot/index.ts
git commit -m "$(cat <<'EOF'
Add get_custody_days tool to the AI chatbot

Lets the chatbot count custody days per parent over a period, reading
from the 5 dedicated custody tables (Phase 3, previously write-only)
instead of guessing — never a client calendar change.
EOF
)"
```

No version bump — Edge Functions aren't part of the Vite/service-worker bundle.

---

### Task 3: Add the `verify_custody_parity` admin action

**Files:**
- Modify: `supabase/functions/admin-manage-subscriptions/index.ts`

**Interfaces:**
- Consumes: the exact same `resolveCustodyDayFromTables` algorithm as Task 2 (duplicated again — separate Edge Function, no shared imports), plus a new `resolveCustodyDayFromJson` (faithful port of `resolveGuard`, Task 1) used only as the comparison baseline.
- Produces: a new `verify_custody_parity` action, response shape `{ ok: true, familles_verifiees: number, jours_compares: number, total_desaccords: number, desaccords: Array<{family_id, date, child_id, old_result, new_result}>, desaccords_tronques: boolean }`.

- [ ] **Step 1: Confirm the live deployed content before editing**

This function has drifted from its repo copy before (see CLAUDE.md's documented history — `delete-account`, `notify-expense`/`notify-message`/`notify-vault` all had live prod versions never committed here). Before writing any code: ask the user to paste `admin-manage-subscriptions`'s current content from Supabase Dashboard → Edge Functions → admin-manage-subscriptions → Code, and diff it against this repo's copy (`supabase/functions/admin-manage-subscriptions/index.ts`, 317 lines as of this plan). If they differ, treat the pasted live version as the real starting point and flag the diff to the user before proceeding.

- [ ] **Step 2: Add the date-math + resolver helpers**

Insert this whole block after the `jsonResponse` function (before `listAllAnonymousUserIds`). This is intentionally the exact same `easterDateX`/`resolveCustodyDayFromTables` code as `ai-chatbot/index.ts` gets in the other task of this plan that adds the chatbot tool — both Edge Functions need their own copy since they're deployed independently (dashboard copy-paste, no shared imports) and must behave identically for the parity check below to mean anything:

```ts
// ── Dates spéciales (Fête des Mères/Pères, Pâques) — porté depuis
// src/utils/core.js, dupliqué ici (et dans ai-chatbot/index.ts) car les Edge
// Functions sont déployées par copier-coller dashboard (pas de build/import
// partagé) — même convention que parisMidnightISO() et _shared/push.ts.
// Toute correction faite ici doit être répercutée dans core.js ET dans
// ai-chatbot/index.ts.
function easterDateX(y: number): Date {
  const a = y % 19, b = ~~(y / 100), c = y % 100, d = ~~(b / 4), e = b % 4,
    f = ~~((b + 8) / 25), g = ~~((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = ~~(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m2 = ~~((a + 11 * h + 22 * l) / 451),
    mo = ~~((h + l - 7 * m2 + 114) / 31), dy = ((h + l - 7 * m2 + 114) % 31) + 1;
  return new Date(y, mo - 1, dy);
}
function pentecostDateX(y: number): Date {
  const e = easterDateX(y);
  const p = new Date(e); p.setDate(e.getDate() + 49);
  return p;
}
function nthWeekdayX(y: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    let d = new Date(y, month, 1), count = 0;
    while (count < n) { if (d.getDay() === weekday) count++; if (count < n) d.setDate(d.getDate() + 1); }
    return d;
  } else {
    let d = new Date(y, month + 1, 0);
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d;
  }
}
function sameDayX(d1: Date | null, d2: Date | null): boolean {
  return !!(d1 && d2 && d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate());
}
function getEventDateX(y: number, rule: any): Date | null {
  if (!rule) return null;
  if (rule.fixed) return new Date(y, rule.fixed[0], rule.fixed[1]);
  const [month, weekday, nth] = rule;
  return nthWeekdayX(y, month, weekday, nth);
}
const MOTHERS_DAY_X: Record<string, any> = {
  FR: [4, 0, -1], BE: [4, 0, -1], LU: [4, 0, -1], CH: [4, 0, 2], AT: [4, 0, 2],
  DE: [4, 0, 2], NL: [4, 0, 2], IT: [4, 0, 2], ES: [4, 0, 1], PT: [4, 0, 1],
  GB: [2, 0, 4], IE: [2, 0, 4], CA: [4, 0, 2], PL: { fixed: [4, 26] },
  CZ: [4, 0, 2], SK: [4, 0, 2], HR: { fixed: [4, 22] },
};
const FATHERS_DAY_X: Record<string, any> = {
  FR: [5, 0, 3], BE: [5, 0, 2], LU: [5, 0, 3], CH: [5, 0, 3], AT: [5, 0, 2],
  DE: null, NL: [5, 0, 3], IT: { fixed: [2, 19] }, ES: { fixed: [2, 19] }, PT: { fixed: [2, 19] },
  GB: [5, 0, 3], IE: [5, 0, 3], CA: [5, 0, 3], PL: { fixed: [5, 23] },
  CZ: [5, 0, 3], SK: [5, 0, 3], HR: [5, 0, 3],
};
function getMothersDayDateX(y: number, country: string): Date | null {
  const base = getEventDateX(y, MOTHERS_DAY_X[country] || MOTHERS_DAY_X["FR"]);
  if (country === "FR" && base && sameDayX(base, pentecostDateX(y))) return nthWeekdayX(y, 5, 0, 1);
  return base;
}
function getFathersDayDateX(y: number, country: string): Date | null {
  if (country === "DE") {
    const easter = easterDateX(y);
    const asc = new Date(easter); asc.setDate(easter.getDate() + 39);
    return asc;
  }
  return getEventDateX(y, FATHERS_DAY_X[country]);
}
function wkNumX(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil((((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1) / 7);
}

interface CustodyDayResult { parentIdx: number | null; source: string | null; }
interface CustodyTablesCtx {
  ruleRows: any[];
  patternDaysByRuleId: Record<string, any[]>;
  overridesByDate: Map<string, number | null>;
  globalSD: any;
  perChildSDByChild: Record<string, any>;
  annex: {
    country: string; sameGuardAll: boolean;
    parents: Array<{ gender: string; birthDay: string; birthMonth: string }>;
    children: Array<{ id: number; birthDay: string; birthMonth: string }>;
    schoolHolDetails: Record<string, Record<string, any>>;
    schoolHolDetailsPerChild: Record<string, Record<string, Record<string, any>>>;
  };
}

// ── resolveCustodyDayFromTables : lecture hybride (5 tables dédiées + petite
// tranche de families.data) — même algorithme que resolveGuard (core.js),
// sourcé depuis les tables Phase 3 plutôt que le JSON. Utilisée par le
// chatbot (ai-chatbot/index.ts) ET l'action admin verify_custody_parity
// ci-dessous. Voir docs/superpowers/specs/2026-07-21-custody-days-server-
// read-design.md. ──
function resolveCustodyDayFromTables(ds: string, childId: number | null, ctx: CustodyTablesCtx): CustodyDayResult {
  const usePerChild = !ctx.annex.sameGuardAll && childId != null
    && ctx.ruleRows.some((r: any) => r.child_id === childId && r.confirmed);
  const rule = usePerChild
    ? ctx.ruleRows.find((r: any) => r.child_id === childId)
    : ctx.ruleRows.find((r: any) => r.child_id === null);

  // 2. Override manuel (global uniquement — cfg.overrides n'a pas de
  // dimension par enfant dans le modèle JSON actuel, voir design doc).
  if (ctx.overridesByDate.has(ds)) return { parentIdx: ctx.overridesByDate.get(ds) ?? null, source: "override" };

  // 3. Fête des Mères / Fête des Pères
  const dsDate = new Date(ds + "T12:00:00");
  const y = dsDate.getFullYear();
  const country = ctx.annex.country || "FR";
  if (ctx.globalSD.mother_day_enabled) {
    const mdDate = getMothersDayDateX(y, country);
    if (mdDate && sameDayX(mdDate, dsDate)) {
      const motherIdx = ctx.annex.parents.findIndex((p) => p.gender === "F");
      if (motherIdx !== -1) return { parentIdx: motherIdx, source: "motherDay" };
    }
  }
  if (ctx.globalSD.father_day_enabled) {
    const fdDate = getFathersDayDateX(y, country);
    if (fdDate && sameDayX(fdDate, dsDate)) {
      const fatherIdx = ctx.annex.parents.findIndex((p) => p.gender === "M");
      if (fatherIdx !== -1) return { parentIdx: fatherIdx, source: "fatherDay" };
    }
  }

  // 4. Anniversaires des parents
  const parentBirths = ctx.globalSD.parent_births || [];
  const dsM = dsDate.getMonth() + 1, dsD = dsDate.getDate();
  for (let pi = 0; pi < ctx.annex.parents.length; pi++) {
    const pb = parentBirths[pi];
    if (!pb?.enabled) continue;
    const p = ctx.annex.parents[pi];
    if (!p?.birthDay || !p?.birthMonth) continue;
    if (+p.birthDay === dsD && +p.birthMonth === dsM) return { parentIdx: pi, source: "parentBirthday" };
  }

  // 4b. Anniversaires des enfants
  for (let ci = 0; ci < ctx.annex.children.length; ci++) {
    const ch = ctx.annex.children[ci];
    if (!ch?.birthDay || !ch?.birthMonth) continue;
    if (+ch.birthDay !== dsD || +ch.birthMonth !== dsM) continue;
    const chSdLocal = childId != null ? ctx.perChildSDByChild[String(ch.id)] : null;
    const evenIdx = chSdLocal?.even_parent_idx ?? ctx.globalSD.even_parent_idx ?? 0;
    const oddIdx = chSdLocal?.odd_parent_idx ?? ctx.globalSD.odd_parent_idx ?? 1;
    const parentIdx = y % 2 === 0 ? evenIdx : oddIdx;
    if (parentIdx === -1) return { parentIdx: null, source: "childBirthday" };
    return { parentIdx, source: "childBirthday" };
  }

  // 5. Vacances scolaires — SEUL champ qui n'existe pas dans les 5 tables,
  // reste lu depuis l'annexe JSON (voir design doc, custody_overrides ne
  // stocke que les overrides manuels).
  const holDetails = (childId != null && ctx.annex.schoolHolDetailsPerChild?.[String(childId)])
    || ctx.annex.schoolHolDetails || {};
  for (const holName of Object.keys(holDetails)) {
    const det = holDetails[holName];
    if (det[ds] !== undefined) {
      const v = det[ds];
      if (typeof v === "string" && v.startsWith("obs:")) return { parentIdx: null, source: "schoolHol" };
      return { parentIdx: v, source: "schoolHol" };
    }
  }

  // 6. Motif par défaut
  if (!rule?.confirmed) return { parentIdx: null, source: null };
  const start = new Date(+rule.start_year, +rule.start_month - 1, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const target = new Date(ds + "T12:00:00");
  const diff = Math.floor((target.getTime() - start.getTime()) / 864e5);
  if (diff < 0) return { parentIdx: null, source: null };

  if (rule.type === "weekAlt") {
    const wn = wkNumX(target);
    return { parentIdx: wn % 2 === 0 ? rule.week_alt_even_idx : 1 - rule.week_alt_even_idx, source: "pattern" };
  }
  if (rule.type === "exclusive") {
    const dw = (target.getDay() + 6) % 7;
    if (dw < 5) return { parentIdx: rule.exclusive_main_idx, source: "pattern" };
    const wn = wkNumX(target);
    const parity = rule.exclusive_parity === "even" ? 0 : 1;
    return { parentIdx: wn % 2 === parity ? rule.exclusive_we_idx : rule.exclusive_main_idx, source: "pattern" };
  }
  if (rule.type === "custom") {
    const days = ctx.patternDaysByRuleId[rule.id] || [];
    if (!days.length) return { parentIdx: null, source: null };
    const day = days[diff % days.length];
    return { parentIdx: day?.parent_idx ?? null, source: day ? "pattern" : null };
  }
  return { parentIdx: null, source: null };
}

// ── resolveCustodyDayFromJson : portage fidèle de resolveGuard (core.js,
// Task 1 du plan) — utilisé UNIQUEMENT comme référence pour la vérification
// de parité ci-dessous, jamais par le chatbot. ──
function resolveCustodyDayFromJson(ds: string, cfg: any, childId: number | null): CustodyDayResult {
  const usePerChild = !cfg.sameGuardAll && childId != null && cfg.custodyPerChild?.[childId]?.confirmed;
  const custody = usePerChild ? cfg.custodyPerChild[childId] : cfg.custody;

  if (cfg.overrides?.[ds]) return { parentIdx: cfg.overrides[ds].parentIdx ?? null, source: "override" };

  const sd = cfg.specialDates || {};
  const country = cfg.country || "FR";
  const dsDate = new Date(ds + "T12:00:00");
  const y = dsDate.getFullYear();
  if (sd.motherDay?.enabled) {
    const mdDate = getMothersDayDateX(y, country);
    if (mdDate && sameDayX(mdDate, dsDate)) {
      const motherIdx = (cfg.parents || []).findIndex((p: any) => p.gender === "F");
      if (motherIdx !== -1) return { parentIdx: motherIdx, source: "motherDay" };
    }
  }
  if (sd.fatherDay?.enabled) {
    const fdDate = getFathersDayDateX(y, country);
    if (fdDate && sameDayX(fdDate, dsDate)) {
      const fatherIdx = (cfg.parents || []).findIndex((p: any) => p.gender === "M");
      if (fatherIdx !== -1) return { parentIdx: fatherIdx, source: "fatherDay" };
    }
  }

  const parentBirths = sd.parentBirths || [];
  const dsM = dsDate.getMonth() + 1, dsD = dsDate.getDate();
  for (let pi = 0; pi < (cfg.parents || []).length; pi++) {
    const pb = parentBirths[pi];
    if (!pb?.enabled) continue;
    const p = cfg.parents[pi];
    if (!p?.birthDay || !p?.birthMonth) continue;
    if (+p.birthDay === dsD && +p.birthMonth === dsM) return { parentIdx: pi, source: "parentBirthday" };
  }

  const perChildSD = cfg.specialDates?.perChild || {};
  for (let ci = 0; ci < (cfg.children || []).length; ci++) {
    const ch = cfg.children[ci];
    if (!ch?.birthDay || !ch?.birthMonth) continue;
    if (+ch.birthDay !== dsD || +ch.birthMonth !== dsM) continue;
    const chSdLocal = childId != null && perChildSD[ch.id] ? perChildSD[ch.id] : null;
    const evenIdx = chSdLocal?.evenParentIdx ?? sd.evenParentIdx ?? 0;
    const oddIdx = chSdLocal?.oddParentIdx ?? sd.oddParentIdx ?? 1;
    const parentIdx = y % 2 === 0 ? evenIdx : oddIdx;
    if (parentIdx === -1) return { parentIdx: null, source: "childBirthday" };
    return { parentIdx, source: "childBirthday" };
  }

  const holDetails = (childId != null && cfg.specialDates?.schoolHolDetailsPerChild?.[childId])
    || cfg.specialDates?.schoolHolDetails || {};
  for (const holName of Object.keys(holDetails)) {
    const det = holDetails[holName];
    if (det[ds] !== undefined) {
      const v = det[ds];
      if (typeof v === "string" && v.startsWith("obs:")) return { parentIdx: null, source: "schoolHol" };
      return { parentIdx: v, source: "schoolHol" };
    }
  }

  if (!custody?.confirmed) return { parentIdx: null, source: null };
  const { type, weekAlt, exclusive, pattern } = custody;
  const startYear = custody.startYear || cfg.custody.startYear;
  const startMonth = custody.startMonth || cfg.custody.startMonth;
  const start = new Date(+startYear, +startMonth - 1, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const target = new Date(ds + "T12:00:00");
  const diff = Math.floor((target.getTime() - start.getTime()) / 864e5);
  if (diff < 0) return { parentIdx: null, source: null };
  if (type === "weekAlt") {
    const wn = wkNumX(target);
    return { parentIdx: wn % 2 === 0 ? weekAlt.evenIdx : 1 - weekAlt.evenIdx, source: "pattern" };
  }
  if (type === "exclusive") {
    const dw = (target.getDay() + 6) % 7;
    if (dw < 5) return { parentIdx: exclusive.mainIdx, source: "pattern" };
    const wn = wkNumX(target);
    return { parentIdx: wn % 2 === (exclusive.parity === "even" ? 0 : 1) ? exclusive.weIdx : exclusive.mainIdx, source: "pattern" };
  }
  if (type === "custom" && pattern?.length) {
    const day = pattern[diff % pattern.length];
    return { parentIdx: day?.parentIdx ?? null, source: day ? "pattern" : null };
  }
  return { parentIdx: null, source: null };
}

function familyHasConfirmedCustody(cfgData: any): boolean {
  if (cfgData?.custody?.confirmed) return true;
  const perChild = cfgData?.custodyPerChild || {};
  return Object.values(perChild).some((c: any) => c?.confirmed);
}
```

- [ ] **Step 3: Add the `verify_custody_parity` action**

In the `serve` handler, add this new `if (action === ...)` block right after the `cleanup_anonymous_accounts` block (before the final `return jsonResponse({ error: "unknown_action" }, 400);`):

```ts
  if (action === "verify_custody_parity") {
    // Compare le calcul JSON actuel (resolveCustodyDayFromJson) au nouveau
    // calcul par tables dédiées (resolveCustodyDayFromTables), sur 2 ans
    // passés + 1 an à venir, pour toutes les familles ayant une configuration
    // de garde confirmée. Action à la demande uniquement (pas de cron) — voir
    // Non-objectifs du design doc. Client service-role : lecture cross-
    // famille, bloquée par RLS pour un JWT normal.
    const today = new Date();
    const fromDate = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate()).toISOString().slice(0, 10);
    const toDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate()).toISOString().slice(0, 10);
    const fromMs = new Date(fromDate + "T00:00:00").getTime();
    const toMs = new Date(toDate + "T00:00:00").getTime();

    const { data: families, error: famErr } = await admin.from("families").select("id, data");
    if (famErr) return jsonResponse({ error: famErr.message }, 500);

    const MAX_MISMATCHES_RETURNED = 200;
    let familiesChecked = 0;
    let daysCompared = 0;
    let mismatchCount = 0;
    const mismatches: any[] = [];

    for (const fam of families || []) {
      const cfgData = fam.data || {};
      if (!familyHasConfirmedCustody(cfgData)) continue;
      familiesChecked++;

      const childIds: Array<number | null> = cfgData.sameGuardAll === false
        ? (cfgData.children || []).map((c: any) => c.id)
        : [null];

      const { data: ruleRows } = await admin
        .from("custody_rules")
        .select("id, child_id, type, start_month, start_year, week_alt_even_idx, exclusive_main_idx, exclusive_we_idx, exclusive_parity, confirmed")
        .eq("family_id", fam.id);
      const customRuleIds = (ruleRows || []).filter((r: any) => r.type === "custom").map((r: any) => r.id);
      const patternDaysByRuleId: Record<string, any[]> = {};
      if (customRuleIds.length) {
        const { data: pdRows } = await admin
          .from("custody_pattern_days").select("rule_id, day_index, parent_idx").in("rule_id", customRuleIds).order("day_index");
        for (const row of pdRows || []) (patternDaysByRuleId[row.rule_id] ||= []).push(row);
      }
      const { data: overrideRows } = await admin
        .from("custody_overrides").select("override_date, parent_idx")
        .eq("family_id", fam.id).eq("source", "manual").is("child_id", null)
        .gte("override_date", fromDate).lte("override_date", toDate);
      const overridesByDate = new Map((overrideRows || []).map((r: any) => [r.override_date, r.parent_idx]));
      const { data: sdRows } = await admin
        .from("custody_special_dates").select("child_id, mother_day_enabled, father_day_enabled, parent_births, even_parent_idx, odd_parent_idx")
        .eq("family_id", fam.id);
      const globalSD = (sdRows || []).find((r: any) => r.child_id === null) || {};
      const perChildSDByChild: Record<string, any> = {};
      for (const r of sdRows || []) if (r.child_id !== null) perChildSDByChild[String(r.child_id)] = r;

      const annex = {
        country: cfgData.country || "FR",
        sameGuardAll: cfgData.sameGuardAll !== false,
        parents: (cfgData.parents || []).map((p: any) => ({ gender: p.gender || "M", birthDay: p.birthDay || "", birthMonth: p.birthMonth || "" })),
        children: (cfgData.children || []).map((c: any) => ({ id: c.id, birthDay: c.birthDay || "", birthMonth: c.birthMonth || "" })),
        schoolHolDetails: cfgData.specialDates?.schoolHolDetails || {},
        schoolHolDetailsPerChild: cfgData.specialDates?.schoolHolDetailsPerChild || {},
      };
      const tablesCtx: CustodyTablesCtx = { ruleRows: ruleRows || [], patternDaysByRuleId, overridesByDate, globalSD, perChildSDByChild, annex };

      for (const childId of childIds) {
        for (let ms = fromMs; ms <= toMs; ms += 86400000) {
          const ds = new Date(ms).toISOString().slice(0, 10);
          const fromJson = resolveCustodyDayFromJson(ds, cfgData, childId);
          const fromTables = resolveCustodyDayFromTables(ds, childId, tablesCtx);
          daysCompared++;
          if (fromJson.parentIdx !== fromTables.parentIdx) {
            mismatchCount++;
            if (mismatches.length < MAX_MISMATCHES_RETURNED) {
              mismatches.push({ family_id: fam.id, date: ds, child_id: childId, old_result: fromJson.parentIdx, new_result: fromTables.parentIdx });
            }
          }
        }
      }
    }

    return jsonResponse({
      ok: true,
      familles_verifiees: familiesChecked,
      jours_compares: daysCompared,
      total_desaccords: mismatchCount,
      desaccords: mismatches,
      desaccords_tronques: mismatchCount > MAX_MISMATCHES_RETURNED,
    });
  }

```

Note for the controller: this action does a full per-family, per-day, per-implementation comparison — for a family base in the tens/hundreds this runs comfortably within Edge Function time limits; if the user's family count grows much larger later, this may need chunking/pagination — out of scope for this plan (matches the Non-objectif against automatic/scheduled runs; this stays a manual, occasional admin action).

- [ ] **Step 4: Manual verification**

Same situation as Task 2 — no automated test harness for this file. After deployment:
- Paste the file's full updated content to the user with the exact deploy location (Supabase Dashboard → Edge Functions → admin-manage-subscriptions → Code → Deploy).
- As an admin, trigger `verify_custody_parity` (via Task 4's UI card, or directly via `supabase.functions.invoke` in the browser console) against real family data and confirm the response shape matches (`familles_verifiees`, `jours_compares`, `total_desaccords`, `desaccords`, `desaccords_tronques`).
- If `total_desaccords` is 0, this is the expected/desired outcome. If not, read a few `desaccords` entries and manually check the named family's calendar against both `cfg.custody`/`cfg.specialDates` and the 5 tables (via SQL editor) to find which specific rule this plan's port missed — do not simply mark this task "done" with unexplained mismatches.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/admin-manage-subscriptions/index.ts
git commit -m "$(cat <<'EOF'
Add verify_custody_parity admin action

Compares the current JSON-based custody calculation against the new
table-based one across all families with a confirmed schedule, so the
chatbot's get_custody_days tool can be trusted before relying on it —
zero automatic scheduling, on-demand admin action only.
EOF
)"
```

No version bump — Edge Functions aren't part of the Vite/service-worker bundle.

---

### Task 4: Add the `VerifyCustodyParityCard` to `AdminTab`

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/config.js`
- Modify: `public/sw.js`

**Interfaces:**
- Consumes: Task 3's `verify_custody_parity` action name and exact response field names (`familles_verifiees`, `jours_compares`, `total_desaccords`, `desaccords`, `desaccords_tronques`).
- Produces: `VerifyCustodyParityCard` component, rendered inside `AdminTab`.

- [ ] **Step 1: Add the component**

In `src/App.jsx`, right before `function AnonymousCleanupCard({ C }) {` (line 16235), add:

```jsx
function VerifyCustodyParityCard({ C }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");

  async function run() {
    setRunning(true); setErr(""); setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("admin-manage-subscriptions", { body: { action: "verify_custody_parity" } });
      if (error) throw new Error(error.message || "invoke_failed");
      if (data?.error) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card" style={{marginBottom:14,borderColor:`${C.mut}44`,background:`${C.mut}08`}}>
      <div style={{fontSize:11,fontWeight:800,color:C.mut,letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>🔍 Fiabilité du calcul de garde (tables)</div>
      <div style={{fontSize:12,color:C.mut,marginBottom:12,lineHeight:1.5}}>
        Compare, sur 3 ans (2 ans passés + 1 an à venir), le calcul de garde actuel (JSON) et le nouveau calcul depuis les tables dédiées, pour toutes les familles ayant une configuration confirmée. Action en lecture seule, sans risque, peut être relancée à tout moment.
      </div>
      <button onClick={run} disabled={running}
        style={{padding:"8px 18px",background:`${C.mut}18`,color:C.mut,border:`1.5px solid ${C.mut}55`,borderRadius:10,fontSize:12,fontWeight:800,cursor:running?"default":"pointer"}}>
        {running ? "Vérification…" : "🔍 Lancer la vérification"}
      </button>
      {result && (
        <div style={{marginTop:10,fontSize:12,color:result.total_desaccords===0?C.grn:C.red}}>
          {result.total_desaccords===0
            ? `✅ ${result.familles_verifiees} famille(s), ${result.jours_compares} jour(s) comparés — 0 désaccord.`
            : `⚠️ ${result.total_desaccords} désaccord(s) sur ${result.jours_compares} jour(s) comparés (${result.familles_verifiees} famille(s)).`}
          {result.total_desaccords > 0 && (
            <div style={{marginTop:8,maxHeight:200,overflowY:"auto",fontFamily:"monospace",fontSize:11}}>
              {result.desaccords.map((d,i)=>(
                <div key={i}>{d.family_id.slice(0,8)}… · {d.date} · enfant {d.child_id ?? "global"} · JSON={d.old_result ?? "—"} vs tables={d.new_result ?? "—"}</div>
              ))}
              {result.desaccords_tronques && <div style={{marginTop:4,fontStyle:"italic"}}>Liste tronquée à 200 désaccords.</div>}
            </div>
          )}
        </div>
      )}
      {err && <div style={{marginTop:10,fontSize:11,color:C.red}}>⚠️ {err}</div>}
    </div>
  );
}

```

- [ ] **Step 2: Render it in `AdminTab`**

Find this block near the end of `AdminTab` (line ~16569-16570):

```jsx
      {/* ── Nettoyage comptes anonymes résiduels ────────────────────────── */}
      <AnonymousCleanupCard C={C} />
```

Change it to:

```jsx
      {/* ── Nettoyage comptes anonymes résiduels ────────────────────────── */}
      <AnonymousCleanupCard C={C} />

      {/* ── Vérification de fiabilité garde (Phase 4, étape 1) ──────────── */}
      <VerifyCustodyParityCard C={C} />
```

- [ ] **Step 3: Bump the version**

Task 1 deliberately does not bump the version (it ships no behavior change — nothing imports its new exports yet). This is the first and only task in this plan that changes what a browser actually loads, so it takes the next version step from the current value (`"2.86"` at plan-writing time — re-check `src/config.js` at execution time in case another commit landed in between, and bump one step from whatever it actually holds).

In `src/config.js`:

```js
export const APP_VERSION = "2.87";
```

In `public/sw.js`:

```js
const SW_VERSION = "2.87";
```

- [ ] **Step 4: Verify**

Run: `TZ=Europe/Paris npm test`
Expected: all pass (no logic changed, this is additive JSX).

Run: `npm run build`
Expected: build succeeds with no errors.

Then manually: log in as an admin account, open the Admin tab, confirm the new card renders below "Nettoyage comptes anonymes", click "Lancer la vérification", and confirm it shows a result (or a clear error if `admin-manage-subscriptions` hasn't been redeployed with Task 3's changes yet).

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "$(cat <<'EOF'
Add admin UI for the custody parity verification tool

Surfaces verify_custody_parity as a one-click admin card, matching the
existing AnonymousCleanupCard pattern — the last piece needed to actually
run and read the Phase 4 step 1 reliability check end to end.
EOF
)"
```

---

## Spec coverage check (self-review)

- Two server-side resolvers, JSON one used only for verification: ✅ Tasks 2 & 3.
- `get_custody_days` chatbot tool, period counting, per-child scoping, 730-day cap: ✅ Task 2.
- `verify_custody_parity` admin action, 3-year window, mismatch report: ✅ Task 3.
- Admin UI card: ✅ Task 4.
- Security (JWT-scoped for chatbot, service-role for cross-family admin read): ✅ built into Tasks 2 & 3's client choice.
- Non-objectifs respected: no `CalTab`/`resolveGuard` call-site changes, no cron scheduling, no day-level Q&A — confirmed, none of the 4 tasks touch calendar rendering or scheduling.
- Pre-existing test gap on `resolveGuard` closed, serves as transcription reference: ✅ Task 1.
- School-holiday-only-in-JSON discovery folded into both resolvers' annex reads: ✅ Tasks 2 & 3 both read `schoolHolDetails`/`schoolHolDetailsPerChild` from `families.data` alongside the table queries.
- Edge-Function-drift standing instruction: ✅ explicit Step 1 in Task 3; Task 2 skipped the same re-ask because this exact file was deployed to production earlier in this same session (documented reasoning, not an oversight).
