-- 0056_pension_replica_identity_full.sql
--
-- Bug reported live 2026-07-24: confirming the deletion of a pension payment
-- line removed it for the confirming parent (optimistic local update) but
-- never propagated to the other parent in real time.
--
-- Root cause: pension_payments (and pension_configs, which can also be
-- deleted via cancel_pension_config() on a still-'proposed' row) had
-- REPLICA IDENTITY DEFAULT (primary key only). Postgres logical replication
-- only includes REPLICA IDENTITY columns in a DELETE's old-row payload —
-- with only `id` available, Supabase Realtime cannot evaluate the
-- family_id-based RLS SELECT policy to authorize broadcasting the DELETE to
-- the other family member, so the event silently never reaches them.
-- expenses/reimbursements (where delete-then-broadcast is already known to
-- work) both already have REPLICA IDENTITY FULL — matching that.
--
-- À exécuter après 0055. Idempotent (ALTER ... REPLICA IDENTITY is always
-- safe to re-run).

alter table public.pension_payments replica identity full;
alter table public.pension_configs replica identity full;
