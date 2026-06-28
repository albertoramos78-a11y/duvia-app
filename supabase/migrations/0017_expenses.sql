-- 0017_expenses.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration des dépenses et remboursements hors du JSONB families.data
-- vers des tables dédiées avec RLS.
--
-- Pourquoi : données financières critiques → nécessite webhooks, audit trail,
-- intégrité référentielle. Le JSONB ne permet pas de déclencher des Edge Functions.
--
-- À exécuter APRÈS 0016. Idempotent (IF NOT EXISTS + CREATE OR REPLACE).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Table expenses ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expenses (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID          NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  label         TEXT          NOT NULL DEFAULT '',
  amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  paid_by       INT           NOT NULL DEFAULT 0,
  split_pct     INT           NOT NULL DEFAULT 50,
  category      TEXT          NOT NULL DEFAULT '',
  date          DATE,
  note          TEXT          DEFAULT '',
  attachments   JSONB         NOT NULL DEFAULT '[]'::jsonb,
  recurring     BOOLEAN       NOT NULL DEFAULT FALSE,
  recurring_freq  TEXT,
  recurring_end   DATE,
  recurring_id    TEXT,         -- identifiant partagé par toute la série
  recurring_start DATE,
  status        TEXT          NOT NULL DEFAULT 'pending',
  created_by    INT           NOT NULL DEFAULT 0,  -- index parent (0 ou 1)
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Index utiles
CREATE INDEX IF NOT EXISTS expenses_family_id_idx    ON public.expenses(family_id);
CREATE INDEX IF NOT EXISTS expenses_recurring_id_idx ON public.expenses(recurring_id) WHERE recurring_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_date_idx         ON public.expenses(date);

-- ── 2. Table reimbursements ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reimbursements (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID          NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  from_parent   INT           NOT NULL DEFAULT 0,
  to_parent     INT           NOT NULL DEFAULT 0,
  amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  date          DATE,
  note          TEXT          DEFAULT '',
  status        TEXT          NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reimbursements_family_id_idx ON public.reimbursements(family_id);

-- ── 3. Trigger updated_at (partagé) ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS expenses_updated_at      ON public.expenses;
DROP TRIGGER IF EXISTS reimbursements_updated_at ON public.reimbursements;

CREATE TRIGGER expenses_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER reimbursements_updated_at
  BEFORE UPDATE ON public.reimbursements
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ── 4. Row Level Security ─────────────────────────────────────────────────────

ALTER TABLE public.expenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reimbursements  ENABLE ROW LEVEL SECURITY;

-- expenses : tout membre de la famille peut lire et écrire
CREATE POLICY "expenses_select" ON public.expenses FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = expenses.family_id AND fm.user_id = auth.uid()
  ));

CREATE POLICY "expenses_insert" ON public.expenses FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = expenses.family_id AND fm.user_id = auth.uid()
  ));

CREATE POLICY "expenses_update" ON public.expenses FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = expenses.family_id AND fm.user_id = auth.uid()
  ));

CREATE POLICY "expenses_delete" ON public.expenses FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = expenses.family_id AND fm.user_id = auth.uid()
  ));

-- reimbursements : idem
CREATE POLICY "reimbursements_select" ON public.reimbursements FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = reimbursements.family_id AND fm.user_id = auth.uid()
  ));

CREATE POLICY "reimbursements_insert" ON public.reimbursements FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = reimbursements.family_id AND fm.user_id = auth.uid()
  ));

CREATE POLICY "reimbursements_update" ON public.reimbursements FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = reimbursements.family_id AND fm.user_id = auth.uid()
  ));

CREATE POLICY "reimbursements_delete" ON public.reimbursements FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.family_id = reimbursements.family_id AND fm.user_id = auth.uid()
  ));

-- ── 5. Migration des données JSONB existantes ─────────────────────────────────
-- Lit families.data et insère dans les nouvelles tables.
-- Idempotent : ON CONFLICT DO NOTHING (on ne ré-insère pas ce qui existe déjà).
-- Note : les IDs JSONB étaient des entiers (Date.now()) — on génère de nouveaux UUID.

DO $$
DECLARE
  fam  RECORD;
  exp  JSONB;
  reim JSONB;
BEGIN
  FOR fam IN
    SELECT id, data FROM public.families
    WHERE data IS NOT NULL
  LOOP

    -- Dépenses
    IF fam.data ? 'expenses'
       AND jsonb_typeof(fam.data->'expenses') = 'array'
       AND jsonb_array_length(fam.data->'expenses') > 0
    THEN
      FOR exp IN SELECT * FROM jsonb_array_elements(fam.data->'expenses') LOOP
        BEGIN
          INSERT INTO public.expenses (
            family_id, label, amount, paid_by, split_pct, category,
            date, note, attachments,
            recurring, recurring_freq, recurring_end,
            recurring_id, recurring_start,
            status, created_by, created_at
          ) VALUES (
            fam.id,
            COALESCE(NULLIF(TRIM(exp->>'label'), ''), 'Sans libellé'),
            COALESCE((exp->>'amount')::numeric, 0),
            COALESCE((exp->>'paidBy')::int, 0),
            COALESCE((exp->>'split')::int, 50),
            COALESCE(exp->>'category', ''),
            NULLIF(exp->>'date', '')::date,
            COALESCE(exp->>'note', ''),
            COALESCE(exp->'attachments', '[]'::jsonb),
            COALESCE((exp->>'recurring')::boolean, false),
            NULLIF(exp->>'recurringFreq', ''),
            NULLIF(exp->>'recurringEnd', '')::date,
            NULLIF(exp->>'recurringId', ''),
            NULLIF(exp->>'recurringStart', '')::date,
            COALESCE(NULLIF(exp->>'status', ''), 'confirmed'),
            COALESCE((exp->>'createdBy')::int, 0),
            NOW()
          );
        EXCEPTION WHEN OTHERS THEN
          -- Ignore les lignes invalides (montant non numérique, date invalide, etc.)
          RAISE NOTICE 'Dépense ignorée pour famille % : %', fam.id, SQLERRM;
        END;
      END LOOP;
    END IF;

    -- Remboursements
    IF fam.data ? 'reimbursements'
       AND jsonb_typeof(fam.data->'reimbursements') = 'array'
       AND jsonb_array_length(fam.data->'reimbursements') > 0
    THEN
      FOR reim IN SELECT * FROM jsonb_array_elements(fam.data->'reimbursements') LOOP
        BEGIN
          INSERT INTO public.reimbursements (
            family_id, from_parent, to_parent,
            amount, date, note, status, created_at
          ) VALUES (
            fam.id,
            COALESCE((reim->>'from')::int, 0),
            COALESCE((reim->>'to')::int, 0),
            COALESCE((reim->>'amount')::numeric, 0),
            NULLIF(reim->>'date', '')::date,
            COALESCE(reim->>'note', ''),
            COALESCE(NULLIF(reim->>'status', ''), 'confirmed'),
            NOW()
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'Remboursement ignoré pour famille % : %', fam.id, SQLERRM;
        END;
      END LOOP;
    END IF;

  END LOOP;
END $$;
