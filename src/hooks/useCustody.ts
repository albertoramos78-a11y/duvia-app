import { useCallback } from "react";
import { supabase } from "../supabaseClient";
import {
  upsertCustodyRule,
  replaceCustodyPatternDays,
  upsertCustodyOverride,
  deleteCustodyOverride,
  clearAllManualOverrides,
  upsertSpecialDates,
  replaceCustomDates,
  type CustodyRuleInput,
  type PatternDayInput,
  type CustodyOverrideInput,
  type SpecialDatesInput,
  type CustomDateInput,
} from "../services/supabase/custodyService";

// ─────────────────────────────────────────────────────────────────────
// useCustody — Phase 3 : écriture en parallèle (shadow write).
//
// ⚠️ Ce hook n'expose AUCUNE lecture pour l'instant. L'app continue
// d'afficher le planning depuis cfg.custody (JSON) comme avant — rien
// ne change visuellement. Chaque fonction ici doit être appelée EN PLUS
// (pas à la place) des setCfg(...) existants, juste après, pour garder
// les deux systèmes synchronisés en silence.
//
// Toutes les fonctions avalent leurs erreurs (log uniquement) : un échec
// d'écriture Supabase ici ne doit JAMAIS empêcher l'utilisateur de
// modifier son planning normalement (le JSON reste la source de vérité).
// ─────────────────────────────────────────────────────────────────────

export function useCustody(familyId: string | null) {
  const safe = useCallback(async (label: string, fn: () => Promise<any>) => {
    if (!familyId) return;
    try {
      await fn();
    } catch (e) {
      // 🔧 Diagnostic temporaire (2026-07-11, backlog item 15) : capture
      // familyId + auth.uid() + statut family_members au moment de l'échec,
      // pour investiguer les 403 RLS vus en prod sur ce mécanisme sans avoir
      // à deviner. À retirer une fois la cause confirmée.
      try {
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData?.user?.id;
        const { data: fmRow, error: fmErr } = await supabase
          .from("family_members")
          .select("family_id,user_id,role,status")
          .eq("family_id", familyId)
          .eq("user_id", uid || "")
          .maybeSingle();
        console.error(`[Duvia][custody-shadow] ${label} a échoué (sans impact utilisateur) :`, e, {
          familyId, uid, fmRow, fmErr,
        });
      } catch (diagErr) {
        console.error(`[Duvia][custody-shadow] ${label} a échoué (sans impact utilisateur) :`, e, "(diagnostic lui-même a échoué:", diagErr, ")");
      }
    }
  }, [familyId]);

  const shadowRule = useCallback(
    (input: Omit<CustodyRuleInput, "familyId">, patternDays?: PatternDayInput[]) =>
      safe("upsertCustodyRule", async () => {
        const ruleId = await upsertCustodyRule({ ...input, familyId: familyId! });
        if (patternDays) await replaceCustodyPatternDays(ruleId, patternDays);
      }),
    [familyId, safe]
  );

  const shadowOverride = useCallback(
    (input: Omit<CustodyOverrideInput, "familyId">) =>
      safe("upsertCustodyOverride", () => upsertCustodyOverride({ ...input, familyId: familyId! })),
    [familyId, safe]
  );

  const shadowDeleteOverride = useCallback(
    (childId: number | null, date: string) =>
      safe("deleteCustodyOverride", () => deleteCustodyOverride(familyId!, childId, date)),
    [familyId, safe]
  );

  const shadowSpecialDates = useCallback(
    (input: Omit<SpecialDatesInput, "familyId">) =>
      safe("upsertSpecialDates", () => upsertSpecialDates({ ...input, familyId: familyId! })),
    [familyId, safe]
  );

  const shadowCustomDates = useCallback(
    (dates: Omit<CustomDateInput, "familyId">[]) =>
      safe("replaceCustomDates", () =>
        replaceCustomDates(familyId!, dates.map((d) => ({ ...d, familyId: familyId! })))
      ),
    [familyId, safe]
  );

  const shadowClearAllOverrides = useCallback(
    () => safe("clearAllManualOverrides", () => clearAllManualOverrides(familyId!)),
    [familyId, safe]
  );

  return { shadowRule, shadowOverride, shadowDeleteOverride, shadowSpecialDates, shadowCustomDates, shadowClearAllOverrides };
}
