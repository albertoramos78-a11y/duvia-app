# Observer Quota Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an observer is beyond their family's plan-allowed observer quota (currently 1 during Freemium/Trial, unlimited on real Premium), block their OWN session with a dedicated screen instead of only hiding/locking their card on the parent's config screen (already shipped, v1.79-1.80).

**Architecture:** A new `SECURITY DEFINER` Postgres RPC (`get_family_billing_context`) lets an observer read — for their own family only — the parent accounts' subscription rows plus their own rank among active observers. The client reuses the existing `subStatus()`/`getPerms()` JS functions (no business logic duplicated in SQL) to pick the better of the two parents' plans, derives `maxObservers`, and compares to the observer's rank. If over quota, a new full-screen gate replaces the app, following the exact pattern of the existing `removedObserver`/`EmailVerifyGate` gates in `App()`.

**Tech Stack:** Supabase Postgres (SQL migration, `plpgsql` `SECURITY DEFINER` function), React (existing `App.jsx`, no new files).

## Global Constraints

- Family's effective plan = **the better of the two parents' individual plans** (per the approved spec, `docs/superpowers/specs/2026-07-14-observer-quota-enforcement-design.md`) — not just the family creator's.
- The blocked observer sees a **new dedicated screen** (not a reuse of the existing "Accès retiré" removed-observer page) — must make clear this is a plan limit, not a removal, and must NOT suggest permanent loss of access.
- This is an application-level gate, matching every other Freemium/Trial limit already in this codebase (`maxChildren`, `maxCustomDates`, etc.) — **no RLS changes beyond the new RPC itself**, and the RPC must never expose any subscription row outside the caller's own family's parents.
- All new full-screen gate `return`s in `App()` must be placed **after every hook call** in the component (matching the existing gates at `App.jsx:4464-4499`) — this codebase hit a real "Rendered fewer hooks than expected" production crash (commit `db4e532`) from a gate placed before a later hook; do not repeat that mistake.
- `TZ=Europe/Paris npm test` must stay green (136 tests) after every task — this plan adds no new pure logic, so no new unit tests are required, but the existing suite must not regress.
- `npm run build` must succeed after every task.
- Bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) together by +0.01 only in the FINAL task, not earlier ones (per this project's CLAUDE.md convention — this session already had one implementer accidentally add an out-of-scope version bump in a shared task, don't repeat it).
- The current version at plan start is **v1.80**.

---

### Task 1: Migration — `get_family_billing_context()` RPC

**Files:**
- Create: `supabase/migrations/0036_family_billing_context.sql`

**Interfaces:**
- Produces: a Postgres function `public.get_family_billing_context()` callable via `supabase.rpc("get_family_billing_context")` from an authenticated client. Returns zero or more rows shaped `{ parent_plan: text, parent_premium_since: timestamptz|null, parent_cycle: text|null, parent_trial_start: timestamptz|null, parent_trial_extension_days: int|null, parent_account_created_at: timestamptz|null, my_observer_rank: int }` — one row per active parent in the caller's family, each row repeating the same `my_observer_rank` value (the caller's own rank, constant across rows — simplest shape for a `returns table` function, the client only needs `data[0]?.my_observer_rank` for the rank and maps every row for the parent plans). Raises a Postgres exception (caught as `error` in the JS client) if the caller isn't an active observer in any family.
- Consumes: existing tables `public.family_members` (columns used: `user_id`, `family_id`, `role`, `status`, `created_at`) and `public.subscriptions` (columns used: `user_id`, `plan`, `premium_since`, `cycle`, `trial_start`, `trial_extension_days`, `account_created_at` — these exact column names are already read by the existing client code at `App.jsx:3332-3344`).

This migration is deployed by the user pasting it into the Supabase SQL Editor (this environment has no direct Supabase CLI/DB access) — it is not applied automatically by any task here.

- [ ] **Step 1: Write the migration file**

```sql
-- 0036_family_billing_context.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- RPC utilisée par un observateur pour connaître, en une fois : (a) les
-- abonnements des parents de SA PROPRE famille (jamais d'une autre famille —
-- aucun paramètre n'est accepté, tout est dérivé de auth.uid()), et (b) son
-- propre rang parmi les observateurs actifs de cette famille. Le calcul du
-- plan effectif (fenêtre de trial, bêta, extensions de parrainage...) reste
-- entièrement côté client (subStatus()/getPerms() dans App.jsx) — cette RPC
-- ne fait que lever la restriction RLS pour livrer les données brutes
-- nécessaires, jamais celles d'une famille tierce.
--
-- Contexte : backlog 17d (limite d'observateurs pendant le Trial) n'était
-- jusqu'ici appliqué que côté écran de config du parent (v1.79-1.80) — un
-- observateur en trop gardait un accès complet s'il se connectait sur son
-- propre appareil. Cette RPC est le premier pas pour un vrai blocage côté
-- observateur (voir Task 2 pour le câblage client).
--
-- À exécuter sur Supabase APRÈS 0035. Idempotent (réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) Défensif : `created_at` sur family_members. La table existe depuis avant
--    l'historique de migrations de ce repo (créée directement au tableau de
--    bord) — cette colonne existe presque certainement déjà (c'est la
--    convention par défaut de Supabase), mais on le garantit sans risque.
alter table public.family_members add column if not exists created_at timestamptz not null default now();

create or replace function public.get_family_billing_context()
returns table (
  parent_plan                 text,
  parent_premium_since        timestamptz,
  parent_cycle                text,
  parent_trial_start          timestamptz,
  parent_trial_extension_days int,
  parent_account_created_at   timestamptz,
  my_observer_rank             int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_family_id   uuid;
  v_role        text;
  v_created_at  timestamptz;
  v_rank        int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select family_id, role, created_at into v_family_id, v_role, v_created_at
    from public.family_members
   where user_id = v_uid and status = 'active'
   limit 1;

  if v_family_id is null then
    raise exception 'no_family';
  end if;

  if v_role <> 'observer' then
    raise exception 'not_an_observer';
  end if;

  select count(*) into v_rank
    from public.family_members
   where family_id = v_family_id
     and role = 'observer'
     and status = 'active'
     and created_at < v_created_at;

  return query
    select s.plan, s.premium_since, s.cycle, s.trial_start, s.trial_extension_days, s.account_created_at, v_rank
      from public.subscriptions s
      join public.family_members fm on fm.user_id = s.user_id
     where fm.family_id = v_family_id
       and fm.role = 'parent'
       and fm.status = 'active';
end;
$$;

-- Réservé aux comptes authentifiés (même pattern que set_member_identity, 0015).
revoke all     on function public.get_family_billing_context() from public;
grant  execute on function public.get_family_billing_context() to authenticated;
```

- [ ] **Step 2: Ask the user to run this migration in the Supabase SQL Editor**

This cannot be run from this environment (no direct DB/CLI access). Report the exact file path and ask the user to paste its contents into the Supabase SQL Editor and run it, confirming "Success. No rows returned" (or equivalent) before Task 2 is considered testable end-to-end. Client code in Task 2 can still be written and built/unit-tested without this having run yet, but it cannot be *live*-verified until it has.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0036_family_billing_context.sql
git commit -m "Add get_family_billing_context RPC for observer-quota enforcement"
```

---

### Task 2: Client wiring — quota check, gate screen, retry

**Files:**
- Modify: `src/App.jsx`
  - Add a module-level helper near `getPerms()` (currently `App.jsx:318-348`).
  - Add state/effect inside `App()`, near the existing `emailVerified` state/effect (currently `App.jsx:3216-3229`).
  - Add the new full-screen gate `return`, near the existing `removedObserver` gate (currently `App.jsx:4464-4479`).
- Modify: `src/config.js` (version bump)
- Modify: `public/sw.js` (version bump)

**Interfaces:**
- Consumes: `supabase.rpc("get_family_billing_context", { p_family_id })` (Task 1's RPC, revised after review to take an optional `p_family_id uuid default null` param — rows shaped as documented above; the plan below always passes the caller's own `familySync.familyId` to avoid the non-determinism the review flagged for accounts active in multiple families); existing module-level `subStatus(sub)` and `getPerms(sub)` (`App.jsx:292`, `App.jsx:318`, unchanged signatures); existing `isObs` (`App.jsx:3936`), `familySync.familyId` (`App.jsx:2582`), `handleSetUser` (`App.jsx:3536`), `C`/theme object.
- Produces: module-level function `planRankFor(sub)` and `familyMaxObservers(parentSubRows)` (used only within this task, not consumed elsewhere); `App()`-local state `observerOverQuota` (boolean) and `checkObserverQuota` (a stable `useCallback`, also used as the "🔄 Réessayer" button's `onClick`).

- [ ] **Step 1: Add the two module-level helper functions**

Insert immediately after the closing brace of `getPerms(sub)` (`App.jsx:348`, right before `function isAdmin(user) {`):

```js
// Rang d'un plan pour comparaison : freemium < trial/earned/bêta < premium.
// Utilisé uniquement pour choisir le "meilleur" des deux plans parents.
function planRankFor(sub) {
  const s = subStatus(sub);
  if (s === "premium") return 2;
  if (s === "trial_premium" || s === "earned_premium") return 1;
  return 0; // freemium
}

// À partir des lignes brutes renvoyées par get_family_billing_context()
// (une par parent actif), calcule le quota d'observateurs de la famille en
// retenant le MEILLEUR des deux plans parents — décision produit explicite
// (voir docs/superpowers/specs/2026-07-14-observer-quota-enforcement-design.md).
// Aucun parent trouvé (cas défensif, ne devrait pas arriver) → le plus
// restrictif (1), jamais Infinity par défaut.
//
// 🔧 Après la review du Task 1, la RPC fait désormais un LEFT JOIN vers
// subscriptions : un parent actif peut donc arriver ici avec parent_plan
// NULL (pas encore de ligne — l'upsert client est débounce de 3s). On ne
// veut PAS que ce cas se traduise par subStatus() en "freemium" par défaut
// (Date invalide → comparaison NaN → false → repli sur freemium) : ce serait
// le sens d'erreur le plus dommageable (verrouiller à tort un observateur
// d'une famille déjà payante juste parce que la synchro n'a pas eu le temps
// de se faire). On traite donc un parent sans ligne comme un compte tout
// juste créé en Trial (le défaut réel de makeSub() pour tout nouveau compte).
function familyMaxObservers(parentRows) {
  if (!parentRows || parentRows.length === 0) return 1;
  const subs = parentRows.map(r => r.parent_plan ? {
    plan: r.parent_plan,
    premiumSince: r.parent_premium_since,
    cycle: r.parent_cycle,
    trialStart: r.parent_trial_start,
    trialExtension: r.parent_trial_extension_days,
    accountCreatedAt: r.parent_account_created_at,
  } : {
    plan: "trial_premium",
    accountCreatedAt: new Date().toISOString(),
    trialStart: new Date().toISOString(),
    trialExtension: 0,
  });
  const best = subs.reduce((acc, s) => planRankFor(s) > planRankFor(acc) ? s : acc, subs[0]);
  return getPerms(best).maxObservers;
}
```

- [ ] **Step 2: Add the state/effect inside `App()`**

Insert immediately after the existing `emailVerified` effect block ends (`App.jsx:3229`, right after the closing `}, [user?.id, user?.role, pendingUser?.id, pendingUser?.role]);` line), before the `verify_email` URL-token effect that currently follows it:

```js
  // 🔒 Backlog 17d (suite) : un observateur au-delà du quota du plan de sa
  // famille (1 pendant Freemium/Trial, illimité en Premium) doit être bloqué
  // sur SA PROPRE session, pas seulement caché/verrouillé côté écran de
  // config du parent (déjà en place depuis v1.79-1.80). Fail-open en cas
  // d'erreur réseau/RPC : ce n'est pas une frontière de sécurité (comme les
  // autres limites Freemium/Trial de cette app, aucune n'a de RLS dédiée),
  // juste une incitation commerciale — un faux blocage serait pire qu'un
  // faux négatif temporaire.
  const [observerOverQuota, setObserverOverQuota] = useState(false);
  const checkObserverQuota = useCallback(async () => {
    if (!isObs || !familySync.familyId) { setObserverOverQuota(false); return; }
    try {
      const { data, error } = await supabase.rpc("get_family_billing_context", { p_family_id: familySync.familyId });
      if (error) return;
      const rows = data || [];
      const rank = rows[0]?.my_observer_rank ?? 0;
      setObserverOverQuota(rank >= familyMaxObservers(rows));
    } catch (e) {
      console.error("[Duvia] get_family_billing_context error:", e);
    }
  }, [isObs, familySync.familyId]);
  useEffect(() => { checkObserverQuota(); }, [checkObserverQuota]);
```

- [ ] **Step 3: Add the gate screen render**

Insert immediately after the existing `removedObserver` gate's closing `);` (`App.jsx:4479`), before the `if(user?.role === "parent" && emailVerified === false) {` block that currently follows it:

```jsx
  // Page de blocage pour observateur hors quota du plan — PAS un retrait
  // (voir removedObserver ci-dessus, volontairement un écran différent).
  if (isObs && observerOverQuota) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,background:C.bg}}>
      <div style={{textAlign:"center",maxWidth:340}}>
        <div style={{fontSize:48,marginBottom:12}}>⏳</div>
        <div style={{fontWeight:900,fontSize:18,marginBottom:10,color:C.txt}}>Accès en pause — limite du plan</div>
        <div style={{fontSize:14,color:C.mut,lineHeight:1.7,marginBottom:24}}>
          Le plan actuel de cette famille ne permet qu'un nombre limité d'observateurs. Tu n'as pas été retiré(e) — demande à un parent de passer au Premium pour retrouver l'accès.
        </div>
        <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
          <button onClick={checkObserverQuota}
            style={{height:44,padding:"0 20px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontSize:13,fontWeight:800,borderRadius:10,border:"none",cursor:"pointer"}}>
            🔄 Réessayer
          </button>
          <button onClick={()=>handleSetUser(null)}
            style={{height:44,padding:"0 24px",background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,fontSize:13,borderRadius:10}}>
            Se déconnecter
          </button>
        </div>
      </div>
    </div>
  );
```

- [ ] **Step 4: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 136`, `pass 136`, `fail 0` (unchanged — this task adds no pure logic covered by `core.test.js`).

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build succeeds, no new warnings beyond the pre-existing chunk-size notice.

- [ ] **Step 6: Bump the version**

In `src/config.js`:
```js
export const APP_VERSION = "1.81";
```
In `public/sw.js`:
```js
const SW_VERSION = "1.81";
```

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Block observer access when over the family's plan observer quota"
```

---

## Post-plan manual verification (not automatable in this environment)

1. User runs Task 1's migration in the Supabase SQL Editor.
2. With 2 parent accounts + 2 observer accounts on the same family (Trial plan, quota=1): the 2nd (later-joined) observer's own login should show the new "Accès en pause" screen, NOT the normal app.
3. Using the existing dev/admin panel that lets an account simulate different `sub` states (`App.jsx:14806-14825`), set one of the two parent accounts to `premium` → click "🔄 Réessayer" on the blocked observer's screen (no logout/login needed) → access should be restored (screen disappears, normal app renders).
4. Confirm the 1st (earlier-joined) observer is NEVER blocked regardless of the 2nd observer's state.
5. Confirm a network failure (e.g., briefly going offline) while the RPC call is in flight does not itself lock out an observer who was previously fine (fail-open behavior).
