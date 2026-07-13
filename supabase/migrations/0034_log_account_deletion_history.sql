-- 0034_log_account_deletion_history.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Journalise un départ dans l'Historique quand il est causé par une
-- suppression de compte (auth.users), plutôt qu'un départ volontaire ou un
-- retrait — ces deux derniers cas sont déjà couverts par le code client
-- (voir 0018_history.sql + docs/superpowers/specs/2026-07-13-family-
-- membership-history-design.md). Backlog item 8a.
--
-- Pourquoi un trigger sur auth.users plutôt que modifier l'Edge Function
-- delete-account : cette fonction a déjà dérivé du dépôt une fois (audit
-- sécurité 2026-07-08) ; un trigger SQL committé ici reste la seule source
-- de vérité, et se déclenche quel que soit le chemin de code qui supprime
-- le compte, pas seulement delete-account.
--
-- Pourquoi BEFORE DELETE (pas AFTER) : garantit que les lignes
-- family_members de ce compte sont encore lisibles au moment du trigger,
-- sans dépendre de l'ordre d'une éventuelle suppression en cascade.
--
-- Dépend de : 0018_history.sql (table history), 0020_member_email.sql
-- (colonne family_members.email). Idempotent — sûr à ré-exécuter.
-- À exécuter dans le SQL Editor Supabase (aucune CLI dans ce projet).
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_log_account_deletion_history ON auth.users;
DROP FUNCTION IF EXISTS public.log_account_deletion_history();

CREATE OR REPLACE FUNCTION public.log_account_deletion_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fm RECORD;
  remaining_count INT;
  who_name TEXT;
BEGIN
  FOR fm IN
    SELECT family_id, display_name, email
    FROM public.family_members
    WHERE user_id = OLD.id
  LOOP
    SELECT COUNT(*) INTO remaining_count
    FROM public.family_members
    WHERE family_id = fm.family_id
      AND status = 'active'
      AND user_id <> OLD.id;

    IF remaining_count > 0 THEN
      who_name := COALESCE(NULLIF(btrim(fm.display_name), ''), NULLIF(btrim(fm.email), ''), 'Cette personne');

      INSERT INTO public.history (family_id, action, detail, type, who, user_id)
      VALUES (
        fm.family_id,
        who_name || ' a quitté la famille (compte supprimé)',
        '',
        'family',
        who_name,
        NULL
      );
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_log_account_deletion_history
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.log_account_deletion_history();
