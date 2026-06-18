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
            const incoming = payload.new as DuviaMessage;
            // Supabase diffuse l'événement INSERT à TOUS les abonnés, y compris
            // l'émetteur — qui a déjà ajouté le message en optimiste dans `send`.
            // On déduplique par id pour ne pas l'afficher deux fois.
            setMsgs((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
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
    async (senderId: string, senderName: string, recipientIds: string[], content: string) => {
      if (!familyId) throw new Error("Famille non prête");
      const msg = await sendMessage({ familyId, senderId, senderName, recipientIds, content });
      // Dédup : l'événement realtime INSERT peut arriver avant ou après ce
      // setState ; dans les deux cas on garde une seule occurrence par id.
      setMsgs((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      return msg;
    },
    [familyId]
  );

  const markRead = useCallback(
    async (id: string, userId: string) => {
      const target = msgs.find((m) => m.id === id);
      if (!target) return;
      const currentReadBy = target.read_by ?? [];
      if (currentReadBy.includes(userId)) return; // déjà lu — rien à faire
      await markMessageRead(id, userId, currentReadBy);
      setMsgs((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, read_by: [...(m.read_by ?? []), userId] } : m
        )
      );
    },
    [msgs]
  );

  return { msgs, loading, error, send, markRead, refresh };
}
