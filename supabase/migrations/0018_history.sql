-- 0018_history.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Historique légal des actions famille — IMMUABLE côté serveur.
--
-- Pourquoi :
--   • created_at généré par le serveur Supabase (pas le client) → preuve légale
--   • Aucune policy UPDATE ni DELETE → personne ne peut modifier ou effacer
--   • Utilisable comme journal d'audit pour avocats / médiateurs
--
-- À exécuter APRÈS 0017.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.history (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  UUID        NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  action     TEXT        NOT NULL DEFAULT '',
  detail     TEXT        NOT NULL DEFAULT '',
  type       TEXT        NOT NULL DEFAULT '',
  who        TEXT        NOT NULL DEFAULT 'Système',   -- nom à la date de l'action
  user_id    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()         -- ← SERVEUR, immuable
);

-- Index pour chargement rapide par famille
CREATE INDEX IF NOT EXISTS history_family_id_idx  ON public.history(family_id);
CREATE INDEX IF NOT EXISTS history_created_at_idx ON public.history(family_id, created_at DESC);

-- ── RLS : lecture + écriture pour membres, AUCUNE modification / suppression ──

ALTER TABLE public.history ENABLE ROW LEVEL SECURITY;

-- SELECT : tout membre de la famille
CREATE POLICY "history_select" ON public.history FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = history.family_id AND fm.user_id = auth.uid()
  ));

-- INSERT : tout membre de la famille
CREATE POLICY "history_insert" ON public.history FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = history.family_id AND fm.user_id = auth.uid()
  ));

-- ⚠️ PAS de policy UPDATE → les entrées sont en lecture seule après insertion
-- ⚠️ PAS de policy DELETE  → les entrées ne peuvent jamais être supprimées
-- (Même l'admin Supabase peut supprimer via Dashboard si absolument nécessaire,
--  mais aucun utilisateur de l'app ne le peut)

-- ── Migration des données JSONB existantes ────────────────────────────────────
-- Note : les entrées migrées ont des timestamps CLIENT (non certifiés serveur).
-- Elles sont incluses pour continuité mais ne constituent pas des preuves légales.

DO $$
DECLARE
  fam  RECORD;
  h    JSONB;
  ts   TIMESTAMPTZ;
BEGIN
  FOR fam IN
    SELECT id, data FROM public.families
    WHERE data IS NOT NULL
      AND data ? 'history'
      AND jsonb_typeof(data->'history') = 'array'
      AND jsonb_array_length(data->'history') > 0
  LOOP
    FOR h IN SELECT * FROM jsonb_array_elements(fam.data->'history') LOOP
      BEGIN
        -- Utilise la date client comme approximation (non certifiée)
        ts := COALESCE(NULLIF(h->>'date', '')::timestamptz, NOW());
        INSERT INTO public.history (
          family_id, action, detail, type, who, created_at
        ) VALUES (
          fam.id,
          COALESCE(NULLIF(h->>'action', ''), '—'),
          COALESCE(h->>'detail', ''),
          COALESCE(h->>'type', ''),
          COALESCE(NULLIF(h->>'who', ''), 'Système'),
          ts
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Entrée historique ignorée pour famille % : %', fam.id, SQLERRM;
      END;
    END LOOP;
  END LOOP;
END $$;
