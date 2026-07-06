-- 0023_expense_realtime_delete_fix.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Corrige la propagation temps réel des suppressions de dépenses/remboursements.
--
-- Problème : `expenses` et `reimbursements` sont bien dans la publication
-- supabase_realtime, mais leurs policies RLS SELECT référencent une autre
-- table (family_members, via une sous-requête EXISTS). Pour un événement
-- DELETE, Supabase Realtime a besoin de l'image complète de l'ancienne ligne
-- pour ré-évaluer si l'abonné a le droit de la voir — avec REPLICA IDENTITY
-- par défaut (clé primaire seule), cette vérification échoue silencieusement
-- et l'événement n'est jamais diffusé aux autres clients. Résultat observé :
-- la suppression n'apparaît que chez celui qui l'a faite (mise à jour
-- optimiste locale), les autres doivent recharger la page pour la voir
-- disparaître — alors que les UPDATE (ex. pending_delete) se propagent bien.
--
-- Solution : REPLICA IDENTITY FULL fournit la ligne complète dans le flux de
-- réplication, permettant à Realtime de correctement ré-évaluer la policy.
--
-- À exécuter APRÈS 0022. Idempotent (ALTER TABLE ... REPLICA IDENTITY est
-- réexécutable sans risque).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expenses REPLICA IDENTITY FULL;
ALTER TABLE public.reimbursements REPLICA IDENTITY FULL;
