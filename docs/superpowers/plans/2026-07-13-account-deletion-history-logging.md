# Log Account-Deletion History Entries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user deletes their own account and that leaves at least one other active member behind in a family, log a `"<name> a quitté la famille (compte supprimé)"` entry in that family's Historique — the one gap the family-membership-history feature deliberately left open.

**Architecture:** A single Postgres trigger function, `public.log_account_deletion_history()`, fires `AFTER DELETE ON public.family_members`. When the deleted row was `status = 'active'`, it counts the family's remaining `status = 'active'` members; if at least one remains, it inserts one row into `public.history`. No client code changes — this is a pure SQL migration, run by the user directly in the Supabase SQL editor (per this project's established workflow; the assistant has no direct DB access).

**Revised 2026-07-13 after a live test failure:** the first version triggered on `BEFORE DELETE ON auth.users` instead. Live-tested with real accounts, it produced no entry. Diagnostic logging (temporarily added to the trigger function) proved it fired but found zero `family_members` rows — because the `delete-account` Edge Function deletes the `family_members` row in its step 1, and only deletes `auth.users` in its step 5, at the very end. By the time the `auth.users` trigger ran, the row it needed was long gone. Fixed by moving the trigger to `family_members` itself. Verified safe against double-logging voluntary leaves/removals by reading the actual `leave_family()`/`remove_family_member()` RPC source (via `pg_get_functiondef`): both only `UPDATE ... SET status = 'removed'`, never `DELETE` — so a `family_members` deletion only ever happens via `delete-account` today.

**Tech Stack:** PostgreSQL (Supabase-hosted), PL/pgSQL trigger function.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-account-deletion-history-logging-design.md` — read it first for full rationale (updated to match the revised design).
- Migration file goes in `supabase/migrations/`, numbered `0034_log_account_deletion_history.sql`, idempotent (safe to re-run).
- No client code (`src/App.jsx`, etc.) changes in this plan → **no** `APP_VERSION`/`SW_VERSION` bump needed.
- The `history` table (`supabase/migrations/0018_history.sql`) has no UPDATE/DELETE policy — this migration only ever `INSERT`s into it, consistent with that immutability guarantee.
- The assistant cannot run SQL against the live Supabase project directly — every SQL step below is written to be pasted into the Supabase SQL editor by the user.

---

### Task 1: Write and verify the account-deletion history trigger

**Files:**
- Create: `supabase/migrations/0034_log_account_deletion_history.sql`

**Interfaces:**
- Consumes: `public.family_members` (columns: `family_id uuid`, `user_id uuid`, `display_name text`, `email text`, `status text`), `public.history` (columns: `family_id uuid`, `action text`, `detail text`, `type text`, `who text`, `user_id uuid`) — both already exist (migrations 0015/0018/0020).
- Produces: trigger `trg_log_account_deletion_history` on `public.family_members`, function `public.log_account_deletion_history()`. Nothing downstream in this codebase depends on these names yet — this is the only task.

- [x] **Step 1: Write the migration file**

Create `supabase/migrations/0034_log_account_deletion_history.sql` with this exact content:

```sql
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
```

- [x] **Step 2: Commit the migration file**

```bash
git add supabase/migrations/0034_log_account_deletion_history.sql
git commit -m "Fix account-deletion history trigger: fire on family_members, not auth.users"
```

- [ ] **Step 3 (manual, user only): Run the corrected migration in Supabase**

Open the Supabase project's SQL Editor and paste/run the full contents of the corrected `supabase/migrations/0034_log_account_deletion_history.sql`. This drops the old (non-working) trigger/function and the temporary debug table, then installs the corrected version.

Expected: `Success. No rows returned.`

- [ ] **Step 4 (manual, user only): Confirm the new trigger was installed**

Run this read-only sanity check in the SQL Editor:

```sql
SELECT tgname, tgrelid::regclass AS on_table, tgenabled
FROM pg_trigger
WHERE tgname = 'trg_log_account_deletion_history';
```

Expected: exactly one row, `on_table = family_members` (not `auth.users` this time), `tgenabled = 'O'`.

- [ ] **Step 5 (manual, user only): Live-test the main case — departure logged when other members remain**

1. Using two test accounts linked to the same family (a fresh pair, since the previous test accounts were consumed) — note which one you'll delete (Account A) and which one stays (Account B).
2. On Account B's session, open the **Historique** tab and note the current entries.
3. On Account A's session, go to **Préférences → Sécurité → Supprimer mon compte** and confirm the deletion.
4. On Account B's session, refresh/reopen the **Historique** tab.

Expected: a new entry reading `"<nom du compte A> a quitté la famille (compte supprimé)"`, type Famille (👪), visible to Account B.

- [ ] **Step 6 (manual, user only): Live-test the edge case — last member deleted produces no entry**

1. Before deleting, get that test family's id: in the SQL Editor, run
   `SELECT family_id FROM family_members WHERE user_id = '<the about-to-be-deleted user's uid>';`
   and note the `family_id`.
2. Using a test account that is the **only** active member of its family (create a fresh solo test account if none exists), delete that account via **Préférences → Sécurité → Supprimer mon compte**.
3. In the SQL Editor, run:
   `SELECT * FROM history WHERE family_id = '<family_id from step 1>' ORDER BY created_at DESC LIMIT 5;`

Expected: no new `"... a quitté la famille (compte supprimé)"` row, and the account deletion itself completes without error.
