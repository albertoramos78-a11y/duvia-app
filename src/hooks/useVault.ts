import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  type VaultDocument,
  type VaultDocInput,
  listVaultDocuments,
  createVaultDocument,
  updateVaultDocument,
  deleteVaultDocument,
  getVaultDocumentUrl,
} from "../services/supabase/vaultService";

export function useVault(familyId: string | null, userId: string | null) {
  const [docs, setDocs] = useState<VaultDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!familyId) return;
    if (!opts?.silent) setLoading(true);
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
  // En mode silencieux pour ne pas faire clignoter l'écran (spinner) à chaque
  // changement distant — la liste se met à jour en place.
  useEffect(() => {
    if (!familyId) return;
    const channel = supabase
      .channel(`vault_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "vault_documents", filter: `family_id=eq.${familyId}` },
        () => refresh({ silent: true })
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [familyId, refresh]);

  const addDoc = useCallback(
    async (input: VaultDocInput, addedByName: string) => {
      if (!familyId || !userId) throw new Error("Famille ou utilisateur non prêt");
      const doc = await createVaultDocument({ familyId, uploadedBy: userId, addedByName, input });
      setDocs((prev) => [doc, ...prev]);
      return doc;
    },
    [familyId, userId]
  );

  const updateDoc = useCallback(
    async (
      id: string,
      patch: Partial<Pick<VaultDocument, "name" | "category_idx" | "doc_date" | "notes" | "shared" | "pinned">>,
      newFile?: File | null,
      removeFile?: boolean
    ) => {
      if (!familyId) throw new Error("Famille non prête");
      const existing = docs.find((d) => d.id === id);
      const updated = await updateVaultDocument(id, familyId, {
        ...patch,
        newFile,
        removeFile,
        previousStoragePath: (newFile || removeFile) ? existing?.storage_path ?? null : null,
      });
      setDocs((prev) => prev.map((d) => (d.id === id ? updated : d)));
      return updated;
    },
    [familyId, docs]
  );

  const togglePin = useCallback(
    (id: string) => {
      const target = docs.find((d) => d.id === id);
      if (!target) return Promise.resolve();
      return updateDoc(id, { pinned: !target.pinned });
    },
    [docs, updateDoc]
  );

  const removeDoc = useCallback(
    async (id: string) => {
      const target = docs.find((d) => d.id === id);
      if (!target) return;
      await deleteVaultDocument(target);
      setDocs((prev) => prev.filter((d) => d.id !== id));
    },
    [docs]
  );

  const openDoc = useCallback((storagePath: string) => getVaultDocumentUrl(storagePath), []);

  return { docs, loading, error, addDoc, updateDoc, togglePin, removeDoc, openDoc, refresh };
}
