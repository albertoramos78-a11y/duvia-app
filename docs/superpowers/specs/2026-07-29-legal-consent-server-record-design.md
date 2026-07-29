# Legal consent server-side record — design

**Date:** 2026-07-29
**Status:** approved, ready for implementation plan

## Problem

The single combined consent checkbox ("J'ai lu et j'accepte la politique de
confidentialité et les conditions d'utilisation de Duvia") is currently
recorded **only in `window.localStorage`** (`RGPD_STORAGE_KEY`, compared
against `RGPD_NOTICE_VERSION` from `config.js` via `isRgpdConsentValid` /
`makeRgpdConsentRecord` in `src/utils/core.js`). Nothing is written to
Supabase. localStorage is per-device and user-clearable, so it would not
hold up as independently-verifiable proof of consent in an actual dispute.
Flagged by the user 2026-07-28; greenlit to build 2026-07-29.

## Key architectural fact (discovered during brainstorming)

The consent checkbox lives on `RgpdConsentScreen` (`App.jsx` ~6178), which is
gated **before login** — it blocks reaching `LoginScreen` at all, once per
device, re-asked only when `RGPD_NOTICE_VERSION` changes. At the exact
moment the checkbox is accepted, **there is no authenticated Supabase
session yet**, so there is no `user_id` to write a server row against.

(This is distinct from `ConsentScreen`, the "charte d'engagement" shown
*after* a successful login/registration, about parental authority and
appropriate use — a different consent, out of scope here.)

## Decisions

1. **Attach server-side at next login, not at the checkbox click.** The
   `RgpdConsentScreen` UX doesn't change. The moment a real authenticated
   session exists (fresh registration, fresh login, or simply an existing
   session resuming on page load) and the device already holds a valid
   local consent record for the current version, the client writes a
   server row for that user — silently, no new screen. This is naturally
   retroactive: existing users who accepted before this feature shipped
   get backfilled the next time they log in, with no separate migration
   step needed.
2. **Store version only, not a text snapshot.** The record is
   `user_id + notice_version + accepted_at`, mirroring the existing
   `RGPD_NOTICE_VERSION` scheme. The CGU/CGV/privacy docs are still
   lawyer-unapproved drafts (see `CLAUDE.md`); freezing a text snapshot as
   "the accepted proof" is premature. Revisit once the legal text is
   finalized.
3. **Confirmation email only on a genuinely fresh acceptance in the current
   session** — not on the silent retroactive backfill of an existing
   user's already-accepted consent. Sending an unprompted legal email to a
   long-time user during an ordinary login (no visible action on their
   part) would be confusing and could read as phishing. Skip entirely for
   accounts with no real email (phone-registered accounts use a
   `@phone.duvia.app` placeholder — same guard already used in
   `notify-password-change`).

## Data model

New migration `0061_legal_consents.sql`:

```sql
create table public.legal_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notice_version text not null,
  accepted_at timestamptz not null default now(),
  unique (user_id, notice_version)
);

alter table public.legal_consents enable row level security;

create policy "users read own consents"
  on public.legal_consents for select
  using (auth.uid() = user_id);
```

No client-side INSERT policy — writes only go through the RPC below,
matching the project's `SECURITY DEFINER` convention for sensitive writes
(`remove_family_member`, `accept_family_invitation`, etc.).

```sql
create function public.record_legal_consent(p_notice_version text)
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
```

The `on conflict do nothing` makes the RPC naturally idempotent — safe to
call on every login without tracking any "already synced" state
client-side.

## Client changes

**No new hook.** This feature has no state to expose to any component (no
list, no realtime subscription, nothing to render) — it's a one-shot
side effect. Per `CLAUDE.md`'s service → hook → component guidance, the
hook layer exists to shape state for components; skipping it here is a
deliberate fit to what this feature actually needs, not a shortcut.

- `src/services/supabase/legalConsentService.ts` — one function:
  `recordLegalConsent(noticeVersion: string): Promise<void>` wrapping
  `supabase.rpc('record_legal_consent', { p_notice_version: noticeVersion })`.
- `App.jsx`:
  - A lightweight in-memory flag, `justAcceptedRgpd` (React state, default
    `false`), set to `true` inside the existing `acceptRgpd()` — this is
    the only signal needed to distinguish "just clicked in this browser
    session" from "was already accepted in a previous session." It is
    *not* persisted; a page reload naturally resets it to `false`, which
    is exactly the desired behavior (no email on a resumed session).
  - A `useEffect` keyed on `user?.id` (guarded by a `useRef` so it fires
    once per successful sign-in, not on every re-render): when `user?.id`
    becomes truthy, call `recordLegalConsent(RGPD_NOTICE_VERSION)`
    (fire-and-forget, `.catch(()=>{})` — see Error handling below). If
    `justAcceptedRgpd` is true, additionally invoke
    `supabase.functions.invoke("notify-legal-consent", { body: { notice_version: RGPD_NOTICE_VERSION } })`
    the same fire-and-forget way `notify-password-change` is already
    called elsewhere in this file.
  - Placing this in one `useEffect` on `user?.id` (rather than in every
    individual login/registration success handler) covers every sign-in
    path — email, Google OAuth, phone, MFA-gated — from a single spot,
    so no path can be missed.

## Edge Function: `notify-legal-consent`

New function, structurally a near-copy of `notify-password-change`
(same JWT-verification pattern, same `RESEND_API_KEY`/Resend call, same
`@phone.duvia.app` guard, **French only** — no other `notify-*` function
localizes by `lang`, so this doesn't either):

- Verifies the caller's JWT, resolves `user`/`email`.
- Skips silently if no real email.
- Body: `{ notice_version: string }` (Edge Functions can't import
  `config.js`, so the client passes the version it already has —
  see the identical constraint already documented for `sw.js`).
- Email states what was accepted (notice version + date) and links back
  into the app using the existing `?legal=cgu` / `?legal=cgv` /
  `?legal=privacy` deep-link query param (`App.jsx` already opens
  `LegalDocModal` directly from these — built for the marketing site,
  reused here) so the user can re-read the exact in-app text.

## Error handling

- **RPC write failure** (network blip, etc.): swallowed
  (`.catch(()=>{})`), *not* silently lost forever — because the effect
  re-fires on every future login, a failed attempt self-heals the next
  time the user signs in. No retry/backoff logic needed.
- **Email send failure**: swallowed the same way as every other
  `notify-*` invocation in this codebase — non-blocking, no UI feedback.

## Testing / verification

- No new pure logic worth a `core.test.js` unit test — this is a
  network side effect, not a pure function.
- Verify via `supabase db push` / SQL editor: RPC inserts once, a second
  call with the same version is a no-op (`select count(*)` stays 1).
- Live-verify in the browser with a real test account (per this
  project's standing rule that build+tests aren't sufficient proof for
  behavior that isn't unit-tested): fresh signup → row appears + email
  received; existing account with pre-existing local consent → row
  appears on next login, **no** email.

## Out of scope / deferred

- Storing a full text snapshot or hash of the accepted CGU/CGV/privacy
  text (deferred until the legal docs are lawyer-finalized).
- Recording IP address (not essential for the core proof; can be added
  later if ever requested).
- Localizing the confirmation email by `lang` (no existing `notify-*`
  function does this).
