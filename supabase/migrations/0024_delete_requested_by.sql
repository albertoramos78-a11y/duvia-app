-- 0024_delete_requested_by.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Autorise n'importe quel parent (pas seulement le créateur) à demander la
-- suppression d'une dépense/remboursement déjà accepté.
--
-- Jusqu'ici, `pending_delete` supposait implicitement que seul le créateur
-- (createdBy / from) pouvait être le demandeur, et l'autre parent forcément
-- le confirmateur. Pour permettre aux DEUX parents de demander une
-- suppression, il faut savoir QUI a demandé — un simple index de position
-- (0 ou 1), suffisant ici puisque cette donnée est éphémère (effacée dès que
-- la demande est confirmée/refusée/annulée), contrairement aux colonnes
-- d'attribution légale permanentes ajoutées plus tôt ce soir.
--
-- À exécuter APRÈS 0023. Idempotent (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS delete_requested_by INT;

ALTER TABLE public.reimbursements
  ADD COLUMN IF NOT EXISTS delete_requested_by INT;
