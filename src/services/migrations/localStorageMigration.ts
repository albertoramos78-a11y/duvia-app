import { supabase } from "../supabase/supabaseClient";

const MIGRATION_FLAG_KEY = "duvia_migrated_phase1_v1";

/**
 * Migration Phase 1 : duvia_vault + duvia_msgs → Supabase.
 * Ne touche PAS à `duvia_cfg` (déjà géré par useFamilySync, qui pousse tout
 * le blob vers families.data). Idempotente : ne s'exécute qu'une fois grâce
 * au flag posé en localStorage à la fin.
 */
export async function runPhase1Migration(familyId: string, userId: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.localStorage.getItem(MIGRATION_FLAG_KEY)) return;

  try {
    await migrateVaultDocs(familyId, userId);
    await migrateMessages(familyId, userId);
    window.localStorage.setItem(MIGRATION_FLAG_KEY, new Date().toISOString());
  } catch (e) {
    console.error("[Duvia][migration-phase1] échec, on réessaiera au prochain chargement:", e);
    // Pas de flag posé => on retentera la prochaine fois. Pas de suppression
    // des données locales en cas d'échec, par sécurité.
  }
}

async function migrateVaultDocs(familyId: string, userId: string): Promise<void> {
  const raw = window.localStorage.getItem("duvia_vault");
  if (!raw) return;
  const docs: any[] = JSON.parse(raw);
  if (!Array.isArray(docs) || docs.length === 0) return;

  for (const doc of docs) {
    if (!doc?.file?.dataUrl) continue; // rien à uploader (doc sans fichier)
    const blob = dataUrlToBlob(doc.file.dataUrl);
    const storagePath = `${familyId}/${doc.id}-${(doc.file.name || doc.name || "fichier").replace(/[^\w.\-]/g, "_")}`;

    const { error: upErr } = await supabase.storage
      .from("vault")
      .upload(storagePath, blob, { contentType: doc.file.type || blob.type, upsert: true });
    if (upErr) { console.error("[migration] upload échoué pour", doc.name, upErr); continue; }

    const { error: insErr } = await supabase.from("vault_documents").insert({
      family_id: familyId,
      uploaded_by: userId,
      file_name: doc.name,
      storage_path: storagePath,
      mime_type: doc.file.type || null,
      file_size: doc.file.size ?? blob.size,
      category_idx: doc.catIdx ?? 0,
      notes: doc.notes ?? null,
      shared: doc.shared !== false,
      pinned: !!doc.pinned,
      created_at: doc.createdAt || new Date().toISOString(),
    });
    if (insErr) console.error("[migration] insert metadata échoué pour", doc.name, insErr);
  }
}

async function migrateMessages(familyId: string, userId: string): Promise<void> {
  const raw = window.localStorage.getItem("duvia_msgs");
  if (!raw) return;
  const msgs: any[] = JSON.parse(raw);
  if (!Array.isArray(msgs) || msgs.length === 0) return;

  // "Carte d'identité" : local_id (Date.now() de l'app) -> uuid Supabase.
  // Remplie automatiquement par l'effet ajouté dans App.jsx dès que chaque
  // personne s'est connectée au moins une fois après la mise à jour.
  const { data: links, error: linkErr } = await supabase
    .from("id_links")
    .select("local_id, supabase_uid")
    .eq("family_id", familyId);
  if (linkErr) { console.error("[migration] impossible de lire id_links:", linkErr); return; }

  const localToUid = new Map<string, string>((links ?? []).map((l) => [l.local_id, l.supabase_uid]));

  const rows = msgs
    .map((m) => {
      const senderUid = localToUid.get(String(m.from));
      const recipientUids = (m.to || []).map((id: any) => localToUid.get(String(id))).filter(Boolean);
      if (!senderUid || recipientUids.length === 0) return null; // pas encore de carte d'identité pour ce participant
      return {
        family_id: familyId,
        sender_id: senderUid,
        recipient_ids: recipientUids,
        content: m.content,
        read_by: (m.readBy || []).map((id: any) => localToUid.get(String(id))).filter(Boolean),
        created_at: m.ts || new Date().toISOString(),
      };
    })
    .filter(Boolean);

  if (rows.length === 0) {
    console.warn("[migration] aucun message migré — les cartes d'identité ne sont pas encore toutes enregistrées.");
    return;
  }
  if (rows.length < msgs.length) {
    console.warn(`[migration] ${msgs.length - rows.length} message(s) ignoré(s) (participant sans carte d'identité encore — enfant/observateur, ou pas encore reconnecté).`);
  }

  const { error } = await supabase.from("messages").insert(rows);
  if (error) console.error("[migration] insert messages échoué:", error);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mime = header.match(/data:(.*?);base64/)?.[1] || "application/octet-stream";
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
