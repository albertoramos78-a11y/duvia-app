import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase/supabaseClient";
import { type DuviaMessage, listMessages, sendMessage, markMessageRead } from "../services/supabase/messageService";

/**
 * Remplace `const [msgs, setMsgs] = useLocalStorage("duvia_msgs", [])`
 * (App.jsx ligne ~4085). La logique de regroupement par conversation
 * (ck(ids), allConvs, currentMsgs...) peut rester identique côté composant :
 * elle ne fait que dériver `msgs`, qui garde la même forme de tableau.
 */
export function useMessages(familyId: string | null) {
  const [msgs, setMsgs] = useState<DuviaMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!familyId) return;
    setLoading(true);
    try {
      setMsgs(await listMessages(familyId));
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Erreur de chargement des messages");
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!familyId) return;
    const channel = supabase
      .channel(`messages_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `family_id=eq.${familyId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setMsgs((prev) => [...prev, payload.new as DuviaMessage]);
          } else if (payload.eventType === "UPDATE") {
            setMsgs((prev) => prev.map((m) => (m.id === payload.new.id ? (payload.new as DuviaMessage) : m)));
          }
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [familyId]);

  const send = useCallback(
    async (senderId: string, recipientIds: string[], content: string) => {
      if (!familyId) throw new Error("Famille non prête");
      // optimistic local insert; le realtime au-dessus dédoublonnera côté autre device,
      // et l'INSERT confirmé remplacera l'id local si tu veux pousser plus loin.
      const msg = await sendMessage({ familyId, senderId, recipientIds, content });
      setMsgs((prev) => [...prev, msg]);
      return msg;
    },
    [familyId]
  );

  const markRead = useCallback(
    async (id: string, userId: string) => {
      const target = msgs.find((m) => m.id === id);
      if (!target) return;
      await markMessageRead(id, userId, target.read_by);
      setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, read_by: [...m.read_by, userId] } : m)));
    },
    [msgs]
  );

  return { msgs, loading, error, send, markRead, refresh };
}
