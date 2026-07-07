import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { type DuviaMessage, listMessages, sendMessage, markMessageRead, setMessageReaction } from "../services/supabase/messageService";

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
      if (currentReadBy.includes(userId)) return;
      await markMessageRead(id, userId, currentReadBy);
      setMsgs((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, read_by: [...(m.read_by ?? []), userId] } : m
        )
      );
    },
    [msgs]
  );

  /** Remplace les réactions d'un message (valeur déjà calculée par toggleMessageReaction). */
  const react = useCallback(
    async (id: string, reactions: Record<string, string[]>) => {
      setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, reactions } : m))); // optimiste
      try {
        await setMessageReaction(id, reactions);
      } catch (e) {
        await refresh(); // resynchronise en cas d'échec, comme les autres mutations de ce hook
      }
    },
    [refresh]
  );

  return { msgs, loading, error, send, markRead, react, refresh };
}
