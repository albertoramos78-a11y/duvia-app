import { supabase } from "./supabaseClient";

export interface VaultDocument {
  id: string;
  family_id: string;
  uploaded_by: string;
  added_by_name: string | null;
  name: string;
  category_idx: number;
  doc_date: string | null;
  notes: string | null;
  file_name: string | null;
  storage_path: string | null;
  mime_type: string | null;
  file_size: number | null;
  shared: boolean;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface VaultDocInput {
  name: string;
  categoryIdx: number;
  docDate: string;
  notes: string;
  shared: boolean;
  file: File | null;
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

async function uploadFile(familyId: string, file: File): Promise<{ storage_path: string }> {
  const storagePath = buildStoragePath(familyId, file.name);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return { storage_path: storagePath };
}

export async function createVaultDocument(params: {
  familyId: string;
  uploadedBy: string;
  addedByName: string;
  input: VaultDocInput;
}): Promise<VaultDocument> {
  const { familyId, uploadedBy, addedByName, input } = params;

  let fileFields: Partial<VaultDocument> = {};
  if (input.file) {
    const { storage_path } = await uploadFile(familyId, input.file);
    fileFields = {
      storage_path,
      file_name: input.file.name,
      mime_type: input.file.type || null,
      file_size: input.file.size,
    };
  }

  const { data, error } = await supabase
    .from("vault_documents")
    .insert({
      family_id: familyId,
      uploaded_by: uploadedBy,
      added_by_name: addedByName,
      name: input.name,
      category_idx: input.categoryIdx,
      doc_date: input.docDate || null,
      notes: input.notes || null,
      shared: input.shared,
      pinned: false,
      ...fileFields,
    })
    .select("*")
    .single();

  if (error) {
    // Rollback best-effort si l'enregistrement échoue après l'upload
    if (fileFields.storage_path) await supabase.storage.from(BUCKET).remove([fileFields.storage_path]);
    throw error;
  }
  return data;
}

export async function updateVaultDocument(
  id: string,
  familyId: string,
  patch: Partial<Pick<VaultDocument, "name" | "category_idx" | "doc_date" | "notes" | "shared" | "pinned">> & {
    newFile?: File | null;
    removeFile?: boolean;
    previousStoragePath?: string | null;
  }
): Promise<VaultDocument> {
  const { newFile, removeFile, previousStoragePath, ...fields } = patch;
  let fileFields: Partial<VaultDocument> = {};

  if (newFile) {
    const { storage_path } = await uploadFile(familyId, newFile);
    fileFields = {
      storage_path,
      file_name: newFile.name,
      mime_type: newFile.type || null,
      file_size: newFile.size,
    };
  } else if (removeFile) {
    fileFields = { storage_path: null, file_name: null, mime_type: null, file_size: null };
  }

  const { data, error } = await supabase
    .from("vault_documents")
    .update({ ...fields, ...fileFields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  // Si on a remplacé ou retiré le fichier, on supprime l'ancien APRÈS le succès de la mise à jour
  if ((newFile || removeFile) && previousStoragePath) {
    await supabase.storage.from(BUCKET).remove([previousStoragePath]);
  }
  return data;
}

export async function deleteVaultDocument(doc: Pick<VaultDocument, "id" | "storage_path">): Promise<void> {
  if (doc.storage_path) {
    const { error: storageErr } = await supabase.storage.from(BUCKET).remove([doc.storage_path]);
    if (storageErr) throw storageErr;
  }
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
