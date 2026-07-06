import { supabase } from "../../supabaseClient";

// ── Types (forme camelCase utilisée partout dans l'UI) ────────────────────────

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

// ── Conversions DB ↔ UI ───────────────────────────────────────────────────────

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

// ── Expenses CRUD ─────────────────────────────────────────────────────────────

export async function listExpenses(familyId: string): Promise<Expense[]> {
  const { data, error } = await supabase
    .from("expenses")
    .select("*")
    .eq("family_id", familyId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(dbToExpense);
}

export async function createExpense(
  familyId: string,
  exp: Omit<Expense, "id" | "createdAt">
): Promise<Expense> {
  const { data, error } = await supabase
    .from("expenses")
    .insert(expenseToDb(exp, familyId))
    .select("*")
    .single();
  if (error) throw error;
  return dbToExpense(data);
}

export async function createExpenses(
  familyId: string,
  exps: Omit<Expense, "id" | "createdAt">[]
): Promise<Expense[]> {
  if (exps.length === 0) return [];
  const { data, error } = await supabase
    .from("expenses")
    .insert(exps.map((e) => expenseToDb(e, familyId)))
    .select("*");
  if (error) throw error;
  return (data ?? []).map(dbToExpense);
}

export async function patchExpense(
  id: string,
  patch: Partial<Omit<Expense, "id" | "createdAt">>
): Promise<Expense> {
  // Convertit les champs camelCase en snake_case pour la mise à jour partielle
  const dbPatch: Record<string, any> = {};
  if (patch.label         !== undefined) dbPatch.label           = patch.label;
  if (patch.amount        !== undefined) dbPatch.amount          = patch.amount;
  if (patch.paidBy        !== undefined) dbPatch.paid_by         = patch.paidBy;
  if (patch.split         !== undefined) dbPatch.split_pct       = patch.split;
  if (patch.category      !== undefined) dbPatch.category        = patch.category;
  if (patch.date          !== undefined) dbPatch.date            = patch.date || null;
  if (patch.note          !== undefined) dbPatch.note            = patch.note;
  if (patch.attachments   !== undefined) dbPatch.attachments     = patch.attachments;
  if (patch.recurring     !== undefined) dbPatch.recurring       = patch.recurring;
  if (patch.recurringFreq !== undefined) dbPatch.recurring_freq  = patch.recurringFreq;
  if (patch.recurringEnd  !== undefined) dbPatch.recurring_end   = patch.recurringEnd || null;
  if (patch.recurringId   !== undefined) dbPatch.recurring_id    = patch.recurringId ? String(patch.recurringId) : null;
  if (patch.recurringStart!== undefined) dbPatch.recurring_start = patch.recurringStart || null;
  if (patch.status        !== undefined) dbPatch.status          = patch.status;
  if (patch.pendingDelete !== undefined) dbPatch.pending_delete  = patch.pendingDelete;
  if (patch.createdBy     !== undefined) dbPatch.created_by      = patch.createdBy;

  const { data, error } = await supabase
    .from("expenses")
    .update(dbPatch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return dbToExpense(data);
}

export async function removeExpense(id: string): Promise<void> {
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) throw error;
}

export async function removeExpenseSeries(
  recurringId: string,
  familyId: string
): Promise<void> {
  const { error } = await supabase
    .from("expenses")
    .delete()
    .eq("recurring_id", recurringId)
    .eq("family_id", familyId);
  if (error) throw error;
}

// ── Reimbursements CRUD ───────────────────────────────────────────────────────

export async function listReimbursements(familyId: string): Promise<Reimbursement[]> {
  const { data, error } = await supabase
    .from("reimbursements")
    .select("*")
    .eq("family_id", familyId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(dbToReimbursement);
}

export async function createReimbursement(
  familyId: string,
  reim: Omit<Reimbursement, "id" | "createdAt">
): Promise<Reimbursement> {
  const { data, error } = await supabase
    .from("reimbursements")
    .insert(reimbursementToDb(reim, familyId))
    .select("*")
    .single();
  if (error) throw error;
  return dbToReimbursement(data);
}

export async function patchReimbursement(
  id: string,
  patch: Partial<Omit<Reimbursement, "id" | "createdAt">>
): Promise<Reimbursement> {
  const dbPatch: Record<string, any> = {};
  if (patch.from   !== undefined) dbPatch.from_parent = patch.from;
  if (patch.to     !== undefined) dbPatch.to_parent   = patch.to;
  if (patch.amount !== undefined) dbPatch.amount      = patch.amount;
  if (patch.date   !== undefined) dbPatch.date        = patch.date || null;
  if (patch.note   !== undefined) dbPatch.note        = patch.note;
  if (patch.status !== undefined) dbPatch.status      = patch.status;
  if (patch.pendingDelete !== undefined) dbPatch.pending_delete = patch.pendingDelete;

  const { data, error } = await supabase
    .from("reimbursements")
    .update(dbPatch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return dbToReimbursement(data);
}

export async function removeReimbursement(id: string): Promise<void> {
  const { error } = await supabase.from("reimbursements").delete().eq("id", id);
  if (error) throw error;
}
