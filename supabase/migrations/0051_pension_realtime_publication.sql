-- 0051_pension_realtime_publication.sql
--
-- pension_configs/pension_payments (0046) were never added to the
-- supabase_realtime publication, unlike expenses/reimbursements/messages —
-- the client's postgres_changes subscriptions joined fine (SUBSCRIBED) but
-- never received any events, since Postgres only replicates tables
-- explicitly listed in the publication. Confirmed live 2026-07-23: both
-- parents needed a manual refresh to see any pension action (propose,
-- confirm, request/confirm/cancel end) performed by the other.
--
-- Idempotent guard since ALTER PUBLICATION ... ADD TABLE errors if the
-- table is already a member.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'pension_configs'
  ) then
    alter publication supabase_realtime add table public.pension_configs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'pension_payments'
  ) then
    alter publication supabase_realtime add table public.pension_payments;
  end if;
end $$;
