-- 0035_parent_locations.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Localisation d'un parent pour la météo du calendrier (backlog 18a) — table
-- dédiée, JAMAIS incluse dans families.data (le blob partagé synchronisé à
-- toute la famille). RLS restreint à la ligne du propriétaire UNIQUEMENT :
-- contrairement à toutes les autres tables de cet app, il n'y a ici AUCUNE
-- policy de lecture "tout membre de la famille" — un parent ne doit jamais
-- pouvoir lire la ligne d'un autre, seule la fonction Edge get-family-weather
-- (service role) peut lire une ligne qui n'est pas la sienne.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.parent_locations (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id  UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  city       TEXT NOT NULL DEFAULT '',
  lat        DOUBLE PRECISION NOT NULL,
  lon        DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.parent_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "parent_locations_own_select" ON public.parent_locations FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "parent_locations_own_insert" ON public.parent_locations FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "parent_locations_own_update" ON public.parent_locations FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "parent_locations_own_delete" ON public.parent_locations FOR DELETE
  USING (user_id = auth.uid());

-- ⚠️ Pas de policy family-wide : c'est volontaire, ne pas en ajouter une plus
-- tard sans revalider explicitement avec l'utilisateur (ce serait exactement
-- le bug de confidentialité que cette migration corrige).
