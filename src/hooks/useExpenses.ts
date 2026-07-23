import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  type Expense,
  type Reimbursement,
  dbToExpense,
  dbToReimbursement,
  listExpenses,
  listReimbursements,
  createExpense,
  createExpenses,
  patchExpense,
  removeExpense,
  removeExpenseSeries,
  createReimbursement,
  patchReimbursement,
  removeReimbursement,
} from "../services/supabase/expenseService";

/**
 * Remplace cfg.expenses et cfg.reimbursements (JSONB).
 *
 * Retourne les données en camelCase, identique à l'ancienne forme cfg —
 * les composants UI (ExpTab) n'ont besoin que de changements minimes.
 *
 * Toutes les mutations sont optimistes : l'UI se met à jour immédiatement,
 * la DB est écrite en arrière-plan. En cas d'erreur, on resync depuis la DB.
 */
export function useExpenses(familyId: string | null) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [reimbursements, setReimbursements] = useState<Reimbursement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Chargement initial ────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    if (!familyId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [exps, reims] = await Promise.all([
        listExpenses(familyId),
        listReimbursements(familyId),
      ]);
      setExpenses(exps);
      setReimbursements(reims);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Erreur de chargement des dépenses");
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Realtime ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!familyId) return;

    const expChannel = supabase
      .channel(`expenses_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "expenses", filter: `family_id=eq.${familyId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const incoming = dbToExpense(payload.new);
            // Skip si déjà présent (optimistic update par ce client)
            setExpenses((prev) =>
              prev.some((e) => e.id === incoming.id) ? prev : [incoming, ...prev]
            );
          } else if (payload.eventType === "UPDATE") {
            const updated = dbToExpense(payload.new);
            setExpenses((prev) =>
              prev.map((e) => (e.id === updated.id ? updated : e))
            );
          } else if (payload.eventType === "DELETE") {
            setExpenses((prev) => prev.filter((e) => e.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    const reimChannel = supabase
      .channel(`reimbursements_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reimbursements", filter: `family_id=eq.${familyId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const incoming = dbToReimbursement(payload.new);
            setReimbursements((prev) =>
              prev.some((r) => r.id === incoming.id) ? prev : [incoming, ...prev]
            );
          } else if (payload.eventType === "UPDATE") {
            const updated = dbToReimbursement(payload.new);
            setReimbursements((prev) =>
              prev.map((r) => (r.id === updated.id ? updated : r))
            );
          } else if (payload.eventType === "DELETE") {
            setReimbursements((prev) => prev.filter((r) => r.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(expChannel);
      supabase.removeChannel(reimChannel);
    };
  }, [familyId]);

  // ── CRUD Expenses ─────────────────────────────────────────────────────────

  /** Ajoute une dépense simple. Optimiste : UI d'abord, DB en arrière-plan. */
  const addExpense = useCallback(
    async (exp: Omit<Expense, "id" | "createdAt">) => {
      if (!familyId) throw new Error("Famille non prête");
      const tempId = `temp_${Date.now()}`;
      const optimistic: Expense = { ...exp, id: tempId, createdAt: new Date().toISOString() };
      setExpenses((prev) => [optimistic, ...prev]);
      try {
        const saved = await createExpense(familyId, exp);
        setExpenses((prev) => {
          const withoutTemp = prev.filter((e) => e.id !== tempId);
          // Si le realtime a déjà injecté l'item, ne pas dupliquer
          if (withoutTemp.some((e) => e.id === saved.id)) return withoutTemp;
          return [saved, ...withoutTemp];
        });
        return saved;
      } catch (err) {
        setExpenses((prev) => prev.filter((e) => e.id !== tempId));
        throw err;
      }
    },
    [familyId]
  );

  /** Ajoute plusieurs dépenses (série récurrente). */
  const addExpenses = useCallback(
    async (exps: Omit<Expense, "id" | "createdAt">[]) => {
      if (!familyId) throw new Error("Famille non prête");
      if (exps.length === 0) return [];
      const tempIds = exps.map((_, i) => `temp_${Date.now()}_${i}`);
      const optimisticItems: Expense[] = exps.map((exp, i) => ({
        ...exp,
        id: tempIds[i],
        createdAt: new Date().toISOString(),
      }));
      setExpenses((prev) => [...optimisticItems, ...prev]);
      try {
        const saved = await createExpenses(familyId, exps);
        setExpenses((prev) => {
          const withoutTemps = prev.filter((e) => !tempIds.includes(e.id));
          const existingIds = new Set(withoutTemps.map((e) => e.id));
          const toAdd = saved.filter((e) => !existingIds.has(e.id));
          return [...toAdd, ...withoutTemps];
        });
        return saved;
      } catch (err) {
        setExpenses((prev) => prev.filter((e) => !tempIds.includes(e.id)));
        throw err;
      }
    },
    [familyId]
  );

  /** Met à jour une dépense existante. */
  const updateExpense = useCallback(
    async (id: string, patch: Partial<Omit<Expense, "id" | "createdAt">>) => {
      // Optimiste
      setExpenses((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
      try {
        const saved = await patchExpense(id, patch);
        setExpenses((prev) => prev.map((e) => (e.id === id ? saved : e)));
        return saved;
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  /**
   * Met à jour toute une série récurrente :
   * supprime les anciennes occurrences et insère les nouvelles.
   */
  const updateExpensesBySeries = useCallback(
    async (
      oldRecurringId: string,
      newItems: Omit<Expense, "id" | "createdAt">[]
    ) => {
      if (!familyId) throw new Error("Famille non prête");
      const tempIds = newItems.map((_, i) => `temp_series_${Date.now()}_${i}`);
      const optimisticItems: Expense[] = newItems.map((exp, i) => ({
        ...exp,
        id: tempIds[i],
        createdAt: new Date().toISOString(),
      }));
      // Optimiste : supprime l'ancienne série, affiche les nouvelles
      setExpenses((prev) => [
        ...optimisticItems,
        ...prev.filter((e) => e.recurringId !== oldRecurringId),
      ]);
      try {
        await removeExpenseSeries(oldRecurringId, familyId);
        const saved = await createExpenses(familyId, newItems);
        setExpenses((prev) => {
          const withoutTemps = prev.filter((e) => !tempIds.includes(e.id));
          const existingIds = new Set(withoutTemps.map((e) => e.id));
          const toAdd = saved.filter((e) => !existingIds.has(e.id));
          return [...toAdd, ...withoutTemps];
        });
        return saved;
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [familyId, refresh]
  );

  /** Supprime une dépense unique. */
  const deleteExpense = useCallback(
    async (id: string) => {
      setExpenses((prev) => prev.filter((e) => e.id !== id));
      try {
        await removeExpense(id);
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  /** Supprime toute une série récurrente. */
  const deleteExpensesBySeries = useCallback(
    async (recurringId: string) => {
      if (!familyId) throw new Error("Famille non prête");
      setExpenses((prev) => prev.filter((e) => e.recurringId !== recurringId));
      try {
        await removeExpenseSeries(recurringId, familyId);
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [familyId, refresh]
  );

  /** Confirme une dépense (statut → confirmed). */
  const confirmExp = useCallback(
    async (id: string) => {
      setExpenses((prev) =>
        prev.map((e) => (e.id === id ? { ...e, status: "confirmed" } : e))
      );
      try {
        await patchExpense(id, { status: "confirmed" });
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  /** Refuse une dépense (statut → rejected). */
  const rejectExp = useCallback(
    async (id: string) => {
      setExpenses((prev) =>
        prev.map((e) => (e.id === id ? { ...e, status: "rejected" } : e))
      );
      try {
        await patchExpense(id, { status: "rejected" });
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  // ── CRUD Reimbursements ───────────────────────────────────────────────────

  /** Ajoute un remboursement. */
  const addReimbursement = useCallback(
    async (reim: Omit<Reimbursement, "id" | "createdAt">) => {
      if (!familyId) throw new Error("Famille non prête");
      const tempId = `temp_reim_${Date.now()}`;
      const optimistic: Reimbursement = { ...reim, id: tempId, createdAt: new Date().toISOString() };
      setReimbursements((prev) => [optimistic, ...prev]);
      try {
        const saved = await createReimbursement(familyId, reim);
        setReimbursements((prev) => {
          const withoutTemp = prev.filter((r) => r.id !== tempId);
          if (withoutTemp.some((r) => r.id === saved.id)) return withoutTemp;
          return [saved, ...withoutTemp];
        });
        return saved;
      } catch (err) {
        setReimbursements((prev) => prev.filter((r) => r.id !== tempId));
        throw err;
      }
    },
    [familyId]
  );

  /** Met à jour un remboursement. */
  const updateReimbursement = useCallback(
    async (id: string, patch: Partial<Omit<Reimbursement, "id" | "createdAt">>) => {
      setReimbursements((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      try {
        const saved = await patchReimbursement(id, patch);
        setReimbursements((prev) => prev.map((r) => (r.id === id ? saved : r)));
        return saved;
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  /** Supprime un remboursement. */
  const deleteReimbursement = useCallback(
    async (id: string) => {
      setReimbursements((prev) => prev.filter((r) => r.id !== id));
      try {
        await removeReimbursement(id);
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  /** Confirme un remboursement (statut → confirmed). */
  const confirmReim = useCallback(
    async (id: string) => {
      setReimbursements((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "confirmed" } : r))
      );
      try {
        await patchReimbursement(id, { status: "confirmed" });
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  /** Refuse un remboursement (statut → rejected). */
  const rejectReim = useCallback(
    async (id: string) => {
      setReimbursements((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "rejected" } : r))
      );
      try {
        await patchReimbursement(id, { status: "rejected" });
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh]
  );

  // ── API publique ──────────────────────────────────────────────────────────

  return {
    expenses,
    reimbursements,
    loading,
    error,
    refresh,
    addExpense,
    addExpenses,
    updateExpense,
    updateExpensesBySeries,
    deleteExpense,
    deleteExpensesBySeries,
    confirmExp,
    rejectExp,
    addReimbursement,
    updateReimbursement,
    deleteReimbursement,
    confirmReim,
    rejectReim,
  };
}
