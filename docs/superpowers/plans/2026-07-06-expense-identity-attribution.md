# Expense/Reimbursement Legal Identity Attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it so a departed parent's name still appears correctly (as "Name (parti)") on every expense/reimbursement they created or paid, forever — even after their old position slot (0 or 1) is reused by a new person.

**Architecture:** Add immutable identity columns (`*_user_id` + `*_name` snapshot) to `expenses` and `reimbursements` alongside the existing position-index columns (kept, unchanged, for current-balance math). Populate the new columns once, at creation time, from the real Supabase user id/name. Detect "departed" via `family_members.status = 'removed'` (permanent per user, never recycled) rather than via the recyclable `cfg.parents` array. Every UI/PDF site that currently reads `cfg.parents[e.createdBy]`/`cfg.parents[e.paidBy]`/`cfg.parents[r.from]`/`cfg.parents[r.to]` for a *name* switches to the snapshot name (falling back to the live position lookup only for pre-existing rows created before this change).

**Tech Stack:** React + Vite, Supabase (Postgres + RLS), TypeScript service layer (`src/services/supabase/expenseService.ts`), plain JS hooks/components (`src/hooks/useExpenses.ts`, `src/App.jsx`), `node --test` for pure-function unit tests.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-07-06-expense-identity-attribution-design.md`.
- Do **not** remove or change the meaning of the existing `paid_by`/`created_by`/`from_parent`/`to_parent` position-index columns — they remain the source for current-balance/split calculations (`totals`, `owed`, `reimSent`, `reimReceived`, `balance` in `App.jsx`).
- No backfill of existing rows: new columns start `NULL` for rows created before this change ships. Do not write a backfill script.
- Tests: `TZ=Europe/Paris npm test` must stay at 100% pass. Any new pure logic goes in `src/utils/core.js` with a matching test in `src/utils/core.test.js` (existing project convention — see `CLAUDE.md`).
- Every task ends with `npm run build` passing (this project has no automated UI/component tests — verify UI changes by describing the manual browser check in the task, do not invent a test framework that doesn't exist here).
- This repo's `node_modules` is not committed; run `npm install` once if commands fail with "vite: command not found" or similar.
- SQL migrations are run by the user in the Supabase SQL Editor (no DB credentials available in this environment) — see `docs/superpowers/specs/2026-07-06-expense-identity-attribution-design.md` and prior conversation for that workflow. The task that adds a migration file ends with "hand the SQL to the user to run", not with running it yourself.

---

### Task 1: Migration — identity columns on `expenses` and `reimbursements`

**Files:**
- Create: `supabase/migrations/0021_expense_identity.sql`

**Interfaces:**
- Produces: columns `expenses.created_by_user_id (uuid)`, `expenses.created_by_name (text)`, `expenses.paid_by_user_id (uuid)`, `expenses.paid_by_name (text)`; `reimbursements.from_user_id (uuid)`, `reimbursements.from_name (text)`, `reimbursements.to_user_id (uuid)`, `reimbursements.to_name (text)`. All nullable, no default, no backfill.

- [ ] **Step 1: Write the migration file**

```sql
-- 0021_expense_identity.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Attribution légale des dépenses/remboursements : identité figée à la création.
--
-- Problème corrigé : created_by/paid_by (expenses) et from_parent/to_parent
-- (reimbursements) sont des index de position (0/1) dans cfg.parents. Un
-- créneau de position est recyclé quand un parent quitte puis qu'un nouveau
-- parent est invité (confirmInvite réutilise l'index) — donc un même index
-- désigne légitimement des personnes différentes au fil du temps. Résultat
-- observé : après le départ du parent 0 et la fermeture de sa carte, ses
-- anciennes dépenses s'affichent comme créées par la personne qui occupe
-- maintenant l'index 0.
--
-- Solution : on ajoute, en plus des colonnes de position (conservées telles
-- quelles pour le calcul du solde courant entre "les 2 parents actuels"),
-- une identité figée à la création : le vrai user_id Supabase + un instantané
-- du nom au moment des faits. Ni l'un ni l'autre ne changent plus jamais,
-- même si la personne renomme son profil ou que son créneau est recyclé.
--
-- Pas de backfill : les lignes déjà créées avant cette migration gardent ces
-- colonnes à NULL — l'affichage retombe sur le comportement actuel (résolution
-- par index) pour elles, inchangé. Voir le design doc pour le détail complet :
-- docs/superpowers/specs/2026-07-06-expense-identity-attribution-design.md
--
-- À exécuter APRÈS 0020. Idempotent (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS created_by_name    TEXT,
  ADD COLUMN IF NOT EXISTS paid_by_user_id    UUID,
  ADD COLUMN IF NOT EXISTS paid_by_name       TEXT;

ALTER TABLE public.reimbursements
  ADD COLUMN IF NOT EXISTS from_user_id UUID,
  ADD COLUMN IF NOT EXISTS from_name    TEXT,
  ADD COLUMN IF NOT EXISTS to_user_id   UUID,
  ADD COLUMN IF NOT EXISTS to_name      TEXT;
```

- [ ] **Step 2: Introspection query for the user to confirm no pre-existing conflicting columns**

Hand this to the user to run in the Supabase SQL Editor **before** the migration above, same workflow as migration 0020 earlier in this project:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('expenses', 'reimbursements')
  and column_name in ('created_by_user_id','created_by_name','paid_by_user_id','paid_by_name',
                       'from_user_id','from_name','to_user_id','to_name');
```

Expected: zero rows returned (columns don't exist yet). If any row comes back, stop and re-check the migration before proceeding — do not blindly run it.

- [ ] **Step 3: Hand the migration SQL to the user to run in the Supabase SQL Editor**

Wait for confirmation ("Success. No rows returned" or similar) before starting Task 2.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0021_expense_identity.sql
git commit -m "Add expense/reimbursement identity columns (migration 0021)"
```

---

### Task 2: Pure helper — `formatActorName`

**Files:**
- Modify: `src/utils/core.js`
- Test: `src/utils/core.test.js`

**Interfaces:**
- Produces: `formatActorName(name: string, userId: string|null|undefined, removedUserIds: Set<string>|null|undefined): string` — returns `name` unchanged if `!userId`, `!removedUserIds`, or `!removedUserIds.has(userId)`; returns `` `${name} (parti)` `` otherwise. Returns `""` if `name` is falsy.
- Consumed by: Task 7 and Task 8 (display sites in `App.jsx`).

- [ ] **Step 1: Write the failing tests**

Add to `src/utils/core.test.js` (follow the existing `describe`/`test` style already used in that file for `reconcileOwnParentSlot` etc. — open the file first and match its exact import/test syntax before adding these):

```js
test("formatActorName : renvoie le nom tel quel si la personne est toujours active", () => {
  const removed = new Set(["uid-toti"]);
  assert.strictEqual(formatActorName("Sissi", "uid-sissi", removed), "Sissi");
});

test("formatActorName : ajoute (parti) si le userId est dans removedUserIds", () => {
  const removed = new Set(["uid-toti"]);
  assert.strictEqual(formatActorName("Toti", "uid-toti", removed), "Toti (parti)");
});

test("formatActorName : pas de userId → nom tel quel (ancienne ligne sans instantané)", () => {
  const removed = new Set(["uid-toti"]);
  assert.strictEqual(formatActorName("Parent 1", null, removed), "Parent 1");
});

test("formatActorName : removedUserIds absent (famille pas encore chargée) → nom tel quel", () => {
  assert.strictEqual(formatActorName("Toti", "uid-toti", null), "Toti");
});

test("formatActorName : nom vide → chaîne vide", () => {
  assert.strictEqual(formatActorName("", "uid-toti", new Set(["uid-toti"])), "");
});
```

Add `formatActorName` to the existing `import { ... } from "./core.js"` line at the top of `core.test.js` rather than writing a second import statement.

- [ ] **Step 2: Run tests to verify they fail**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: FAIL — `formatActorName is not a function` (or `undefined`) on all 5 new tests. The pre-existing tests in the file still pass.

- [ ] **Step 3: Implement the function**

Add to `src/utils/core.js` (near the other parent-related helpers like `insertValidatedParent`/`reconcileOwnParentSlot`):

```js
// ── Attribution légale dépenses/remboursements ───────────────────────────────
// Le nom est un instantané figé à la création (voir 0021_expense_identity.sql) :
// il ne dépend jamais du créneau de position actuel, qui peut être recyclé.
// "removedUserIds" vient de family_members.status='removed' (jamais recyclé),
// pas de cfg.parents.left (qui, lui, suit le créneau, pas la personne).
export function formatActorName(name, userId, removedUserIds) {
  if (!name) return "";
  if (userId && removedUserIds && removedUserIds.has(userId)) return `${name} (parti)`;
  return name;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=Europe/Paris node --test src/utils/core.test.js`
Expected: all tests pass, including the 5 new ones.

- [ ] **Step 5: Run the full suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 63`, `pass 63`, `fail 0` (58 pre-existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/utils/core.js src/utils/core.test.js
git commit -m "Add formatActorName helper for legal attribution display"
```

---

### Task 3: Expose `removedUserIds` from `useFamilySync`

**Files:**
- Modify: `src/App.jsx:1410-1421` (state declarations inside `function useFamilySync(cfg, setCfg) {`)
- Modify: `src/App.jsx:1721-1734` (existing reconciliation effect)
- Modify: `src/App.jsx:2318` (hook's returned object)

**Interfaces:**
- Consumes: nothing new (reuses the existing `family_members` query already made in the reconciliation effect).
- Produces: `familySync.removedUserIds` — a `Set<string>` of every `user_id` in the current family with `family_members.status === 'removed'`. Available anywhere `familySync` is (it already is, via `useApp()` — see Task 5).

- [ ] **Step 1: Add the state**

In `src/App.jsx`, inside `function useFamilySync(cfg, setCfg) {` (starts at line 1410), find:

```js
  const [removedObserver, setRemovedObserver] = useState(false); // observateur retiré → page no-access
```

Add immediately after it:

```js
  const [removedUserIds, setRemovedUserIds] = useState(() => new Set()); // family_members.status='removed' — jamais recyclé, contrairement à cfg.parents
```

- [ ] **Step 2: Populate it in the existing reconciliation effect**

Find this block (around line 1721-1734):

```js
          // 🔧 Réconciliation parents : marquer « parti » (left) si inactif
          try {
            const { data: mems } = await supabase
              .from("family_members").select("user_id,status").eq("family_id", familyId);
            const active = new Set((mems || []).filter(m => m.status === "active").map(m => m.user_id));
            const inactive = new Set((mems || []).filter(m => m.status !== "active").map(m => m.user_id));
            let myEmail2 = ""; try { myEmail2 = JSON.parse(window.localStorage.getItem("duvia_session") || "null") || ""; } catch {}
            if (inactive.size && !cancelled) {
              setCfg(c => {
                const next = markDepartedParents(c.parents, { activeIds: active, inactiveIds: inactive, myUid: uid, myEmail: myEmail2 });
                return next ? { ...c, parents: next } : c;
              });
            }
          } catch {}
```

Replace with (adds one line computing `removed` specifically from `status === "removed"` — note this is narrower than `inactive`, which also includes `"pending"`; `formatActorName` must never show "(parti)" for someone who simply hasn't accepted their invite yet):

```js
          // 🔧 Réconciliation parents : marquer « parti » (left) si inactif
          try {
            const { data: mems } = await supabase
              .from("family_members").select("user_id,status").eq("family_id", familyId);
            const active = new Set((mems || []).filter(m => m.status === "active").map(m => m.user_id));
            const inactive = new Set((mems || []).filter(m => m.status !== "active").map(m => m.user_id));
            const removed = new Set((mems || []).filter(m => m.status === "removed").map(m => m.user_id));
            if (!cancelled) setRemovedUserIds(removed);
            let myEmail2 = ""; try { myEmail2 = JSON.parse(window.localStorage.getItem("duvia_session") || "null") || ""; } catch {}
            if (inactive.size && !cancelled) {
              setCfg(c => {
                const next = markDepartedParents(c.parents, { activeIds: active, inactiveIds: inactive, myUid: uid, myEmail: myEmail2 });
                return next ? { ...c, parents: next } : c;
              });
            }
          } catch {}
```

- [ ] **Step 3: Return it from the hook**

Find the hook's return statement (line 2318):

```js
  return { syncStatus, familyId, families, joinFamily, linkAccount, signInExisting, switchFamily, createNewFamily, refreshFamilies, joinFamilyByToken, pendingMembers, refreshPendingMembers, validateMember, rejectMember, removeFamilyMember, leaveFamily, pendingApproval, removedObserver };
```

Replace with:

```js
  return { syncStatus, familyId, families, joinFamily, linkAccount, signInExisting, switchFamily, createNewFamily, refreshFamilies, joinFamilyByToken, pendingMembers, refreshPendingMembers, validateMember, rejectMember, removeFamilyMember, leaveFamily, pendingApproval, removedObserver, removedUserIds };
```

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: build succeeds, no new warnings referencing `removedUserIds`.

- [ ] **Step 5: Manual check**

Run the app locally (`npm run dev`), log in to a family that has at least one departed parent (or reuse the test accounts from the earlier invitation-flow QA session). Add a temporary `console.log(familySync.removedUserIds)` inside `ConfigTab` or `ExpTab`, confirm it logs a `Set` containing the departed parent's real `user_id` (cross-check against the `family_members` table via the SQL Editor: `select user_id, status from family_members where family_id = '<id>'`). Remove the temporary `console.log` before committing.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Expose removedUserIds from useFamilySync"
```

---

### Task 4: `expenseService.ts` — extend types and DB mappers

**Files:**
- Modify: `src/services/supabase/expenseService.ts`

**Interfaces:**
- Produces: `Expense.createdByUserId?: string|null`, `Expense.createdByName?: string|null`, `Expense.paidByUserId?: string|null`, `Expense.paidByName?: string|null`; `Reimbursement.fromUserId?: string|null`, `Reimbursement.fromName?: string|null`, `Reimbursement.toUserId?: string|null`, `Reimbursement.toName?: string|null`. `dbToExpense`/`expenseToDb`/`dbToReimbursement`/`reimbursementToDb` read/write the matching snake_case columns from Task 1.
- Consumed by: Task 6 (creation call sites in `App.jsx`), Task 7/8 (display call sites).

- [ ] **Step 1: Extend the `Expense` interface**

In `src/services/supabase/expenseService.ts`, find:

```ts
export interface Expense {
  id: string;
  label: string;
  amount: number;
  paidBy: number;
  split: number;
  category: string;
  date: string | null;
  note: string;
  attachments: any[];
  recurring: boolean;
  recurringFreq: string | null;
  recurringEnd: string | null;
  recurringId: string | null;
  recurringStart: string | null;
  status: string;
  createdBy: number;
  createdAt: string;
}
```

Replace with:

```ts
export interface Expense {
  id: string;
  label: string;
  amount: number;
  paidBy: number;
  paidByUserId: string | null;
  paidByName: string | null;
  split: number;
  category: string;
  date: string | null;
  note: string;
  attachments: any[];
  recurring: boolean;
  recurringFreq: string | null;
  recurringEnd: string | null;
  recurringId: string | null;
  recurringStart: string | null;
  status: string;
  createdBy: number;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Extend the `Reimbursement` interface**

Find:

```ts
export interface Reimbursement {
  id: string;
  from: number;   // index parent émetteur
  to: number;     // index parent destinataire
  amount: number;
  date: string | null;
  note: string;
  status: string;
  createdAt: string;
}
```

Replace with:

```ts
export interface Reimbursement {
  id: string;
  from: number;   // index parent émetteur
  fromUserId: string | null;
  fromName: string | null;
  to: number;     // index parent destinataire
  toUserId: string | null;
  toName: string | null;
  amount: number;
  date: string | null;
  note: string;
  status: string;
  createdAt: string;
}
```

- [ ] **Step 3: Update `dbToExpense` and `expenseToDb`**

Find:

```ts
export function dbToExpense(row: Record<string, any>): Expense {
  return {
    id:             row.id,
    label:          row.label ?? "",
    amount:         Number(row.amount ?? 0),
    paidBy:         row.paid_by ?? 0,
    split:          row.split_pct ?? 50,
    category:       row.category ?? "",
    date:           row.date ?? null,
    note:           row.note ?? "",
    attachments:    row.attachments ?? [],
    recurring:      row.recurring ?? false,
    recurringFreq:  row.recurring_freq ?? null,
    recurringEnd:   row.recurring_end ?? null,
    recurringId:    row.recurring_id ?? null,
    recurringStart: row.recurring_start ?? null,
    status:         row.status ?? "confirmed",
    createdBy:      row.created_by ?? 0,
    createdAt:      row.created_at ?? new Date().toISOString(),
  };
}

function expenseToDb(exp: Omit<Expense, "id" | "createdAt">, familyId: string) {
  return {
    family_id:       familyId,
    label:           exp.label,
    amount:          exp.amount,
    paid_by:         exp.paidBy,
    split_pct:       exp.split ?? 50,
    category:        exp.category,
    date:            exp.date || null,
    note:            exp.note || "",
    attachments:     exp.attachments || [],
    recurring:       exp.recurring ?? false,
    recurring_freq:  exp.recurringFreq || null,
    recurring_end:   exp.recurringEnd || null,
    recurring_id:    exp.recurringId ? String(exp.recurringId) : null,
    recurring_start: exp.recurringStart || null,
    status:          exp.status,
    created_by:      exp.createdBy ?? 0,
  };
}
```

Replace with:

```ts
export function dbToExpense(row: Record<string, any>): Expense {
  return {
    id:             row.id,
    label:          row.label ?? "",
    amount:         Number(row.amount ?? 0),
    paidBy:         row.paid_by ?? 0,
    paidByUserId:   row.paid_by_user_id ?? null,
    paidByName:     row.paid_by_name ?? null,
    split:          row.split_pct ?? 50,
    category:       row.category ?? "",
    date:           row.date ?? null,
    note:           row.note ?? "",
    attachments:    row.attachments ?? [],
    recurring:      row.recurring ?? false,
    recurringFreq:  row.recurring_freq ?? null,
    recurringEnd:   row.recurring_end ?? null,
    recurringId:    row.recurring_id ?? null,
    recurringStart: row.recurring_start ?? null,
    status:         row.status ?? "confirmed",
    createdBy:      row.created_by ?? 0,
    createdByUserId: row.created_by_user_id ?? null,
    createdByName:   row.created_by_name ?? null,
    createdAt:      row.created_at ?? new Date().toISOString(),
  };
}

function expenseToDb(exp: Omit<Expense, "id" | "createdAt">, familyId: string) {
  return {
    family_id:       familyId,
    label:           exp.label,
    amount:          exp.amount,
    paid_by:         exp.paidBy,
    paid_by_user_id: exp.paidByUserId ?? null,
    paid_by_name:    exp.paidByName ?? null,
    split_pct:       exp.split ?? 50,
    category:        exp.category,
    date:            exp.date || null,
    note:            exp.note || "",
    attachments:     exp.attachments || [],
    recurring:       exp.recurring ?? false,
    recurring_freq:  exp.recurringFreq || null,
    recurring_end:   exp.recurringEnd || null,
    recurring_id:    exp.recurringId ? String(exp.recurringId) : null,
    recurring_start: exp.recurringStart || null,
    status:          exp.status,
    created_by:      exp.createdBy ?? 0,
    created_by_user_id: exp.createdByUserId ?? null,
    created_by_name:    exp.createdByName ?? null,
  };
}
```

- [ ] **Step 4: Update `dbToReimbursement` and `reimbursementToDb`**

Find:

```ts
export function dbToReimbursement(row: Record<string, any>): Reimbursement {
  return {
    id:        row.id,
    from:      row.from_parent ?? 0,
    to:        row.to_parent ?? 0,
    amount:    Number(row.amount ?? 0),
    date:      row.date ?? null,
    note:      row.note ?? "",
    status:    row.status ?? "pending",
    createdAt: row.created_at ?? new Date().toISOString(),
  };
}

function reimbursementToDb(reim: Omit<Reimbursement, "id" | "createdAt">, familyId: string) {
  return {
    family_id:    familyId,
    from_parent:  reim.from,
    to_parent:    reim.to,
    amount:       reim.amount,
    date:         reim.date || null,
    note:         reim.note || "",
    status:       reim.status,
  };
}
```

Replace with:

```ts
export function dbToReimbursement(row: Record<string, any>): Reimbursement {
  return {
    id:          row.id,
    from:        row.from_parent ?? 0,
    fromUserId:  row.from_user_id ?? null,
    fromName:    row.from_name ?? null,
    to:          row.to_parent ?? 0,
    toUserId:    row.to_user_id ?? null,
    toName:      row.to_name ?? null,
    amount:      Number(row.amount ?? 0),
    date:        row.date ?? null,
    note:        row.note ?? "",
    status:      row.status ?? "pending",
    createdAt:   row.created_at ?? new Date().toISOString(),
  };
}

function reimbursementToDb(reim: Omit<Reimbursement, "id" | "createdAt">, familyId: string) {
  return {
    family_id:     familyId,
    from_parent:   reim.from,
    from_user_id:  reim.fromUserId ?? null,
    from_name:     reim.fromName ?? null,
    to_parent:     reim.to,
    to_user_id:    reim.toUserId ?? null,
    to_name:       reim.toName ?? null,
    amount:        reim.amount,
    date:          reim.date || null,
    note:          reim.note || "",
    status:        reim.status,
  };
}
```

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: succeeds. Note: `src/App.jsx` is a `.jsx` file, so Vite's build does not type-check its object literals against these interfaces — nothing will fail loudly here if a creation call site doesn't supply the new fields yet. That's expected at this point in the plan (Task 6 adds them); the interfaces are still worth keeping non-optional as documentation of what *should* always be set going forward.

- [ ] **Step 6: Commit**

```bash
git add src/services/supabase/expenseService.ts
git commit -m "Add identity fields to Expense/Reimbursement types and DB mappers"
```

---

### Task 5: Expose `removedUserIds` via `useApp()` context

**Files:**
- Modify: `src/App.jsx:3954` (the `ctxValue` object)

**Interfaces:**
- Consumes: `familySync.removedUserIds` (Task 3).
- Produces: `useApp().removedUserIds` — usable by any component, matching how `useApp().familySync` is already exposed.

- [ ] **Step 1: Add it to `ctxValue`**

Find (around line 3954):

```js
    familySync,
    uidToLocal,
    localToUid,
    emailToUid,
```

Replace with:

```js
    familySync,
    removedUserIds: familySync.removedUserIds,
    uidToLocal,
    localToUid,
    emailToUid,
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/App.jsx
git commit -m "Expose removedUserIds via useApp() context"
```

---

### Task 6: Populate identity fields at creation time

**Files:**
- Modify: `src/App.jsx` — function `add()` (expense create/update, ~line 11119-11182) and `addReim()` (~line 11254-11274).

**Interfaces:**
- Consumes: `Expense`/`Reimbursement` types from Task 4 (`createdByUserId`, `createdByName`, `paidByUserId`, `paidByName`, `fromUserId`, `fromName`, `toUserId`, `toName`).
- Produces: every newly created expense/reimbursement row has these fields set (or `null` if the relevant `cfg.parents[idx]` has no `userId` yet — accepted edge case per the spec).

- [ ] **Step 1: Add a small resolver at the top of `add()`**

Find the start of `add()` (line 11119):

```js
  async function add(){
    if(!form.label){setFormErr(t.expErrDesc||"⚠️ La description est obligatoire.");return;}
```

Replace with (adds `payload`'s identity fields right where `payload` itself is built, a few lines down — this step only adds the resolver function used by the next step):

```js
  // Résout l'identité réelle (user_id + nom au moment des faits) pour un index
  // de position donné — utilisé pour figer l'attribution à la création (voir
  // docs/superpowers/specs/2026-07-06-expense-identity-attribution-design.md).
  // Ni user_id ni name ne sont relus plus tard : ils ne bougent plus jamais.
  function resolveActorIdentity(parentIdx){
    const p = cfg.parents[parentIdx];
    return { userId: p?.userId || null, name: p?.name || null };
  }

  async function add(){
    if(!form.label){setFormErr(t.expErrDesc||"⚠️ La description est obligatoire.");return;}
```

- [ ] **Step 2: Set the fields on `payload`**

Find (line 11133):

```js
    const payload={...form,label:cleanLabel,amount:amt,split:form.split??50,attachments:form.attachments||[]};
```

Replace with:

```js
    const creatorIdentity = { userId: user?.id || null, name: user?.name || null };
    const payerIdentity = resolveActorIdentity(form.paidBy);
    const payload={...form,label:cleanLabel,amount:amt,split:form.split??50,attachments:form.attachments||[],
      createdByUserId: creatorIdentity.userId, createdByName: creatorIdentity.name,
      paidByUserId: payerIdentity.userId, paidByName: payerIdentity.name};
```

- [ ] **Step 3: Verify `createdBy: user?.parentIdx??0` sites still work unchanged**

No code change needed here — `payload` already spreads into every `{...payload, ..., createdBy:user?.parentIdx??0}` call at lines 11142, 11147, 11152, 11159, 11166, so `createdByUserId`/`createdByName`/`paidByUserId`/`paidByName` ride along automatically since they're now part of `payload`. Confirm by reading those 5 call sites again after Step 2 — each must still read `{...payload, ...}` (they do; this step is a verification read, not an edit).

- [ ] **Step 4: Set the fields for reimbursements**

Find `addReim()` (line 11254-11274):

```js
  async function addReim(){
    if(!reimForm.amount||isNaN(parseFloat(reimForm.amount))||parseFloat(reimForm.amount)<=0){
      setReimErr(t.expErrReimAmount||"⚠️ Montant invalide.");return;
    }
    if(reimForm.from===reimForm.to){setReimErr(t.expErrReimSame||"⚠️ Les deux parents doivent être différents.");return;}
    setReimErr("");
    const fromName=cfg.parents[reimForm.from]?.name||`P${reimForm.from+1}`;
    const toName=cfg.parents[reimForm.to]?.name||`P${reimForm.to+1}`;
    if(editReimId){
      await expMethods.updateReimbursement(editReimId,{...reimForm,amount:parseFloat(reimForm.amount),status:"pending"});
      addHist(t.expReimTitle||"Remboursement",`Modifié · ${fromName} → ${toName} · ${reimForm.amount}${currency}`,"exp");
      pushNotif(`✏️ Remboursement de ${fromName} modifié (${reimForm.amount}${currency}) — revalidation requise`,"exp");
      setEditReimId(null);
    } else {
      await expMethods.addReimbursement({...reimForm,amount:parseFloat(reimForm.amount),status:"pending"});
      addHist(t.expReimTitle||"Remboursement",`${fromName} → ${toName} · ${reimForm.amount}${currency}`,"exp");
      pushNotif(`💸 ${fromName} ${t.expReimAdded||"a remboursé"} ${toName} (${reimForm.amount}${currency})`,"exp");
    }
    setShowReim(false);
    setReimForm(emptyReim);
  }
```

Replace with:

```js
  async function addReim(){
    if(!reimForm.amount||isNaN(parseFloat(reimForm.amount))||parseFloat(reimForm.amount)<=0){
      setReimErr(t.expErrReimAmount||"⚠️ Montant invalide.");return;
    }
    if(reimForm.from===reimForm.to){setReimErr(t.expErrReimSame||"⚠️ Les deux parents doivent être différents.");return;}
    setReimErr("");
    const fromName=cfg.parents[reimForm.from]?.name||`P${reimForm.from+1}`;
    const toName=cfg.parents[reimForm.to]?.name||`P${reimForm.to+1}`;
    const fromIdentity = resolveActorIdentity(reimForm.from);
    const toIdentity = resolveActorIdentity(reimForm.to);
    const reimPayload = {...reimForm, amount:parseFloat(reimForm.amount), status:"pending",
      fromUserId: fromIdentity.userId, fromName: fromIdentity.name,
      toUserId: toIdentity.userId, toName: toIdentity.name};
    if(editReimId){
      await expMethods.updateReimbursement(editReimId, reimPayload);
      addHist(t.expReimTitle||"Remboursement",`Modifié · ${fromName} → ${toName} · ${reimForm.amount}${currency}`,"exp");
      pushNotif(`✏️ Remboursement de ${fromName} modifié (${reimForm.amount}${currency}) — revalidation requise`,"exp");
      setEditReimId(null);
    } else {
      await expMethods.addReimbursement(reimPayload);
      addHist(t.expReimTitle||"Remboursement",`${fromName} → ${toName} · ${reimForm.amount}${currency}`,"exp");
      pushNotif(`💸 ${fromName} ${t.expReimAdded||"a remboursé"} ${toName} (${reimForm.amount}${currency})`,"exp");
    }
    setShowReim(false);
    setReimForm(emptyReim);
  }
```

Note: `resolveActorIdentity` is defined once, above `add()` (Step 1), and is in scope for `addReim()` too since both are in the same component function.

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Manual check**

Run `npm run dev`, log in as a test family, add a new expense. Open the Supabase SQL Editor and run:

```sql
select label, created_by, created_by_user_id, created_by_name, paid_by, paid_by_user_id, paid_by_name
from expenses order by created_at desc limit 1;
```

Expected: `created_by_user_id`/`created_by_name` match the logged-in user's real id/name; `paid_by_user_id`/`paid_by_name` match whichever parent was selected as payer. Repeat for a reimbursement against the `reimbursements` table.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Populate expense/reimbursement identity fields at creation"
```

---

### Task 7: Display sites — expenses (popup, detail modal, list row, PDF export)

**Files:**
- Modify: `src/App.jsx:4052,4062` (pending-expense popup)
- Modify: `src/App.jsx:11353` (PDF attachments section)
- Modify: `src/App.jsx:11364-11365` (PDF export table rows)
- Modify: `src/App.jsx:11619-11620,11646,11659-11662,11684-11687` (expense detail modal)
- Modify: `src/App.jsx:12241,12276` (expense list row)

**Interfaces:**
- Consumes: `formatActorName` (Task 2), `Expense.createdByName`/`createdByUserId`/`paidByName`/`paidByUserId` (Task 4), `removedUserIds` via `useApp()` (Task 5).

- [ ] **Step 1: Pending-expense popup**

This popup (line 4050-4062) is rendered directly inside the root `App()` function — the same function that calls `const familySync = useFamilySync(cfg, setCfg);` at line 2690 and later builds `ctxValue` (line 3931) from it. It does **not** call `useApp()` (it *is* the provider) — so reference `familySync.removedUserIds` directly here, not a bare `removedUserIds`.

Find (line 4050-4062):

```js
      {pendingExpPopup && (()=>{
        const e=pendingExpPopup;
        const creatorP=cfg.parents[e.createdBy];
        const dateStr=(e.date||"").split("-").reverse().join("/");
        const doConfirmE=()=>{ dbConfirmExp(e.id); setPendingExpPopup(null); };
        const doRejectE=()=>{ dbRejectExp(e.id); setPendingExpPopup(null); };
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
            <div style={{background:C.card,borderRadius:22,padding:"28px 24px",maxWidth:340,width:"100%",border:`1.5px solid ${C.yel}`,boxShadow:"0 16px 48px rgba(0,0,0,.28)",animation:"popIn .35s cubic-bezier(.34,1.56,.64,1)"}}>
              <div style={{fontSize:40,textAlign:"center",marginBottom:10}}>💰</div>
              <div style={{fontSize:16,fontWeight:800,marginBottom:6,textAlign:"center",color:C.txt}}>{t.expPendingPopupTitle||"Dépense à confirmer"}</div>
              <div style={{fontSize:13,color:C.mut,marginBottom:20,textAlign:"center",lineHeight:1.6}}>
                <strong style={{color:creatorP?.color||C.blu}}>{creatorP?.name||`Parent ${(e.createdBy||0)+1}`}</strong>{" "}
```

Replace with (only the `creatorP?.name` display line changes; everything else identical):

```js
      {pendingExpPopup && (()=>{
        const e=pendingExpPopup;
        const creatorP=cfg.parents[e.createdBy];
        const creatorLabel=formatActorName(e.createdByName||creatorP?.name||`Parent ${(e.createdBy||0)+1}`, e.createdByUserId, familySync.removedUserIds);
        const dateStr=(e.date||"").split("-").reverse().join("/");
        const doConfirmE=()=>{ dbConfirmExp(e.id); setPendingExpPopup(null); };
        const doRejectE=()=>{ dbRejectExp(e.id); setPendingExpPopup(null); };
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
            <div style={{background:C.card,borderRadius:22,padding:"28px 24px",maxWidth:340,width:"100%",border:`1.5px solid ${C.yel}`,boxShadow:"0 16px 48px rgba(0,0,0,.28)",animation:"popIn .35s cubic-bezier(.34,1.56,.64,1)"}}>
              <div style={{fontSize:40,textAlign:"center",marginBottom:10}}>💰</div>
              <div style={{fontSize:16,fontWeight:800,marginBottom:6,textAlign:"center",color:C.txt}}>{t.expPendingPopupTitle||"Dépense à confirmer"}</div>
              <div style={{fontSize:13,color:C.mut,marginBottom:20,textAlign:"center",lineHeight:1.6}}>
                <strong style={{color:creatorP?.color||C.blu}}>{creatorLabel}</strong>{" "}
```

- [ ] **Step 2: PDF export — attachments section**

Find (line 11353):

```js
          const pName=cfg.parents[e.paidBy]?.name||`Parent ${e.paidBy+1}`;
```

Replace with:

```js
          const pName=formatActorName(e.paidByName||cfg.parents[e.paidBy]?.name||`Parent ${e.paidBy+1}`, e.paidByUserId, removedUserIds);
```

- [ ] **Step 3: PDF export — table rows**

Find (line 11364-11365):

```js
        const pName=cfg.parents[e.paidBy]?.name||`Parent ${e.paidBy+1}`;
        const creatorName=e.createdBy!==undefined?(cfg.parents[e.createdBy]?.name||`Parent ${e.createdBy+1}`):pName;
```

Replace with:

```js
        const pName=formatActorName(e.paidByName||cfg.parents[e.paidBy]?.name||`Parent ${e.paidBy+1}`, e.paidByUserId, removedUserIds);
        const creatorName=e.createdBy!==undefined?formatActorName(e.createdByName||cfg.parents[e.createdBy]?.name||`Parent ${e.createdBy+1}`, e.createdByUserId, removedUserIds):pName;
```

- [ ] **Step 4: Detail modal — payer label**

Find (line 11619-11620):

```js
        const payer=cfg.parents[e.paidBy];
        const creator=cfg.parents[e.createdBy];
```

Replace with:

```js
        const payer=cfg.parents[e.paidBy];
        const payerLabel=formatActorName(e.paidByName||payer?.name||`P${e.paidBy+1}`, e.paidByUserId, removedUserIds);
        const creator=cfg.parents[e.createdBy];
        const creatorLabel=formatActorName(e.createdByName||creator?.name||`P${(e.createdBy||0)+1}`, e.createdByUserId, removedUserIds);
```

Find (line 11646):

```js
                  <div style={{fontSize:12,color:C.mut,marginTop:2}}>{t.expPaidBy||"Payé par"} <strong style={{color:payer?.color||C.grn}}>{payer?.name||`P${e.paidBy+1}`}</strong></div>
```

Replace with:

```js
                  <div style={{fontSize:12,color:C.mut,marginTop:2}}>{t.expPaidBy||"Payé par"} <strong style={{color:payer?.color||C.grn}}>{payerLabel}</strong></div>
```

Find (line 11684-11687):

```js
                {creator&&(
                  <div style={{background:C.sur,borderRadius:10,padding:"10px 12px",gridColumn:"1/-1"}}>
                    <div style={{fontSize:10,color:C.mut,fontWeight:700,marginBottom:2}}>AJOUTÉ PAR</div>
                    <div style={{fontSize:13,fontWeight:700,color:creator.color||C.txt}}>{creator.name}</div>
                  </div>
                )}
```

Replace with:

```js
                {(creator||e.createdByName)&&(
                  <div style={{background:C.sur,borderRadius:10,padding:"10px 12px",gridColumn:"1/-1"}}>
                    <div style={{fontSize:10,color:C.mut,fontWeight:700,marginBottom:2}}>AJOUTÉ PAR</div>
                    <div style={{fontSize:13,fontWeight:700,color:creator?.color||C.txt}}>{creatorLabel}</div>
                  </div>
                )}
```

(The `(creator||e.createdByName)` guard keeps showing this block for a departed creator whose old slot was later blanked/reused — previously `creator&&` alone would hide it once `cfg.parents[e.createdBy]` no longer resolves to anyone recognizable; with the snapshot name we can still show it.)

Note: the "Part de chaque parent" loop at lines 11654-11666 (`cfg.parents.map((p,i)=> ... p.name ...)`) is intentionally **left unchanged** — it shows the current 2 co-parents' split percentages, a position-based concept per the spec, not an identity one.

- [ ] **Step 5: List row — payer + pending-confirmation banner**

Find (line 12241):

```js
                      <span style={{color:cfg.parents[e.paidBy]?.color}}>{cfg.parents[e.paidBy]?.name||`P${e.paidBy+1}`}</span>
```

Replace with:

```js
                      <span style={{color:cfg.parents[e.paidBy]?.color}}>{formatActorName(e.paidByName||cfg.parents[e.paidBy]?.name||`P${e.paidBy+1}`, e.paidByUserId, removedUserIds)}</span>
```

Find (line 12276):

```js
                      <strong style={{color:cfg.parents[e.createdBy]?.color||C.blu}}>{cfg.parents[e.createdBy]?.name||`P${(e.createdBy||0)+1}`}</strong>{" "}
```

Replace with:

```js
                      <strong style={{color:cfg.parents[e.createdBy]?.color||C.blu}}>{formatActorName(e.createdByName||cfg.parents[e.createdBy]?.name||`P${(e.createdBy||0)+1}`, e.createdByUserId, removedUserIds)}</strong>{" "}
```

- [ ] **Step 6: Import `formatActorName` and add `removedUserIds` to `ExpTab`'s context destructuring**

At the top of `src/App.jsx`, find:

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx } from './utils/core.js';
```

Replace with:

```js
import { insertValidatedParent, reconcileOwnParentSlot, isRgpdConsentValid, makeRgpdConsentRecord, RGPD_STORAGE_KEY, isParentEmailLocked, markDepartedParents, effectiveCreatorIdx, formatActorName } from './utils/core.js';
```

Steps 2-5 above are all inside `function ExpTab()` (starts at line 10852), which calls `useApp()` at line 10853:

```js
  const {C,t,cfg,setCfg,addHist,pushNotif,user,prem,perms,onUpgrade,isAdm,setActivity,sub,simDate,setExpSubmittedPopup,addRefAction,currency="€",expenses:ctxExpenses,reimbursements:ctxReimbursements,expMethods,history:ctxHistory,familySync} = useApp();
```

Replace with:

```js
  const {C,t,cfg,setCfg,addHist,pushNotif,user,prem,perms,onUpgrade,isAdm,setActivity,sub,simDate,setExpSubmittedPopup,addRefAction,currency="€",expenses:ctxExpenses,reimbursements:ctxReimbursements,expMethods,history:ctxHistory,familySync,removedUserIds} = useApp();
```

(Step 1, the pending-expense popup, is in the root `App()` function, not `ExpTab` — it already uses `familySync.removedUserIds` directly, see Step 1 above; it needs no context destructuring change.)

- [ ] **Step 7: Verify the build**

Run: `npm run build`
Expected: succeeds, no "removedUserIds is not defined" errors.

- [ ] **Step 8: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 63`, `pass 63`, `fail 0` (unchanged from Task 2 — this task doesn't touch `core.js`).

- [ ] **Step 9: Manual check**

`npm run dev`. In a test family with one departed parent (reuse the Pere1/Mere1 test accounts if still around, or create a fresh departure scenario): add a new expense as the remaining parent, confirm/view it — the "Ajouté par" field and the list row should show your name normally (not departed). Then, for the departed parent's *pre-existing* expenses from before this change (if any test data has them), confirm the display still falls back gracefully to the position-index name (no crash, no blank).

- [ ] **Step 10: Commit**

```bash
git add src/App.jsx src/utils/core.js
git commit -m "Show legally-attributed name (with departed marker) on expense displays"
```

---

### Task 8: Display sites — reimbursements (popup, list row, PDF export)

**Files:**
- Modify: `src/App.jsx:4023,4033` (pending-reimbursement popup)
- Modify: `src/App.jsx:11279,11284` (confirm/reject notifications + history)
- Modify: `src/App.jsx:11374-11375` (PDF export table rows)
- Modify: `src/App.jsx:12161,12178-12180,12202` (reimbursement list row)

**Interfaces:**
- Consumes: same as Task 7 (`formatActorName`, `removedUserIds`, plus `Reimbursement.fromName`/`fromUserId`/`toName`/`toUserId` from Task 4).

- [ ] **Step 1: Pending-reimbursement popup**

Like the pending-expense popup (Task 7 Step 1), this is rendered directly inside the root `App()` function, not inside `ExpTab` — use `familySync.removedUserIds` directly, not a bare `removedUserIds`.

Find (line 4020-4033 — read a few lines above 4023 first to get the exact opening of this block, then apply):

```js
        const fromP=cfg.parents[r.from];
```

Replace with:

```js
        const fromP=cfg.parents[r.from];
        const fromLabel=formatActorName(r.fromName||fromP?.name||`Parent ${r.from+1}`, r.fromUserId, familySync.removedUserIds);
```

Find (line 4033):

```js
                <strong style={{color:fromP?.color||C.grn}}>{fromP?.name||`Parent ${r.from+1}`}</strong> vous a envoyé un remboursement de{" "}
```

Replace with:

```js
                <strong style={{color:fromP?.color||C.grn}}>{fromLabel}</strong> vous a envoyé un remboursement de{" "}
```

- [ ] **Step 2: Confirm/reject notification text**

Find (line 11279):

```js
    if(r){ const fromName=cfg.parents[r.from]?.name||`P${r.from+1}`; pushNotif(`✅ Remboursement de ${fromName} (${r.amount}${currency}) confirmé`,"exp"); addHist("Remboursement confirmé",`${fromName} → ${r.amount}${currency}`,"exp"); }
```

Replace with:

```js
    if(r){ const fromName=formatActorName(r.fromName||cfg.parents[r.from]?.name||`P${r.from+1}`, r.fromUserId, removedUserIds); pushNotif(`✅ Remboursement de ${fromName} (${r.amount}${currency}) confirmé`,"exp"); addHist("Remboursement confirmé",`${fromName} → ${r.amount}${currency}`,"exp"); }
```

Find (line 11284):

```js
    if(r){ const fromName=cfg.parents[r.from]?.name||`P${r.from+1}`; pushNotif(`❌ Remboursement de ${fromName} (${r.amount}${currency}) refusé`,"exp"); addHist("Remboursement refusé",`${fromName} → ${r.amount} ${currency}`,"exp"); }
```

Replace with:

```js
    if(r){ const fromName=formatActorName(r.fromName||cfg.parents[r.from]?.name||`P${r.from+1}`, r.fromUserId, removedUserIds); pushNotif(`❌ Remboursement de ${fromName} (${r.amount}${currency}) refusé`,"exp"); addHist("Remboursement refusé",`${fromName} → ${r.amount} ${currency}`,"exp"); }
```

- [ ] **Step 3: PDF export table rows**

Find (line 11374-11375):

```js
        const fromName=cfg.parents[r.from]?.name||`Parent ${r.from+1}`;
        const toName=cfg.parents[r.to]?.name||`Parent ${r.to+1}`;
```

Replace with:

```js
        const fromName=formatActorName(r.fromName||cfg.parents[r.from]?.name||`Parent ${r.from+1}`, r.fromUserId, removedUserIds);
        const toName=formatActorName(r.toName||cfg.parents[r.to]?.name||`Parent ${r.to+1}`, r.toUserId, removedUserIds);
```

- [ ] **Step 4: List row**

Find (line 12160-12180):

```js
              const fromP=cfg.parents[item.from]; const toP=cfg.parents[item.to];
```

Replace with:

```js
              const fromP=cfg.parents[item.from]; const toP=cfg.parents[item.to];
              const fromLabel=formatActorName(item.fromName||fromP?.name||`P${item.from+1}`, item.fromUserId, removedUserIds);
              const toLabel=formatActorName(item.toName||toP?.name||`P${item.to+1}`, item.toUserId, removedUserIds);
```

Find (line 12176-12180):

```js
                        <span style={{fontSize:16}}>💸</span>
                        <span style={{color:fromP?.color||C.grn}}>{fromP?.name||`P${item.from+1}`}</span>
                        <span style={{color:C.mut,fontWeight:400}}>→</span>
                        <span style={{color:toP?.color||C.txt}}>{toP?.name||`P${item.to+1}`}</span>
```

Replace with:

```js
                        <span style={{fontSize:16}}>💸</span>
                        <span style={{color:fromP?.color||C.grn}}>{fromLabel}</span>
                        <span style={{color:C.mut,fontWeight:400}}>→</span>
                        <span style={{color:toP?.color||C.txt}}>{toLabel}</span>
```

Find (line 12202):

```js
                        <strong style={{color:fromP?.color||C.grn}}>{fromP?.name||`P${item.from+1}`}</strong> vous a envoyé un remboursement de <strong>{item.amount.toFixed(2)} {currency}</strong> le {(item.date||"").split("-").reverse().join("/")}.<br/>
```

Replace with:

```js
                        <strong style={{color:fromP?.color||C.grn}}>{fromLabel}</strong> vous a envoyé un remboursement de <strong>{item.amount.toFixed(2)} {currency}</strong> le {(item.date||"").split("-").reverse().join("/")}.<br/>
```

- [ ] **Step 5: Confirm `removedUserIds` scope**

Steps 2-4 above are inside `ExpTab`, which already destructures `removedUserIds` from `useApp()` as of Task 7 Step 6. No further change needed here — this step is just a read-through check that Task 7 Step 6 was completed before starting this task.

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 7: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 63`, `pass 63`, `fail 0`.

- [ ] **Step 8: Manual check**

`npm run dev`. Create a reimbursement between the two current parents, confirm the names display normally. This completes the feature — the end-to-end check is: create an expense/reimbursement now, have that parent leave the family, dismiss their departed-card (once the separate "×" re-indexing fix — discussed earlier in this project, not part of this plan — is in place), invite a third person into the freed slot, and confirm the original expense/reimbursement still shows the original creator's name with "(parti)".

- [ ] **Step 9: Commit**

```bash
git add src/App.jsx
git commit -m "Show legally-attributed name (with departed marker) on reimbursement displays"
```

---

## Out of scope (tracked separately, not part of this plan)

- The "×" dismiss-button re-indexing bug (`cfg.parents.filter(...)` instead of resetting in place) and the matching `confirmInvite` blank-slot-reuse fix — a real, independent bug discussed in this project's conversation history, needed regardless of this identity work (the position columns stay load-bearing for balance math). Fix it as its own small change, not bundled here.
- Legal attribution for garde/planning, dates spéciales, and family config (photo/tel/rôle/couleur) — these have no attribution tracking at all today (still in the `families.data` JSONB blob, never extracted to a dedicated table). That's a separate, larger design (schema extraction + audit trail), scoped out during brainstorming.
- Recovering the already-corrupted Toti/Sissi family's historical attribution — the original mapping is unrecoverable from `expenses`/`reimbursements` alone; a manual cross-reference against that family's `history` table (which already stores real `user_id`) is a possible one-off investigation, not part of this plan.
