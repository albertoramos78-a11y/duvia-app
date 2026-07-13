import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  type HistoryEntry,
  dbToHistoryEntry,
  listHistory,
  addHistoryEntry,
} from "../services/supabase/historyService";

/**
 * Historique légal immuable côté Supabase.
 *
 * • created_at est généré par le serveur → preuve légale horodatée
 * • Aucune suppression ou modification possible (RLS)
 * • Temps réel : les deux parents voient les nouvelles entrées immédiatement
 *
 * addHistEntry est fire-and-forget avec mise à jour optimiste.
 * En cas d'échec DB, l'entrée optimiste reste visible (on ne la supprime pas,
 * car supprimer de l'historique serait contre-intuitif pour l'utilisateur).
 */
export function useHistory(familyId: string | null) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Chargement initial ────────────────────────────────────────────────────

  useEffect(() => {
    if (!familyId) { setLoading(false); return; }
    setLoading(true);
    listHistory(familyId)
      .then((entries) => { setHistory(entries); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [familyId]);

  // ── Realtime : nouvelle entrée ajoutée par l'autre parent ─────────────────

  useEffect(() => {
    if (!familyId) return;

    const channel = supabase
      .channel(`history_${familyId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "history",
          filter: `family_id=eq.${familyId}`,
        },
        (payload) => {
          const incoming = dbToHistoryEntry(payload.new);
          setHistory((prev) =>
            // Skip si déjà présent (optimistic update par ce client)
            prev.some((h) => h.id === incoming.id)
              ? prev
              : [incoming, ...prev]
          );
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [familyId]);

  // ── addHistEntry : optimiste, awaitable (fire-and-forget par défaut) ──────

  const addHistEntry = useCallback(
    (
      action: string,
      detail: string = "",
      type: string = "",
      who: string = "Système",
      userId: string | null = null
    ) => {
      if (!familyId) return Promise.resolve();

      // Mise à jour optimiste immédiate
      const tempId = `temp_${Date.now()}`;
      const optimistic: HistoryEntry = {
        id: tempId,
        action,
        detail,
        type,
        who,
        userId,
        createdAt: new Date().toISOString(),
      };
      setHistory((prev) => [optimistic, ...prev]);

      // 🔧 Le retour (Promise) permet aux appelants qui enchaînent tout de
      // suite un rechargement de page ou une déconnexion (ex: quitter la
      // famille) d'ATTENDRE que l'écriture ait réellement atteint Supabase
      // avant de naviguer — sans ça, la navigation coupait la requête en vol
      // et l'entrée n'était jamais enregistrée en base. La plupart des
      // appelants n'attendent pas cette promesse (fire-and-forget inchangé),
      // c'est un ajout rétrocompatible. Ne rejette jamais : l'échec est déjà
      // loggé ci-dessous et l'entrée optimiste reste visible localement,
      // donc l'appelant n'a pas besoin de gérer d'erreur lui-même.
      return addHistoryEntry(familyId, { action, detail, type, who, userId })
        .then((saved) => {
          setHistory((prev) => {
            const withoutTemp = prev.filter((h) => h.id !== tempId);
            // Si le realtime a déjà injecté l'entrée, ne pas dupliquer
            if (withoutTemp.some((h) => h.id === saved.id)) return withoutTemp;
            return [saved, ...withoutTemp];
          });
        })
        .catch((err) => {
          // On garde l'entrée optimiste (ne jamais supprimer de l'historique)
          console.error("useHistory: échec écriture DB →", err);
        });
    },
    [familyId]
  );

  return { history, loading, addHistEntry };
}
