import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase/supabaseClient";

/**
 * La messagerie (MessagingTab) regroupe les conversations par id LOCAL
 * (user.id, un Date.now() côté app), mais le stockage cloud (table
 * `messages`) utilise l'uuid Supabase Auth de chacun. Ce hook fait le pont
 * dans les deux sens, à partir de la table `id_links` (remplie automatiquement
 * à chaque connexion — voir l'effet ajouté dans App.jsx).
 */
export function useIdLinks(familyId: string | null) {
  const [links, setLinks] = useState<{ local_id: string; supabase_uid: string }[]>([]);

  useEffect(() => {
    if (!familyId) return;
    let cancelled = false;
    supabase
      .from("id_links")
      .select("local_id, supabase_uid")
      .eq("family_id", familyId)
      .then(({ data }) => { if (!cancelled) setLinks(data ?? []); });
    return () => { cancelled = true; };
  }, [familyId]);

  const localToUid = useMemo(() => new Map(links.map(l => [l.local_id, l.supabase_uid])), [links]);
  const uidToLocal = useMemo(() => new Map(links.map(l => [l.supabase_uid, l.local_id])), [links]);

  return { localToUid, uidToLocal, ready: links.length > 0 };
}
