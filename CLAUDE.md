# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Duvia — French co-parenting app ("Two homes. One family."): shared custody calendar, expenses, messaging, document vault, schedule, notifications, and a premium/referral system. React + Vite frontend, Supabase backend (Postgres, Auth, Realtime, Storage, Edge Functions), deployed on Vercel (auto-deploy from GitHub, build command `npm run build`, output `dist`).

## Commands

- `npm install` / `npm run dev` / `npm run build` / `npm run preview`
- Tests: `TZ=Europe/Paris npm test` (runs `node --test "src/**/*.test.js"`) — the `Europe/Paris` timezone is required, one regression test depends on it.
- Single test file: `TZ=Europe/Paris node --test src/utils/core.test.js`
- No lint script is configured in this repo.

### Environment variables (`.env`, not committed)
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (required — `src/supabaseClient.js` logs an error and the app can't reach the backend without them). `VITE_POSTHOG_KEY` is optional (PostHog EU analytics only initializes if set; `autocapture` is deliberately off).

## Architecture

### The `families.data` blob → dedicated tables migration (in progress)

Historically the whole app config (`cfg`: parents, children, custody model, special dates...) lived in `localStorage` and then as one JSONB blob in `families.data`. That migration to Supabase is **partway done, domain by domain**: some slices (messages, expenses, history, vault, custody identity links) have been extracted into their own RLS-protected tables and are accessed through a consistent three-layer pattern:

- `src/services/supabase/*Service.ts` — raw Supabase queries/mutations for one domain (e.g. `messageService.ts`, `expenseService.ts`).
- `src/hooks/use*.ts` (`useMessages`, `useExpenses`, `useHistory`, `useVault`, `useCustody`, `useIdLinks`) — wraps the service + a Realtime `postgres_changes` subscription, exposing state shaped to be a near drop-in replacement for the old `useLocalStorage("duvia_xxx", ...)` calls so `App.jsx` components need minimal changes.
- `src/App.jsx` — still holds the config/onboarding flow and most UI as large tab components, but now imports the hooks above instead of managing that state itself.

When adding a new persisted feature, follow this same service → hook → component pattern rather than writing Supabase calls directly in `App.jsx`. Check `BUGFIXES.md` before touching family/invite/auth logic — it's the running changelog of non-obvious bugs already fixed in this area (invite acceptance, password reset, message de-duplication, RGPD consent, email-locking rules) and lists what's intentionally left unfixed and why.

### Supabase specifics

- Migrations live in `supabase/migrations/*.sql`, numbered and idempotent — run them **in order** in the Supabase SQL editor before deploying the app code that depends on them (each migration file's header comment says what it depends on).
- Server-authoritative RPCs (`SECURITY DEFINER`) drive sensitive family/invite transitions instead of trusting client writes: `set_member_identity`, `peek_invitation`, `accept_family_invitation`, `find_family_by_share_code`.
- Edge Functions: `supabase/functions/delete-account`, `supabase/functions/notify-expense`.
- Auth session storage is "smart" (`src/supabaseClient.js`): persists to `localStorage` only if the user checked "remember me" (`duvia_remember`), otherwise `sessionStorage` — deliberate, since devices are often shared between co-parents.
- Anonymous Supabase accounts are used as a per-device "invisible badge" for family sync before a user has a real account (see the "SYNCHRONISATION FAMILLE" section of `App.jsx`).

### Other modules

- `src/i18n/{fr,en,de,es,pt}.js`, aggregated in `src/i18n/index.js` as `TR`. French is the reference language; other languages are incomplete by design — the code falls back with `t.key || "..."` where a translation is missing, so don't assume every key exists in every language.
- `src/theme.js` — base `DARK`/`LIGHT` themes plus seasonal/event themes (`SUMMER`, `RG`, `WC`, `VIDEO`) that are date-gated (`isSummerPeriod()`, etc.) and layered over the base mode.
- `src/config.js` — global constants: `LIMITS` (validation caps), `RGPD_NOTICE_VERSION` (bump this to force re-consent — it's compared against the timestamped record in `duvia_rgpd_consent`). Legal docs (CGU/CGV/privacy) are no longer external URLs here — they're shown in-app via `LegalDocModal` in `App.jsx`, sourced from `docs/legal/*.md`.
- `src/utils/core.js` — pure, unit-tested helper functions (validation, date rules, message dedup, parent-slot reconciliation). New pure logic should go here, covered by a test in `core.test.js`, rather than inline in `App.jsx` — this is the repo's explicit direction for gradually shrinking `App.jsx`.
- RGPD consent age threshold is now per-country (`RGPD_CONSENT_AGE_BY_COUNTRY` in `App.jsx`, EU baseline 16, e.g. FR 15/DE 16/ES 14/PT 13), carried through child-invite links via a `ccountry` param — values sourced from public GDPR documentation, not legally verified, flagged in-code accordingly.
- CGU/CGV/Politique de Confidentialité are drafted (`docs/legal/*.md`) and shown in-app via `LegalDocModal` — still working drafts (bracketed placeholders for company legal name/SIRET/address/pricing) needing a lawyer's sign-off before the beta-status disclaimer can be removed.

### Not yet done
There's a known duplicate-Supabase-client concern flagged for follow-up, not yet investigated. Bad-word filter's naive substring matching was fixed for common French/English/German/Spanish/Portuguese false positives, but "pedale"/"pedales" (French bicycle pedal vs. homophobic slur, identical word) was deliberately left as-is pending a product decision. "Passwords not hashed client-side" was re-evaluated and is **not** a real gap (standard practice — Supabase Auth hashes server-side). `expire_stale_family_data()` is now scheduled via `pg_cron` (daily, see migration history / Supabase dashboard cron jobs — not committed as a migration file in this repo).

## Related files outside this repo
`~/Desktop/Logique d'invitation.xlsx` — the manual test matrix for the family invitation flow (create/invite/accept/leave/remove/re-invite, including cross-email-acceptance edge cases). Two other local folders (`C:\Users\aramo\duvia-app` and the OneDrive `Duvia\99 - DUVIA-APP\duvia-app`) contain stale, non-git copies of an earlier version of this app — they are not this project and should be ignored.
