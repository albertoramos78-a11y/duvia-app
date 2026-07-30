-- 0062_legal_consents_no_cascade.sql
--
-- legal_consents.user_id was created with `references auth.users(id) on
-- delete cascade` (migration 0061). That means deleting an account (the
-- delete-account Edge Function's final `auth.admin.deleteUser()` call)
-- silently destroyed the exact evidence this table exists for — a user
-- disputing something AFTER deleting their account is precisely the
-- scenario where proof of an earlier CGU/CGV acceptance matters most.
--
-- GDPR generally allows retaining consent records under the accountability
-- obligation (art. 5(2) / 7(1)) even after an erasure request, so the fix
-- here is to let the row survive account deletion rather than anonymize or
-- restrict it. Dropping the foreign key (not switching to ON DELETE SET
-- NULL) is deliberate: SET NULL would keep the row but lose the one thing
-- that makes it useful as evidence — which specific user accepted. The
-- column stays NOT NULL and keeps the user's original UUID forever, just
-- without Postgres enforcing it against a (possibly since-deleted) row in
-- auth.users.
--
-- No application code changes needed: delete-account already deletes each
-- user-owned table it wants cleaned up explicitly (see its `subscriptions`
-- delete) rather than relying on cascade for everything, so removing this
-- one cascade doesn't change its behavior beyond the row it was silently
-- destroying.
--
-- Idempotent — safe to re-run.

alter table public.legal_consents
  drop constraint if exists legal_consents_user_id_fkey;
