-- 0021_expense_identity.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Attribution légale des dépenses/remboursements : identité figée à la création.
--
-- Problème corrigé : created_by/paid_by (expenses) et from_parent/to_parent
-- (reimbursements) sont des index de position (0/1) dans cfg.parents. Un
-- créneau de position est recyclé quand un parent quitte puis qu'un nouveau
-- parent est invité (confirmInvite réutilise l'index) — donc un même index
-- désigne légitimement des personnes différentes au fil du temps. Résultat
-- observé : après le départ du parent 0 et la fermeture de sa carte, ses
-- anciennes dépenses s'affichent comme créées par la personne qui occupe
-- maintenant l'index 0.
--
-- Solution : on ajoute, en plus des colonnes de position (conservées telles
-- quelles pour le calcul du solde courant entre "les 2 parents actuels"),
-- une identité figée à la création : le vrai user_id Supabase + un instantané
-- du nom au moment des faits. Ni l'un ni l'autre ne changent plus jamais,
-- même si la personne renomme son profil ou que son créneau est recyclé.
--
-- Pas de backfill : les lignes déjà créées avant cette migration gardent ces
-- colonnes à NULL — l'affichage retombe sur le comportement actuel (résolution
-- par index) pour elles, inchangé. Voir le design doc pour le détail complet :
-- docs/superpowers/specs/2026-07-06-expense-identity-attribution-design.md
--
-- À exécuter APRÈS 0020. Idempotent (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS created_by_name    TEXT,
  ADD COLUMN IF NOT EXISTS paid_by_user_id    UUID,
  ADD COLUMN IF NOT EXISTS paid_by_name       TEXT;

ALTER TABLE public.reimbursements
  ADD COLUMN IF NOT EXISTS from_user_id UUID,
  ADD COLUMN IF NOT EXISTS from_name    TEXT,
  ADD COLUMN IF NOT EXISTS to_user_id   UUID,
  ADD COLUMN IF NOT EXISTS to_name      TEXT;
