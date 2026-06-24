import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";

/**
 * La messagerie (MessagingTab) regroupe les conversations par id LOCAL
 * (user.id, un Date.now() côté app), mais le stockage cloud (table
 * `messages`) utilise l'uuid Supabase Auth de chacun. Ce hook fait le pont
 * dans les deux sens, à partir de la table `id_links` (remplie automatiquement
 * à chaque connexion — voir l'effet ajouté dans App.jsx).
 */
export function useIdLinks(familyId: string | null) {
  const [links, setLinks] = useState<{ local_id: string; supabase_uid: string }[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!familyId) return;
    let cancelled = false;
    setLoaded(false);
    supabase
      .from("id_links")
      .select("local_id, supabase_uid")
      .eq("family_id", familyId)
      .then(({ data }) => { if (!cancelled) { setLinks(data ?? []); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [familyId]);

  const localToUid = useMemo(() => new Map(links.map(l => [l.local_id, l.supabase_uid])), [links]);
  const uidToLocal = useMemo(() => new Map(links.map(l => [l.supabase_uid, l.local_id])), [links]);

  // `ready` = la requête a abouti (même si la famille n'a aucun lien), et non
  // « il existe au moins un lien » — sinon une famille légitimement vide ne
  // serait jamais considérée comme prête.
  return { localToUid, uidToLocal, ready: loaded };
}
