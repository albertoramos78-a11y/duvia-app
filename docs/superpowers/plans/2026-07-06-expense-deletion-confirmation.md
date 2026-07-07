# Expense/Reimbursement Deletion Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the creator tries to delete an already-**confirmed** expense or reimbursement, require the other parent to confirm the deletion instead of deleting immediately; the creator can also cancel their own pending request.

**Architecture:** Add a `pending_delete` boolean column to `expenses` and `reimbursements` (independent of the existing `status` column, so totals/balance math is unaffected while a deletion is pending). Reuse the existing confirm/reject UI pattern already used for newly-created items (inline banner in the list, plus the equivalent block in the expense detail modal) — no new modal popup.

**Tech Stack:** React + Vite, Supabase (Postgres + RLS), TypeScript service layer (`src/services/supabase/expenseService.ts`), `src/App.jsx` (`ExpTab` component).

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-07-06-expense-deletion-confirmation-design.md`.
- Only applies when the item's `status==="confirmed"` at the moment delete is clicked. An item still `"pending"` or `"rejected"` deletes immediately, unchanged from today.
- **Recurring expense series are out of scope for this feature.** `del(id)` already branches to `setRecurringDelModal(e)` when `e.recurringId` is set, opening a scope-choice modal (single occurrence vs. whole series) before calling `doDelete`. That existing branch is untouched — series deletion keeps today's immediate-delete behavior regardless of status. The new confirmation only applies to non-recurring expenses and to reimbursements (which have no series concept).
- Do not touch `totals`/`owed`/`balance`/PDF-export calculations — they already filter on `status`, which this feature never modifies.
- Tests: `TZ=Europe/Paris npm test` must stay at 100% pass (63/63 as of the last commit on `main`).
- Every task ends with `npm run build` passing. This project has no automated UI/component test harness — verify UI changes with a manual browser check as described in each task, not an invented test framework.
- `node_modules` isn't committed in this environment; run `npm install` once per fresh worktree if `npm run build`/`npm test` fail with a "command not found" error.
- The SQL migration is run by the user in the Supabase SQL Editor (no DB credentials available in this environment) — the task that adds it ends with "hand the SQL to the user to run," not with running it yourself.

---

### Task 1: Migration — `pending_delete` column

**Files:**
- Create: `supabase/migrations/0022_expense_deletion_confirmation.sql`

**Interfaces:**
- Produces: `expenses.pending_delete BOOLEAN NOT NULL DEFAULT false`, `reimbursements.pending_delete BOOLEAN NOT NULL DEFAULT false`.

- [ ] **Step 1: Write the migration file**

```sql
-- 0022_expense_deletion_confirmation.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Confirmation de suppression pour les dépenses/remboursements déjà validés.
--
-- Problème corrigé : le créateur pouvait supprimer unilatéralement une
-- dépense ou un remboursement déjà accepté par l'autre parent, sans aucune
-- validation — pas acceptable pour un outil qui sert de preuve en cas de
-- litige de garde partagée.
--
-- Solution : un simple drapeau, indépendant de la colonne `status` existante
-- (qui reste "confirmed" pendant toute la durée de la demande — l'élément
-- continue donc de compter normalement dans les totaux). Quand le créateur
-- demande la suppression d'un élément déjà `status='confirmed'`, on pose
-- `pending_delete=true` au lieu de supprimer ; l'autre parent confirme
-- (suppression réelle) ou refuse (`pending_delete` repasse à false). Le
-- créateur peut aussi annuler sa propre demande de la même façon.
--
-- Voir docs/superpowers/specs/2026-07-06-expense-deletion-confirmation-design.md
--
-- À exécuter APRÈS 0021. Idempotent (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.reimbursements
  ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 2: Introspection query for the user to confirm no pre-existing conflicting column**

Hand this to the user to run in the Supabase SQL Editor first:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('expenses', 'reimbursements')
  and column_name = 'pending_delete';
```

Expected: 0 rows. If any row comes back, stop and re-check before proceeding.

- [ ] **Step 3: Hand the migration SQL to the user to run in the Supabase SQL Editor**

Wait for confirmation ("Success. No rows returned" or similar) before starting Task 2.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0022_expense_deletion_confirmation.sql
git commit -m "Add pending_delete column for expense/reimbursement deletion confirmation"
```

---

### Task 2: `expenseService.ts` — types and DB mappers

**Files:**
- Modify: `src/services/supabase/expenseService.ts`

**Interfaces:**
- Produces: `Expense.pendingDelete: boolean`, `Reimbursement.pendingDelete: boolean`, read/written from/to `pending_delete` in `dbToExpense`/`expenseToDb`/`dbToReimbursement`/`reimbursementToDb`.
- Consumed by: Task 3 (`App.jsx` action functions and UI).

- [ ] **Step 1: Extend the `Expense` interface**

Find:

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
  pendingDelete: boolean;
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
  pendingDelete: boolean;
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
    pendingDelete:  row.pending_delete ?? false,
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
    pending_delete:  exp.pendingDelete ?? false,
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
    pendingDelete: row.pending_delete ?? false,
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
    pending_delete: reim.pendingDelete ?? false,
  };
}
```

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: succeeds (as with the identity-attribution work, `App.jsx` is `.jsx` so nothing type-checks against these interfaces yet — that's expected until Task 3).

- [ ] **Step 6: Commit**

```bash
git add src/services/supabase/expenseService.ts
git commit -m "Add pendingDelete field to Expense/Reimbursement types and DB mappers"
```

---

### Task 3: Action functions — request/cancel/confirm/reject deletion

**Files:**
- Modify: `src/App.jsx` (`ExpTab` component) — `del()` (currently ~line 11228), `delReim()` (currently ~line 11302).

**Interfaces:**
- Consumes: `expMethods.updateExpense(id, patch)`, `expMethods.updateReimbursement(id, patch)` (already exist, from `useExpenses.ts`), `Expense.pendingDelete`/`Reimbursement.pendingDelete` (Task 2).
- Produces: `requestDeleteExp(id)`, `cancelDeleteExp(id)`, `confirmDeleteExp(id)`, `rejectDeleteExp(id)`, `requestDeleteReim(id)`, `cancelDeleteReim(id)`, `confirmDeleteReim(id)`, `rejectDeleteReim(id)` — all defined in `ExpTab`, consumed by Task 4 and Task 5's UI.

- [ ] **Step 1: Modify `del()` and add the expense deletion-request functions**

Find:

```js
  function del(id){
    const e=(ctxExpenses||[]).find(x=>x.id===id);
    if(e?.recurringId){ setRecurringDelModal(e); return; }
    doDelete(id,"single");
  }
```

Replace with:

```js
  function del(id){
    const e=(ctxExpenses||[]).find(x=>x.id===id);
    if(e?.recurringId){ setRecurringDelModal(e); return; }
    // 🔒 Une dépense déjà acceptée par l'autre parent ne peut plus être
    // supprimée unilatéralement : on demande confirmation au lieu de
    // supprimer directement. Une dépense encore "pending"/"rejected" garde
    // le comportement existant (suppression immédiate).
    if(e?.status==="confirmed"){ requestDeleteExp(id); return; }
    doDelete(id,"single");
  }

  function requestDeleteExp(id){
    const e=(ctxExpenses||[]).find(x=>x.id===id);
    expMethods.updateExpense(id,{pendingDelete:true});
    if(e){
      pushNotif(`🗑️ Suppression demandée : ${e.label}`,"exp");
      addHist("Suppression demandée",`${e.label} — ${Number(e.amount).toFixed(2)} ${currency}`,"exp");
    }
  }
  function cancelDeleteExp(id){
    expMethods.updateExpense(id,{pendingDelete:false});
  }
  function confirmDeleteExp(id){
    doDelete(id,"single");
  }
  function rejectDeleteExp(id){
    const e=(ctxExpenses||[]).find(x=>x.id===id);
    expMethods.updateExpense(id,{pendingDelete:false});
    if(e){
      pushNotif(`❌ Suppression refusée : ${e.label}`,"exp");
      addHist("Suppression refusée",`${e.label} — ${Number(e.amount).toFixed(2)} ${currency}`,"exp");
    }
  }
```

- [ ] **Step 2: Modify `delReim()` and add the reimbursement deletion-request functions**

Find:

```js
  function delReim(id){ expMethods.deleteReimbursement(id); }
```

Replace with:

```js
  function delReim(id){
    const r=reimbursements.find(x=>x.id===id);
    if(r?.status==="confirmed"){ requestDeleteReim(id); return; }
    expMethods.deleteReimbursement(id);
  }
  function requestDeleteReim(id){
    const r=reimbursements.find(x=>x.id===id);
    expMethods.updateReimbursement(id,{pendingDelete:true});
    if(r){
      const fromName=formatActorName(r.fromName||cfg.parents[r.from]?.name||`P${r.from+1}`, r.fromUserId, removedUserIds);
      pushNotif(`🗑️ Suppression demandée : remboursement de ${fromName}`,"exp");
      addHist("Suppression demandée",`Remboursement ${fromName} — ${r.amount}${currency}`,"exp");
    }
  }
  function cancelDeleteReim(id){
    expMethods.updateReimbursement(id,{pendingDelete:false});
  }
  function confirmDeleteReim(id){
    expMethods.deleteReimbursement(id);
  }
  function rejectDeleteReim(id){
    expMethods.updateReimbursement(id,{pendingDelete:false});
  }
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "Add deletion-confirmation action functions for expenses and reimbursements"
```

---

### Task 4: Reimbursement list row — banner and button swap

**Files:**
- Modify: `src/App.jsx` — reimbursement branch of the list `.map(item=>{...})` (currently lines ~12189-12248).

**Interfaces:**
- Consumes: `item.pendingDelete` (Task 2), `cancelDeleteReim`/`confirmDeleteReim`/`rejectDeleteReim` (Task 3).

- [ ] **Step 1: Swap the sender's delete button when a deletion is pending**

Find:

```js
                    {(iAmSender||isAdm) && st==="pending" && (
                      <div style={{display:"flex",gap:5,flexShrink:0}}>
                        <button onClick={()=>{setEditReimId(item.id);setReimForm({from:item.from,to:item.to,amount:String(item.amount),date:item.date,note:item.note||""});setShowReim(true);setTimeout(()=>reimFormRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),60);}} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                        <button onClick={()=>delReim(item.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                      </div>
                    )}
                    {(iAmSender||isAdm) && st!=="pending" && (
                      <button onClick={()=>delReim(item.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12,flexShrink:0}}>✕</button>
                    )}
```

Replace with:

```js
                    {(iAmSender||isAdm) && st==="pending" && (
                      <div style={{display:"flex",gap:5,flexShrink:0}}>
                        <button onClick={()=>{setEditReimId(item.id);setReimForm({from:item.from,to:item.to,amount:String(item.amount),date:item.date,note:item.note||""});setShowReim(true);setTimeout(()=>reimFormRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),60);}} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                        <button onClick={()=>delReim(item.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                      </div>
                    )}
                    {(iAmSender||isAdm) && st!=="pending" && !item.pendingDelete && (
                      <button onClick={()=>delReim(item.id)} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12,flexShrink:0}}>✕</button>
                    )}
                    {(iAmSender||isAdm) && st!=="pending" && item.pendingDelete && (
                      <button onClick={()=>cancelDeleteReim(item.id)} title="Annuler la demande de suppression" style={{padding:"5px 9px",background:"transparent",color:C.yel,border:`1px solid ${C.yel}`,borderRadius:8,fontSize:12,flexShrink:0}}>⏳</button>
                    )}
```

- [ ] **Step 2: Add the receiver's confirm/reject deletion banner**

Find:

```js
                  {/* Receiver action buttons */}
                  {iAmReceiver && st==="pending" && (
```

Replace with:

```js
                  {/* Receiver : confirmer/refuser une demande de suppression */}
                  {iAmReceiver && item.pendingDelete && (
                    <div style={{marginTop:12,padding:"12px 14px",background:`${C.red}0d`,border:`1px solid ${C.red}44`,borderRadius:10}}>
                      <div style={{fontSize:13,color:C.txt,marginBottom:10,lineHeight:1.5}}>
                        🗑️ <strong style={{color:fromP?.color||C.grn}}>{fromLabel}</strong> souhaite supprimer ce remboursement de <strong>{item.amount.toFixed(2)} {currency}</strong>.
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>confirmDeleteReim(item.id)}
                          style={{flex:1,padding:"10px",background:C.red,color:"#fff",borderRadius:10,fontWeight:800,fontSize:13}}>
                          🗑️ Confirmer la suppression
                        </button>
                        <button onClick={()=>rejectDeleteReim(item.id)}
                          style={{flex:1,padding:"10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontWeight:700,fontSize:13}}>
                          ❌ Refuser
                        </button>
                      </div>
                    </div>
                  )}
                  {/* Receiver action buttons */}
                  {iAmReceiver && st==="pending" && (
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual check**

`npm run dev` (needs a local `.env` with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` — see the earlier session's note on getting these from the Supabase dashboard if not already set up; alternatively skip this step and verify directly on `app.duvia.fr` after merging, matching how earlier fixes this session were verified). As the sender, create a reimbursement, confirm it from the receiver's side (so `status="confirmed"`), then click delete as the sender — expect the ✕ button to disappear and a `⏳` icon to appear instead of an immediate delete. As the receiver, confirm you see the "souhaite supprimer" banner with both buttons, and that clicking "Refuser" makes the `⏳` disappear and the normal ✕ reappear for the sender.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Add deletion-confirmation UI for reimbursements"
```

---

### Task 5: Expense list row — banner and button swap

**Files:**
- Modify: `src/App.jsx` — expense branch of the list `.map(item=>{...})` (currently lines ~12251-12323).

**Interfaces:**
- Consumes: `e.pendingDelete` (Task 2), `cancelDeleteExp`/`confirmDeleteExp`/`rejectDeleteExp` (Task 3).

- [ ] **Step 1: Swap the sender's delete button when a deletion is pending**

Find:

```js
                  {/* Boutons émetteur */}
                  {(iAmExpSender||isAdm) && expSt==="pending" && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={ev=>{ev.stopPropagation();startEdit(e);}} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                      <button onClick={ev=>{ev.stopPropagation();del(e.id);}} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                    </div>
                  )}
                  {(iAmExpSender||isAdm) && expSt!=="pending" && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={ev=>{ev.stopPropagation();startEdit(e);}} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                      <button onClick={ev=>{ev.stopPropagation();del(e.id);}} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                    </div>
                  )}
```

Replace with:

```js
                  {/* Boutons émetteur */}
                  {(iAmExpSender||isAdm) && expSt==="pending" && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={ev=>{ev.stopPropagation();startEdit(e);}} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                      <button onClick={ev=>{ev.stopPropagation();del(e.id);}} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                    </div>
                  )}
                  {(iAmExpSender||isAdm) && expSt!=="pending" && !e.pendingDelete && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={ev=>{ev.stopPropagation();startEdit(e);}} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                      <button onClick={ev=>{ev.stopPropagation();del(e.id);}} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,borderRadius:8,fontSize:12}}>✕</button>
                    </div>
                  )}
                  {(iAmExpSender||isAdm) && expSt!=="pending" && e.pendingDelete && (
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={ev=>{ev.stopPropagation();startEdit(e);}} style={{padding:"5px 9px",background:C.sur,color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12}}>✎</button>
                      <button onClick={ev=>{ev.stopPropagation();cancelDeleteExp(e.id);}} title="Annuler la demande de suppression" style={{padding:"5px 9px",background:"transparent",color:C.yel,border:`1px solid ${C.yel}`,borderRadius:8,fontSize:12}}>⏳</button>
                    </div>
                  )}
```

- [ ] **Step 2: Add the receiver's confirm/reject deletion banner**

Find:

```js
                {/* Zone validation receveur */}
                {iAmExpReceiver && expSt==="pending" && (
```

Replace with:

```js
                {/* Zone confirmation suppression (receveur) */}
                {iAmExpReceiver && e.pendingDelete && (
                  <div style={{marginTop:12,padding:"12px 14px",background:`${C.red}0d`,border:`1px solid ${C.red}44`,borderRadius:10}} onClick={ev=>ev.stopPropagation()}>
                    <div style={{fontSize:13,color:C.txt,marginBottom:10,lineHeight:1.5}}>
                      🗑️ <strong style={{color:cfg.parents[e.createdBy]?.color||C.blu}}>{formatActorName(e.createdByName||cfg.parents[e.createdBy]?.name||`P${(e.createdBy||0)+1}`, e.createdByUserId, removedUserIds)}</strong>{" "}
                      souhaite supprimer cette dépense ({e.label} — {e.amount.toFixed(2)} {currency}).
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>confirmDeleteExp(e.id)}
                        style={{flex:1,padding:"10px",background:C.red,color:"#fff",borderRadius:10,fontWeight:800,fontSize:13}}>
                        🗑️ Confirmer la suppression
                      </button>
                      <button onClick={()=>rejectDeleteExp(e.id)}
                        style={{flex:1,padding:"10px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontWeight:700,fontSize:13}}>
                        ❌ Refuser
                      </button>
                    </div>
                  </div>
                )}
                {/* Zone validation receveur */}
                {iAmExpReceiver && expSt==="pending" && (
```

Note the `onClick={ev=>ev.stopPropagation()}` on the new banner — the whole card has `onClick={()=>openDetail(e)}` (see the outer `<div key={e.id} className="card" ... onClick={()=>openDetail(e)}>` a few lines above), so without it, clicking the banner's background (not a button) would also open the detail modal — matching how the existing "Zone validation receveur" banner right below it does NOT have this guard today. Check the existing banner's outer div once you're editing: if it also lacks `stopPropagation` and that's intentional (clicking it opens the detail modal, which is harmless), drop the `onClick` from the new banner's outer div too for consistency — don't introduce an inconsistent interaction pattern between the two banners.

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual check**

Same flow as Task 4 but for an expense: confirm an expense, delete it as the sender (expect ⏳ instead of immediate delete), confirm the receiver sees the banner, and that "Refuser" restores the normal ✕ for the sender.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Add deletion-confirmation UI for expenses (list row)"
```

---

### Task 6: Expense detail modal — banner and button swap

**Files:**
- Modify: `src/App.jsx` — expense detail modal (currently lines ~11640-11760).

**Interfaces:**
- Consumes: `e.pendingDelete` (Task 2), `cancelDeleteExp`/`confirmDeleteExp`/`rejectDeleteExp` (Task 3), `iAmSender`/`iAmReceiver` already computed in this modal's scope (line ~11651-11652 — note these are locally-scoped to the detail modal and unrelated to the same-named variables inside the reimbursement list branch from Task 4, which is a different code block).

- [ ] **Step 1: Add the receiver's confirm/reject deletion banner and swap the sender's delete button**

Find:

```js
              {/* Actions */}
              {isPending&&iAmReceiver&&(
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  <button onClick={()=>{confirmExp(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:C.grn,color:"#fff",borderRadius:12,fontWeight:800,fontSize:14}}>✅ {t.expValidateBtn||"Valider"}</button>
                  <button onClick={()=>{rejectExp(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:12,fontWeight:700,fontSize:14}}>❌ {t.expRejectBtn||"Refuser"}</button>
                </div>
              )}
              {(iAmSender||isAdm)&&(
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{startEdit(e);setDetailExp(null);}} style={{flex:1,padding:"12px",background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13}}>✎ Modifier</button>
                  <button onClick={()=>{del(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:12,fontWeight:700,fontSize:13}}>🗑 Supprimer</button>
                </div>
              )}
```

Replace with:

```js
              {/* Actions */}
              {isPending&&iAmReceiver&&(
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  <button onClick={()=>{confirmExp(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:C.grn,color:"#fff",borderRadius:12,fontWeight:800,fontSize:14}}>✅ {t.expValidateBtn||"Valider"}</button>
                  <button onClick={()=>{rejectExp(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:12,fontWeight:700,fontSize:14}}>❌ {t.expRejectBtn||"Refuser"}</button>
                </div>
              )}
              {e.pendingDelete&&iAmReceiver&&(
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:13,color:C.txt,marginBottom:10,lineHeight:1.5}}>
                    🗑️ <strong style={{color:creator?.color||C.blu}}>{creatorLabel}</strong> souhaite supprimer cette dépense.
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{confirmDeleteExp(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:C.red,color:"#fff",borderRadius:12,fontWeight:800,fontSize:13}}>🗑️ Confirmer la suppression</button>
                    <button onClick={()=>{rejectDeleteExp(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:"transparent",color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13}}>❌ Refuser</button>
                  </div>
                </div>
              )}
              {(iAmSender||isAdm)&&!e.pendingDelete&&(
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{startEdit(e);setDetailExp(null);}} style={{flex:1,padding:"12px",background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13}}>✎ Modifier</button>
                  <button onClick={()=>{del(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:"transparent",color:C.red,border:`1.5px solid ${C.red}`,borderRadius:12,fontWeight:700,fontSize:13}}>🗑 Supprimer</button>
                </div>
              )}
              {(iAmSender||isAdm)&&e.pendingDelete&&(
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{startEdit(e);setDetailExp(null);}} style={{flex:1,padding:"12px",background:C.sur,color:C.txt,border:`1.5px solid ${C.bor}`,borderRadius:12,fontWeight:700,fontSize:13}}>✎ Modifier</button>
                  <button onClick={()=>{cancelDeleteExp(e.id);setDetailExp(null);}} style={{flex:1,padding:"12px",background:"transparent",color:C.yel,border:`1.5px solid ${C.yel}`,borderRadius:12,fontWeight:700,fontSize:13}}>⏳ Annuler la demande</button>
                </div>
              )}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 63`, `pass 63`, `fail 0` (unchanged — this plan touches no pure functions in `core.js`).

- [ ] **Step 4: Manual check**

Open the detail modal (click the card) for a confirmed expense, click "🗑 Supprimer" as the sender — expect the modal to close (matching existing behavior: `del(e.id)` is called then `setDetailExp(null)`) and, on reopening that expense's detail, see "⏳ Annuler la demande" instead of "🗑 Supprimer". As the receiver, opening the same expense's detail should show the new "souhaite supprimer" block with Confirmer/Refuser.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Add deletion-confirmation UI for expenses (detail modal)"
```
