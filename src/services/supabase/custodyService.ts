import { supabase } from "../../supabaseClient";

// ─────────────────────────────────────────────────────────────────────
// custodyService — Phase 3 : écriture en parallèle uniquement.
// L'app continue de lire/afficher depuis cfg.custody (JSON legacy).
// Ces fonctions sont "fire-and-forget" : un échec ici ne doit jamais
// bloquer l'expérience utilisateur, le JSON reste la source de vérité
// tant que la Phase 4 (bascule de lecture) n'est pas faite.
// ─────────────────────────────────────────────────────────────────────

export interface CustodyRuleInput {
  familyId: string;
  childId: number | null; // null = règle globale famille
  type: "weekAlt" | "exclusive" | "custom";
  startMonth: number;
  startYear: number;
  weekAltEvenIdx?: number | null;
  exclusiveMainIdx?: number | null;
  exclusiveWeIdx?: number | null;
  exclusiveParity?: "even" | "odd" | null;
  confirmed: boolean;
}

export async function upsertCustodyRule(input: CustodyRuleInput) {
  const { error, data } = await supabase
    .from("custody_rules")
    .upsert(
      {
        family_id: input.familyId,
        child_id: input.childId,
        type: input.type,
        start_month: input.startMonth,
        start_year: input.startYear,
        week_alt_even_idx: input.weekAltEvenIdx ?? null,
        exclusive_main_idx: input.exclusiveMainIdx ?? null,
        exclusive_we_idx: input.exclusiveWeIdx ?? null,
        exclusive_parity: input.exclusiveParity ?? null,
        confirmed: input.confirmed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "family_id,child_id" }
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export interface PatternDayInput {
  parentIdx: number | null;
  timeType: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
}

export async function replaceCustodyPatternDays(ruleId: string, days: PatternDayInput[]) {
  // Remplace tout le cycle d'un coup (plus simple/sûr que des upserts un par un
  // vu que le cycle entier change ensemble côté UI).
  const { error: delErr } = await supabase.from("custody_pattern_days").delete().eq("rule_id", ruleId);
  if (delErr) throw delErr;
  if (days.length === 0) return;
  const rows = days.map((d, i) => ({
    rule_id: ruleId,
    day_index: i,
    parent_idx: d.parentIdx,
    time_type: d.timeType,
    start_time: d.startTime,
    end_time: d.endTime,
    location: d.location,
  }));
  const { error } = await supabase.from("custody_pattern_days").insert(rows);
  if (error) throw error;
}

export interface CustodyOverrideInput {
  familyId: string;
  childId: number | null;
  date: string; // "YYYY-MM-DD"
  parentIdx?: number | null;
  obsId?: string | null;
  obsName?: string | null;
  timeType?: string;
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  note?: string | null;
}

export async function upsertCustodyOverride(input: CustodyOverrideInput) {
  const { error } = await supabase.from("custody_overrides").upsert(
    {
      family_id: input.familyId,
      child_id: input.childId,
      override_date: input.date,
      parent_idx: input.parentIdx ?? null,
      obs_id: input.obsId ?? null,
      obs_name: input.obsName ?? null,
      time_type: input.timeType ?? "full",
      start_time: input.startTime ?? null,
      end_time: input.endTime ?? null,
      location: input.location ?? null,
      note: input.note ?? null,
      source: "manual",
    },
    { onConflict: "family_id,child_id,override_date" }
  );
  if (error) throw error;
}

export async function deleteCustodyOverride(familyId: string, childId: number | null, date: string) {
  let query = supabase
    .from("custody_overrides")
    .delete()
    .eq("family_id", familyId)
    .eq("override_date", date)
    .eq("source", "manual");
  query = childId === null ? query.is("child_id", null) : query.eq("child_id", childId);
  const { error } = await query;
  if (error) throw error;
}

export interface SpecialDatesInput {
  familyId: string;
  childId: number | null;
  motherDayEnabled?: boolean;
  fatherDayEnabled?: boolean;
  parentBirths?: any[];
  childBirths?: any[];
  evenParentIdx?: number | null;
  oddParentIdx?: number | null;
}

export async function upsertSpecialDates(input: SpecialDatesInput) {
  const patch: Record<string, any> = {
    family_id: input.familyId,
    child_id: input.childId,
    updated_at: new Date().toISOString(),
  };
  if (input.motherDayEnabled !== undefined) patch.mother_day_enabled = input.motherDayEnabled;
  if (input.fatherDayEnabled !== undefined) patch.father_day_enabled = input.fatherDayEnabled;
  if (input.parentBirths !== undefined) patch.parent_births = input.parentBirths;
  if (input.childBirths !== undefined) patch.child_births = input.childBirths;
  if (input.evenParentIdx !== undefined) patch.even_parent_idx = input.evenParentIdx;
  if (input.oddParentIdx !== undefined) patch.odd_parent_idx = input.oddParentIdx;

  const { error } = await supabase
    .from("custody_special_dates")
    .upsert(patch, { onConflict: "family_id,child_id" });
  if (error) throw error;
}

export interface CustomDateInput {
  familyId: string;
  label: string;
  day: number;
  month: number;
  year: number | null;
  yearly: boolean;
  parentId: number | null;
}

export async function replaceCustomDates(familyId: string, dates: CustomDateInput[]) {
  // Même logique que pattern days : on remplace tout d'un coup (la liste
  // entière est réécrite ensemble côté UI à chaque modification).
  const { error: delErr } = await supabase.from("custody_custom_dates").delete().eq("family_id", familyId);
  if (delErr) throw delErr;
  if (dates.length === 0) return;
  const rows = dates.map((d) => ({
    family_id: familyId,
    label: d.label,
    day: d.day,
    month: d.month,
    year: d.year,
    yearly: d.yearly,
    parent_id: d.parentId,
  }));
  const { error } = await supabase.from("custody_custom_dates").insert(rows);
  if (error) throw error;
}
