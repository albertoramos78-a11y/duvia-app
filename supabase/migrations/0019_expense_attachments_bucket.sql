-- 0019_expense_attachments_bucket.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Bucket Supabase Storage pour les pièces jointes aux dépenses.
--
-- Remplace le stockage base64 dans la colonne JSONB expenses.attachments.
-- Convention de chemin : {family_id}/expenses/{timestamp}-{filename}
-- Bucket PRIVÉ : accès uniquement via signed URLs (1h d'expiration).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Créer le bucket (idempotent) ──────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-attachments',
  'expense-attachments',
  false,          -- privé : accès via signed URLs uniquement
  10485760,       -- 10 Mo max par fichier
  ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Policies Storage (sur storage.objects) ─────────────────────────────────
-- Convention : le premier segment du chemin est le family_id
-- Ex: "abc-123/expenses/1750000000000-facture.jpg"
-- → (storage.foldername(name))[1] = "abc-123" = family_id

-- SELECT (téléchargement / signed URL) : membres de la famille
CREATE POLICY "expense_att_select"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'expense-attachments'
    AND EXISTS (
      SELECT 1 FROM public.family_members fm
      WHERE fm.family_id::text = (storage.foldername(name))[1]
        AND fm.user_id = auth.uid()
    )
  );

-- INSERT (upload) : membres de la famille
CREATE POLICY "expense_att_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'expense-attachments'
    AND EXISTS (
      SELECT 1 FROM public.family_members fm
      WHERE fm.family_id::text = (storage.foldername(name))[1]
        AND fm.user_id = auth.uid()
    )
  );

-- DELETE (suppression) : membres de la famille
CREATE POLICY "expense_att_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'expense-attachments'
    AND EXISTS (
      SELECT 1 FROM public.family_members fm
      WHERE fm.family_id::text = (storage.foldername(name))[1]
        AND fm.user_id = auth.uid()
    )
  );

-- Note : pas de policy UPDATE → les fichiers sont immuables une fois uploadés.
-- Pour "modifier" une pièce jointe, on supprime et on ré-upload.
