-- 0034_log_account_deletion_history.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Journalise un départ dans l'Historique quand il est causé par une
-- suppression de compte, plutôt qu'un départ volontaire ou un retrait — ces
-- deux derniers cas sont déjà couverts par le code client (voir
-- 0018_history.sql + docs/superpowers/specs/2026-07-13-family-membership-
-- history-design.md). Backlog item 8a.
--
-- Design (RÉVISÉ après un test live infructueux — voir historique de
-- conversation 2026-07-13) : trigger AFTER DELETE sur public.family_members,
-- PAS sur auth.users. Preuves recueillies en live :
--   • L'Edge Function delete-account supprime la ligne family_members en
--     étape 1, et ne supprime auth.users qu'en étape 5 (tout à la fin) — un
--     trigger BEFORE DELETE ON auth.users se déclenche bien mais ne trouve
--     alors plus aucune ligne family_members à lire (confirmé via un
--     journal de diagnostic temporaire).
--   • leave_family() et remove_family_member() (RPC SECURITY DEFINER,
--     vérifiées via pg_get_functiondef) ne suppriment JAMAIS la ligne
--     family_members — elles font seulement UPDATE ... SET status =
--     'removed'. Un DELETE sur family_members ne peut donc arriver QUE via
--     delete-account aujourd'hui → aucun risque de doublon avec les
--     départs volontaires/retraits déjà journalisés côté client.
--
-- Ne logge que si la ligne supprimée était status = 'active' (pas déjà
-- 'removed' avant la suppression du compte) ET s'il reste au moins un
-- autre membre actif dans la famille après ce départ.
--
-- Dépend de : 0018_history.sql (table history), 0020_member_email.sql
-- (colonne family_members.email). Idempotent — sûr à ré-exécuter.
-- À exécuter dans le SQL Editor Supabase (aucune CLI dans ce projet).
-- ─────────────────────────────────────────────────────────────────────────────

-- Nettoyage de la version précédente (trigger sur auth.users, abandonnée).
DROP TRIGGER IF EXISTS trg_log_account_deletion_history ON auth.users;
DROP TRIGGER IF EXISTS trg_log_account_deletion_history ON public.family_members;
DROP FUNCTION IF EXISTS public.log_account_deletion_history();
DROP TABLE IF EXISTS public._debug_trigger_log;

CREATE OR REPLACE FUNCTION public.log_account_deletion_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  remaining_count INT;
  who_name TEXT;
BEGIN
  IF OLD.status = 'active' THEN
    SELECT COUNT(*) INTO remaining_count
    FROM public.family_members
    WHERE family_id = OLD.family_id
      AND status = 'active';

    IF remaining_count > 0 THEN
      who_name := COALESCE(NULLIF(btrim(OLD.display_name), ''), NULLIF(btrim(OLD.email), ''), 'Cette personne');

      INSERT INTO public.history (family_id, action, detail, type, who, user_id)
      VALUES (
        OLD.family_id,
        who_name || ' a quitté la famille (compte supprimé)',
        '',
        'family',
        who_name,
        NULL
      );
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_log_account_deletion_history
  AFTER DELETE ON public.family_members
  FOR EACH ROW
  EXECUTE FUNCTION public.log_account_deletion_history();
