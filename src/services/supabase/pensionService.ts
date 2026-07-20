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
