-- 0064_legal_consents_source.sql
--
-- Adds `source` ('fresh' vs 'backfill') to legal_consents so it's possible
-- to tell, after the fact, whether a given row reflects the user actively
-- checking the consent box in that session (confirmation email sent) or a
-- silent retroactive backfill of an existing account onto the server-side
-- record (no email, no visible user action). Previously indistinguishable.
-- See docs/superpowers/specs/2026-07-29-legal-consent-server-record-design.md
-- for the base design; this closes a deferred minor from that feature's
-- final review.
--
-- Idempotent, run after 0063.

alter table public.legal_consents
  add column if not exists source text not null default 'backfill';

alter table public.legal_consents
  drop constraint if exists legal_consents_source_check;
alter table public.legal_consents
  add constraint legal_consents_source_check check (source in ('fresh', 'backfill'));

drop function if exists public.record_legal_consent(text);

create or replace function public.record_legal_consent(p_notice_version text, p_source text default 'backfill')
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'not_authenticated'; end if;
  if p_source not in ('fresh', 'backfill') then raise exception 'invalid_source'; end if;

  insert into public.legal_consents (user_id, notice_version, source)
  values (v_caller, p_notice_version, p_source)
  on conflict (user_id, notice_version) do nothing;
end;
$$;

revoke all on function public.record_legal_consent(text, text) from public;
grant execute on function public.record_legal_consent(text, text) to authenticated;
