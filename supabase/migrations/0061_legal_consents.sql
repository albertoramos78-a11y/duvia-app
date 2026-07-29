-- 0061_legal_consents.sql
--
-- Server-side, timestamped, per-user record of CGU/CGV/privacy-policy
-- consent acceptance. Until now the single combined consent checkbox
-- (RgpdConsentScreen, App.jsx) was recorded ONLY in the browser's
-- localStorage (RGPD_STORAGE_KEY) — per-device, user-clearable, and not
-- independently verifiable, so it would not hold up as proof of consent
-- in an actual dispute. See docs/superpowers/specs/
-- 2026-07-29-legal-consent-server-record-design.md for the full design,
-- including why the write happens at next login rather than at the
-- checkbox click itself (no authenticated session exists at that exact
-- moment — the screen is shown before login, gating even LoginScreen).
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE) — run after 0060.

create table if not exists public.legal_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notice_version text not null,
  accepted_at timestamptz not null default now(),
  unique (user_id, notice_version)
);

alter table public.legal_consents enable row level security;

drop policy if exists "users read own consents" on public.legal_consents;
create policy "users read own consents"
  on public.legal_consents for select
  using (auth.uid() = user_id);

-- Pas de policy INSERT côté client : l'écriture passe uniquement par la
-- RPC SECURITY DEFINER ci-dessous (même convention que
-- remove_family_member / accept_family_invitation).

create or replace function public.record_legal_consent(p_notice_version text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'not_authenticated'; end if;

  insert into public.legal_consents (user_id, notice_version)
  values (v_caller, p_notice_version)
  on conflict (user_id, notice_version) do nothing;
end;
$$;

revoke all on function public.record_legal_consent(text) from public;
grant execute on function public.record_legal_consent(text) to authenticated;
