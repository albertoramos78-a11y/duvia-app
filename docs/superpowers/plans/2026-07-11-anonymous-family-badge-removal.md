# Suppression du compte anonyme de synchronisation famille — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `useFamilySync` from silently creating a throwaway anonymous Supabase account + blank family on every page load with no session, and clean up the orphaned rows this already produced in production.

**Architecture:** One `useEffect` in `App.jsx` currently calls `supabase.auth.signInAnonymously()` whenever it finds no existing session, then creates a family for that anonymous account. Nothing in the app ever reads that family before a real login/registration, and the mechanism is the confirmed root cause of a stale-`familyId` bug (RLS 403s) after a real account replaces the anonymous session. The fix removes the anonymous sign-in/family-creation branch entirely, leaving the real-account family-creation branch (already fixed and shipped as v1.54) completely untouched. A companion one-time SQL migration cleans up pre-existing orphaned anonymous accounts/families in production, without touching any family that's empty for an unrelated, legitimate reason (e.g. a solo user who deleted their account).

**Tech Stack:** React (single-file `src/App.jsx`), Supabase Auth/Postgres, `node --test` for the existing pure-function suite.

## Global Constraints

- Replace App.jsx:1658-1663 with the exact replacement code in Task 1, Step 1 below — no other line in that range changes.
- Do NOT modify anything in App.jsx:1785-1833 (the real-account family-creation branch, fixed in commit `b83ddcc`/v1.54) — verify it is byte-identical after the change.
- New migration file must be named exactly `supabase/migrations/0033_cleanup_anonymous_families.sql` and contain the SQL from Task 1, Step 3 below verbatim — it is not executed by any script or test in this repo; the user runs it manually in the Supabase SQL editor after this ships.
- Bump `APP_VERSION` in `src/config.js` from `"1.56"` to `"1.57"`, and `SW_VERSION` in `public/sw.js` from `"1.56"` to `"1.57"`, in the same commit as the code change.
- Test command: `TZ=Europe/Paris npm test` (must stay at 122 passing — no new test is expected, this is a behavioral change in an existing effect with no new pure function). Build command: `npm run build`.

---

### Task 1: Remove eager anonymous account creation, add cleanup migration, bump version

**Files:**
- Modify: `src/App.jsx:1658-1663`
- Modify: `src/config.js:13` (`APP_VERSION`)
- Modify: `public/sw.js:13` (`SW_VERSION`)
- Create: `supabase/migrations/0033_cleanup_anonymous_families.sql`

**Interfaces:**
- Consumes: nothing new — this task only edits the body of the existing `useFamilySync` effect (`App.jsx:1537`). `setSyncStatus`, `setFamilyIdBoth`, and the `cancelled` closure variable already exist in this scope and are used as-is.
- Produces: nothing consumed by other tasks — this is the only task in this plan.

- [ ] **Step 1: Replace the anonymous sign-in block in `useFamilySync`**

In `src/App.jsx`, find this exact block (currently at lines 1658-1663):

```js
        // 1. S'assurer d'avoir une session (compte anonyme automatique)
        const { data: sessData } = await supabase.auth.getSession();
        if (!sessData?.session) {
          const { error: signErr } = await supabase.auth.signInAnonymously();
          if (signErr) throw signErr;
        }
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData?.user?.id;
        if (!uid) throw new Error("no-uid");
```

Replace it with:

```js
        // 1. Sans session réelle, rien à synchroniser — on ne crée plus de compte
        // anonyme ici (2026-07-11, backlog item 15) : rien dans l'app ne lit une
        // famille avant une vraie connexion/inscription, et créer un compte
        // jetable était la cause d'un bug réel (familyId resté accroché à cette
        // famille fantôme après le passage au vrai compte). Une vraie
        // connexion/inscription redémarre cet effet proprement (nouveau montage
        // après duviaReload()/reload de session) et retombe alors dans la branche
        // ci-dessous avec un vrai uid.
        const { data: sessData } = await supabase.auth.getSession();
        if (!sessData?.session) {
          if (!cancelled) setSyncStatus("synced");
          return;
        }
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData?.user?.id;
        if (!uid) throw new Error("no-uid");
```

The only functional difference: instead of calling `signInAnonymously()` and continuing, the effect now returns immediately, leaving `familyId` at its initial `null` value, when there is no session.

- [ ] **Step 2: Verify the real-account branch is untouched**

Read `src/App.jsx` lines 1785-1833 (the `if (!familyId) { ... }` block that creates a family for a real, already-authenticated account) and confirm it is byte-for-byte identical to what it was before Step 1 — Step 1 only touches lines 1658-1663, several hundred lines above, so this should require no edit. This is a read-only verification, not a code change.

- [ ] **Step 3: Create the cleanup migration**

Create `supabase/migrations/0033_cleanup_anonymous_families.sql` with exactly this content:

```sql
-- 0033_cleanup_anonymous_families.sql
--
-- Nettoyage ponctuel des comptes/familles "anonymes" créés par l'ancien
-- mécanisme de "badge invisible" de useFamilySync (App.jsx), retiré dans la
-- même livraison (2026-07-11). Ces comptes ne sont jamais rejoints par un
-- vrai utilisateur — le mécanisme ne fait que créer sa propre famille,
-- jamais rejoindre une famille existante — donc sûrs à nettoyer.
--
-- À exécuter UNE SEULE FOIS, manuellement, dans l'éditeur SQL Supabase.
-- Ne dépend d'aucune autre migration. N'est appelé par aucun code de l'app.

-- ── Aperçu (à lire avant de lancer la suppression) ──────────────────────────
select count(*) as comptes_anonymes from auth.users where is_anonymous = true;

select count(*) as familles_uniquement_anonymes from families f
  where exists (select 1 from family_members fm where fm.family_id = f.id)
  and not exists (
    select 1 from family_members fm
    join auth.users u on u.id = fm.user_id
    where fm.family_id = f.id and u.is_anonymous is not true
  );

-- ── Suppression ──────────────────────────────────────────────────────────────
-- a) capturer D'ABORD les familles dont TOUS les membres actuels sont
-- anonymes (au moins un membre, et aucun membre non-anonyme) — une famille
-- déjà vide pour une autre raison (ex: suppression de compte d'un
-- utilisateur seul, voir leaveAllFamiliesOnDelete dans App.jsx) n'a aucune
-- ligne family_members et n'apparaît donc jamais ici.
create temporary table _anon_only_families as
select f.id from families f
  where exists (select 1 from family_members fm where fm.family_id = f.id)
  and not exists (
    select 1 from family_members fm
    join auth.users u on u.id = fm.user_id
    where fm.family_id = f.id and u.is_anonymous is not true
  );

-- b) supprimer les adhésions puis les familles ainsi identifiées
delete from family_members where family_id in (select id from _anon_only_families);
delete from families where id in (select id from _anon_only_families);

-- c) filet de sécurité : si un compte anonyme s'était par ailleurs
-- retrouvé membre d'une famille contenant AUSSI un vrai membre (le
-- mécanisme actuel ne crée jamais ce cas, mais coûte rien à couvrir), ne
-- retirer que sa ligne d'adhésion — la famille elle-même n'est pas touchée.
delete from family_members
  where user_id in (select id from auth.users where is_anonymous = true);

-- d) plus aucune ligne family_members ne peut référencer un compte
-- anonyme à ce stade → suppression sûre des comptes eux-mêmes
delete from auth.users where is_anonymous = true;

drop table _anon_only_families;
```

This file is created only — it is not run, sourced, or tested by anything in this repo. No test step applies to it.

- [ ] **Step 4: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `# pass 122` (same count as before this change — no test references `signInAnonymously` or this effect's session branch, since it depends on a live Supabase session).

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build succeeds with no errors (this is a same-file edit, no new imports or syntax changes beyond the block replaced in Step 1).

- [ ] **Step 6: Bump version**

In `src/config.js`, change line 13:
```js
export const APP_VERSION = "1.56";
```
to:
```js
export const APP_VERSION = "1.57";
```

In `public/sw.js`, change line 13:
```js
const SW_VERSION = "1.56";
```
to:
```js
const SW_VERSION = "1.57";
```

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js supabase/migrations/0033_cleanup_anonymous_families.sql
git commit -m "$(cat <<'EOF'
Stop creating a throwaway anonymous account/family on every page load

useFamilySync silently called signInAnonymously() and created a blank
family whenever no session existed. Nothing in the app ever reads that
family before a real login/registration, and it was the confirmed root
cause of a stale-familyId bug (RLS 403s) once the real account replaced
the anonymous session in the same page load. Now the effect simply does
nothing until a real session exists.

Includes a one-time cleanup migration for the orphaned anonymous
accounts/families this already produced in production.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Partie 1 (code change) → Task 1 Steps 1-2. Partie 2 (cleanup migration) → Task 1 Step 3. Test/verification section → Task 1 Steps 4-5. Version bump → Task 1 Step 6. All spec sections are covered by this single task.
- **Placeholder scan:** no TBD/TODO; every step has literal code or an exact command.
- **Type consistency:** n/a (no new functions/interfaces introduced — this task only replaces a code block in place).
