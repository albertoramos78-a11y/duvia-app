import { useCallback } from "react";
import {
  upsertCustodyRule,
  replaceCustodyPatternDays,
  upsertCustodyOverride,
  deleteCustodyOverride,
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
      console.error(`[Duvia][custody-shadow] ${label} a échoué (sans impact utilisateur) :`, e);
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

  return { shadowRule, shadowOverride, shadowDeleteOverride, shadowSpecialDates, shadowCustomDates };
}
