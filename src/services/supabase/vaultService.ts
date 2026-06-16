import { supabase } from "./supabaseClient";

export interface VaultDocument {
  id: string;
  family_id: string;
  uploaded_by: string;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  file_size: number | null;
  category_idx: number;
  notes: string | null;
  shared: boolean;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  /** URL signée, générée à la demande (1h) — jamais stockée en base. */
  signedUrl?: string;
}

const BUCKET = "vault";
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h

function buildStoragePath(familyId: string, fileName: string) {
  // Convention attendue par les policies RLS : "<family_id>/<...>"
  const safeName = fileName.replace(/[^\w.\-]/g, "_").slice(0, 150);
  return `${familyId}/${Date.now()}-${safeName}`;
}

export async function listVaultDocuments(familyId: string): Promise<VaultDocument[]> {
  const { data, error } = await supabase
    .from("vault_documents")
    .select("*")
    .eq("family_id", familyId)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function uploadVaultDocument(params: {
  familyId: string;
  uploadedBy: string;
  file: File;
  categoryIdx: number;
  notes: string;
  shared: boolean;
}): Promise<VaultDocument> {
  const { familyId, uploadedBy, file, categoryIdx, notes, shared } = params;
  const storagePath = buildStoragePath(familyId, file.name);

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadErr) throw uploadErr;

  const { data, error: insertErr } = await supabase
    .from("vault_documents")
    .insert({
      family_id: familyId,
      uploaded_by: uploadedBy,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type || null,
      file_size: file.size,
      category_idx: categoryIdx,
      notes,
      shared,
    })
    .select("*")
    .single();

  if (insertErr) {
    // Rollback best-effort : si l'insert échoue, ne pas laisser un fichier orphelin
    await supabase.storage.from(BUCKET).remove([storagePath]);
    throw insertErr;
  }
  return data;
}

export async function updateVaultDocument(
  id: string,
  patch: Partial<Pick<VaultDocument, "file_name" | "category_idx" | "notes" | "shared" | "pinned">>
): Promise<VaultDocument> {
  const { data, error } = await supabase
    .from("vault_documents")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function deleteVaultDocument(doc: Pick<VaultDocument, "id" | "storage_path">): Promise<void> {
  const { error: storageErr } = await supabase.storage.from(BUCKET).remove([doc.storage_path]);
  if (storageErr) throw storageErr;
  const { error: dbErr } = await supabase.from("vault_documents").delete().eq("id", doc.id);
  if (dbErr) throw dbErr;
}

export async function getVaultDocumentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}
