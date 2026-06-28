import { supabase } from "../../supabaseClient";

// ── Type ──────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  type: string;
  who: string;           // nom de l'auteur au moment de l'action
  userId: string | null; // uid Supabase (pour audit)
  createdAt: string;     // horodatage serveur (immuable)
}

// ── Conversion DB → UI ────────────────────────────────────────────────────────

export function dbToHistoryEntry(row: Record<string, any>): HistoryEntry {
  return {
    id:        row.id,
    action:    row.action    ?? "",
    detail:    row.detail    ?? "",
    type:      row.type      ?? "",
    who:       row.who       ?? "Système",
    userId:    row.user_id   ?? null,
    createdAt: row.created_at ?? new Date().toISOString(),
  };
}

// ── Lecture ───────────────────────────────────────────────────────────────────

export async function listHistory(familyId: string, limit = 500): Promise<HistoryEntry[]> {
  const { data, error } = await supabase
    .from("history")
    .select("*")
    .eq("family_id", familyId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(dbToHistoryEntry);
}

// ── Écriture (INSERT seulement — pas d'UPDATE ni de DELETE) ───────────────────

export async function addHistoryEntry(
  familyId: string,
  entry: {
    action: string;
    detail?: string;
    type?: string;
    who?: string;
    userId?: string | null;
  }
): Promise<HistoryEntry> {
  const { data, error } = await supabase
    .from("history")
    .insert({
      family_id: familyId,
      action:    entry.action,
      detail:    entry.detail  ?? "",
      type:      entry.type    ?? "",
      who:       entry.who     ?? "Système",
      user_id:   entry.userId  ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return dbToHistoryEntry(data);
}
