import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase/supabaseClient";
import {
  type VaultDocument,
  listVaultDocuments,
  uploadVaultDocument,
  updateVaultDocument,
  deleteVaultDocument,
  getVaultDocumentUrl,
} from "../services/supabase/vaultService";

/**
 * Remplace `const [docs, setDocs] = useLocalStorage("duvia_vault", [])`
 * (App.jsx ligne ~12588). L'appel composant change un peu : on passe d'un
 * setState synchrone à des actions async (upload/update/remove), mais la
 * forme des données affichées (docs[]) reste la même pour ne pas casser le
 * rendu existant.
 */
export function useVault(familyId: string | null, userId: string | null) {
  const [docs, setDocs] = useState<VaultDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!familyId) return;
    setLoading(true);
    try {
      setDocs(await listVaultDocuments(familyId));
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Erreur de chargement du coffre-fort");
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Realtime : un autre parent ajoute/modifie/supprime un doc -> on resync.
  useEffect(() => {
    if (!familyId) return;
    const channel = supabase
      .channel(`vault_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "vault_documents", filter: `family_id=eq.${familyId}` },
        () => refresh()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [familyId, refresh]);

  const addDoc = useCallback(
    async (file: File, categoryIdx: number, notes: string, shared: boolean) => {
      if (!familyId || !userId) throw new Error("Famille ou utilisateur non prêt");
      const doc = await uploadVaultDocument({ familyId, uploadedBy: userId, file, categoryIdx, notes, shared });
      setDocs((prev) => [doc, ...prev]);
      return doc;
    },
    [familyId, userId]
  );

  const editDoc = useCallback(async (id: string, patch: Parameters<typeof updateVaultDocument>[1]) => {
    const updated = await updateVaultDocument(id, patch);
    setDocs((prev) => prev.map((d) => (d.id === id ? updated : d)));
    return updated;
  }, []);

  const togglePin = useCallback(
    (id: string) => {
      const target = docs.find((d) => d.id === id);
      if (!target) return Promise.resolve();
      return editDoc(id, { pinned: !target.pinned });
    },
    [docs, editDoc]
  );

  const removeDoc = useCallback(async (id: string) => {
    const target = docs.find((d) => d.id === id);
    if (!target) return;
    await deleteVaultDocument(target);
    setDocs((prev) => prev.filter((d) => d.id !== id));
  }, [docs]);

  const openDoc = useCallback((storagePath: string) => getVaultDocumentUrl(storagePath), []);

  return { docs, loading, error, addDoc, editDoc, togglePin, removeDoc, openDoc, refresh };
}
