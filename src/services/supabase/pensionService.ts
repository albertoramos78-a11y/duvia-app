import { supabase } from "../../supabaseClient";

export interface PensionConfig {
  id: string;
  familyId: string;
  fromParent: number;
  fromUserId: string;
  toParent: number;
  toUserId: string;
  amount: number;
  dayOfMonth: number;
  startDate: string;
  endDate: string | null;
  status: "proposed" | "active" | "superseded";
  createdByUserId: string;
  createdAt: string;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  pendingEnd: boolean;
  endRequestedBy: string | null;
}

export interface PensionPayment {
  id: string;
  familyId: string;
  configId: string;
  period: string;
  amount: number;
  dueDate: string;
  status: "pending" | "marked_paid" | "confirmed" | "contested";
  markedPaidByUserId: string | null;
  markedPaidAt: string | null;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  note: string;
  createdAt: string;
  pendingDelete: boolean;
  deleteRequestedBy: string | null;
}

export function dbToPensionConfig(row: Record<string, any>): PensionConfig {
  return {
    id: row.id,
    familyId: row.family_id,
    fromParent: row.from_parent,
    fromUserId: row.from_user_id,
    toParent: row.to_parent,
    toUserId: row.to_user_id,
    amount: Number(row.amount ?? 0),
    dayOfMonth: row.day_of_month,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    confirmedByUserId: row.confirmed_by_user_id ?? null,
    confirmedAt: row.confirmed_at ?? null,
    pendingEnd: row.pending_end ?? false,
    endRequestedBy: row.end_requested_by ?? null,
  };
}

export function dbToPensionPayment(row: Record<string, any>): PensionPayment {
  return {
    id: row.id,
    familyId: row.family_id,
    configId: row.config_id,
    period: row.period,
    amount: Number(row.amount ?? 0),
    dueDate: row.due_date,
    status: row.status,
    markedPaidByUserId: row.marked_paid_by_user_id ?? null,
    markedPaidAt: row.marked_paid_at ?? null,
    confirmedByUserId: row.confirmed_by_user_id ?? null,
    confirmedAt: row.confirmed_at ?? null,
    note: row.note ?? "",
    createdAt: row.created_at,
    pendingDelete: row.pending_delete ?? false,
    deleteRequestedBy: row.delete_requested_by ?? null,
  };
}

export async function listPensionConfigs(familyId: string): Promise<PensionConfig[]> {
  const { data, error } = await supabase
    .from("pension_configs")
    .select("*")
    .eq("family_id", familyId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(dbToPensionConfig);
}

export async function listPensionPayments(familyId: string): Promise<PensionPayment[]> {
  const { data, error } = await supabase
    .from("pension_payments")
    .select("*")
    .eq("family_id", familyId)
    .order("due_date", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(dbToPensionPayment);
}

export async function proposePensionConfig(params: {
  familyId: string;
  fromParent: number;
  fromUserId: string;
  toParent: number;
  toUserId: string;
  amount: number;
  dayOfMonth: number;
  startDate: string;
}): Promise<PensionConfig> {
  const { data, error } = await supabase.rpc("propose_pension_config", {
    p_family_id: params.familyId,
    p_from_parent: params.fromParent,
    p_from_user_id: params.fromUserId,
    p_to_parent: params.toParent,
    p_to_user_id: params.toUserId,
    p_amount: params.amount,
    p_day_of_month: params.dayOfMonth,
    p_start_date: params.startDate,
  });
  if (error) throw error;
  return dbToPensionConfig(data);
}

export async function confirmPensionConfig(configId: string): Promise<PensionConfig> {
  const { data, error } = await supabase.rpc("confirm_pension_config", { p_config_id: configId });
  if (error) throw error;
  return dbToPensionConfig(data);
}

export async function cancelPensionConfig(configId: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_pension_config", { p_config_id: configId });
  if (error) throw error;
}

/** Demande de mettre fin à une pension ACTIVE — nécessite l'accord de l'autre parent. */
export async function requestEndPensionConfig(configId: string): Promise<PensionConfig> {
  const { data, error } = await supabase.rpc("request_end_pension_config", { p_config_id: configId });
  if (error) throw error;
  return dbToPensionConfig(data);
}

/** Confirme la fin (par l'AUTRE parent que le demandeur) — clôt la pension. */
export async function confirmEndPensionConfig(configId: string): Promise<PensionConfig> {
  const { data, error } = await supabase.rpc("confirm_end_pension_config", { p_config_id: configId });
  if (error) throw error;
  return dbToPensionConfig(data);
}

/** Annule/refuse une demande de fin (le demandeur qui se rétracte, ou l'autre parent qui refuse). */
export async function cancelEndPensionConfig(configId: string): Promise<PensionConfig> {
  const { data, error } = await supabase.rpc("cancel_end_pension_config", { p_config_id: configId });
  if (error) throw error;
  return dbToPensionConfig(data);
}

export async function markPensionPaymentPaid(paymentId: string): Promise<PensionPayment> {
  const { data, error } = await supabase.rpc("mark_pension_payment_paid", { p_payment_id: paymentId });
  if (error) throw error;
  return dbToPensionPayment(data);
}

export async function confirmPensionPayment(paymentId: string): Promise<PensionPayment> {
  const { data, error } = await supabase.rpc("confirm_pension_payment", { p_payment_id: paymentId });
  if (error) throw error;
  return dbToPensionPayment(data);
}

export async function contestPensionPayment(paymentId: string, note: string): Promise<PensionPayment> {
  const { data, error } = await supabase.rpc("contest_pension_payment", { p_payment_id: paymentId, p_note: note });
  if (error) throw error;
  return dbToPensionPayment(data);
}

/** Demande la suppression d'une ligne de versement (erreur, doublon...) — nécessite l'accord de l'autre partie. */
export async function requestDeletePensionPayment(paymentId: string): Promise<PensionPayment> {
  const { data, error } = await supabase.rpc("request_delete_pension_payment", { p_payment_id: paymentId });
  if (error) throw error;
  return dbToPensionPayment(data);
}

/** Confirme la suppression (par l'AUTRE partie que le demandeur) — supprime réellement la ligne. */
export async function confirmDeletePensionPayment(paymentId: string): Promise<void> {
  const { error } = await supabase.rpc("confirm_delete_pension_payment", { p_payment_id: paymentId });
  if (error) throw error;
}

/** Annule/refuse une demande de suppression (le demandeur qui se rétracte, ou l'autre partie qui refuse). */
export async function cancelDeletePensionPayment(paymentId: string): Promise<PensionPayment> {
  const { data, error } = await supabase.rpc("cancel_delete_pension_payment", { p_payment_id: paymentId });
  if (error) throw error;
  return dbToPensionPayment(data);
}
