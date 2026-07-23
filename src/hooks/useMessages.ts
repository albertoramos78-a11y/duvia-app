import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { type DuviaMessage, listMessages, sendMessage, markMessageRead, setMessageReaction, deleteMessage } from "../services/supabase/messageService";
import { listHiddenConversations, hideConversation as hideConversationInDb } from "../services/supabase/hiddenConversationsService";

/**
 * Remplace `const [msgs, setMsgs] = useLocalStorage("duvia_msgs", [])`
 * (App.jsx ligne ~4085). La logique de regroupement par conversation
 * (ck(ids), allConvs, currentMsgs...) peut rester identique côté composant :
 * elle ne fait que dériver `msgs`, qui garde la même forme de tableau.
 */
export function useMessages(familyId: string | null, userId: string | null) {
  const [msgs, setMsgs] = useState<DuviaMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hiddenConvs, setHiddenConvs] = useState<Record<string, string>>({});

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
          } else if (payload.eventType === "DELETE") {
            setMsgs((prev) => prev.filter((m) => m.id !== payload.old.id));
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

  /** Supprime un message (autorisé côté serveur seulement si personne d'autre ne l'a encore lu). */
  const remove = useCallback(
    async (id: string) => {
      const prevMsgs = msgs;
      setMsgs((prev) => prev.filter((m) => m.id !== id)); // optimiste
      try {
        await deleteMessage(id);
      } catch (e) {
        setMsgs(prevMsgs); // annule l'optimisme si le serveur a refusé (ex: lu entre-temps)
        throw e;
      }
    },
    [msgs]
  );

  const refreshHidden = useCallback(async () => {
    if (!userId) return;
    try {
      const rows = await listHiddenConversations(userId);
      setHiddenConvs(Object.fromEntries(rows.map((r) => [r.convKey, r.hiddenAt])));
    } catch (e) {
      // Silencieux : une erreur ici ne doit pas bloquer l'affichage des messages.
      // Au pire une conversation reste visible qui aurait dû être masquée.
    }
  }, [userId]);

  useEffect(() => {
    refreshHidden();
  }, [refreshHidden]);

  /** Masque une conversation pour l'utilisateur courant (optimiste, comme react/remove ci-dessus). */
  const hideConversation = useCallback(
    async (convKey: string) => {
      if (!familyId || !userId) return;
      const prevHiddenConvs = hiddenConvs;
      setHiddenConvs((prev) => ({ ...prev, [convKey]: new Date().toISOString() }));
      try {
        const hiddenAt = await hideConversationInDb(userId, familyId, convKey);
        setHiddenConvs((prev) => ({ ...prev, [convKey]: hiddenAt }));
      } catch (e) {
        setHiddenConvs(prevHiddenConvs);
      }
    },
    [familyId, userId, hiddenConvs]
  );

  return { msgs, loading, error, send, markRead, react, remove, refresh, hiddenConvs, hideConversation };
}
