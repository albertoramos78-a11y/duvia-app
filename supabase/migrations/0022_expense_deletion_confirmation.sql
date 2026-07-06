-- 0022_expense_deletion_confirmation.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Confirmation de suppression pour les dépenses/remboursements déjà validés.
--
-- Problème corrigé : le créateur pouvait supprimer unilatéralement une
-- dépense ou un remboursement déjà accepté par l'autre parent, sans aucune
-- validation — pas acceptable pour un outil qui sert de preuve en cas de
-- litige de garde partagée.
--
-- Solution : un simple drapeau, indépendant de la colonne `status` existante
-- (qui reste "confirmed" pendant toute la durée de la demande — l'élément
-- continue donc de compter normalement dans les totaux). Quand le créateur
-- demande la suppression d'un élément déjà `status='confirmed'`, on pose
-- `pending_delete=true` au lieu de supprimer ; l'autre parent confirme
-- (suppression réelle) ou refuse (`pending_delete` repasse à false). Le
-- créateur peut aussi annuler sa propre demande de la même façon.
--
-- Voir docs/superpowers/specs/2026-07-06-expense-deletion-confirmation-design.md
--
-- À exécuter APRÈS 0021. Idempotent (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.reimbursements
  ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN NOT NULL DEFAULT false;
