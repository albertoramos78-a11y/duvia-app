# Beta signup popup — design

**Date:** 2026-08-01
**Status:** Approved by user, ready for implementation.

## Goal

Tell new users, right when they start creating an account, that Duvia is currently in a free beta and Trial Premium is offered to everyone for its whole duration — via a real modal popup, distinct from the existing inline note already shown lower in the same form.

## Context

- `isBeta()` (`App.jsx:464`) reads a module-level cache filled from `app_config` (`beta_enabled` bool, `beta_end` timestamptz). A migration (0063) was added earlier the same session so this can be read pre-authentication (anon RLS policy) — required for this popup to work, since it renders before any account exists.
- An inline text note already exists in the registration form (`App.jsx` ~line 7405, `mode==="register" && isBeta()`), just above the "Créer mon compte" button: *"🎉 Pendant la bêta, toutes les fonctionnalités Premium sont offertes gratuitement, sans carte bancaire. L'abonnement (quand il sera proposé) s'achètera directement dans l'application."* — **this stays as-is**, the popup is additive, not a replacement.
- Two related, larger features (end-of-beta transition notice, freemium-login nag) were explicitly deferred by the user to the backlog (Tier 5, item 22b) — out of scope here.

## Behavior

- **Trigger:** the popup opens automatically the first time the user clicks the "Créer un compte" tab, only if `isBeta()` is true at that moment.
- **Once per device:** on open, a localStorage flag (`duvia_beta_signup_popup_seen`) is set. If already set, the popup never opens again on that device — regardless of tab switches, page reloads, or the beta ending later. No per-account tracking (this fires pre-authentication, there's no account yet).
- **Dismiss:** a single "Compris" button closes it. No other action, no link to the Premium tab (per explicit user request — this is informational only, not a funnel).
- **Not shown when `isBeta()` is false:** no popup, no flag written (so if beta later gets re-enabled between two sessions, first-time visitors during the re-enabled window still see it once).

## Content (French, reference language; translated to EN/DE/ES/PT per project convention)

- Title: "🎉 Bêta — Trial Premium offert"
- Body: "Duvia est actuellement en phase bêta : profite de toutes les fonctionnalités Premium gratuitement, sans carte bancaire, tant que dure la bêta."
- Button: "Compris"

## Implementation notes

- New `useState` (e.g. `showBetaSignupPopup`) + effect/handler tied to the existing register-tab-switch interaction, guarded by `isBeta()` and the localStorage flag.
- Visual style: centered card modal with backdrop blur, matching the existing modal pattern already used elsewhere in this file (e.g. the PDF export modals) — not a full-screen blocking gate like `ConsentScreen`/`RgpdConsentScreen`, since it's purely informational and dismissible.
- 3 new i18n keys (title/body/button) across all 5 languages, no schema/DB changes beyond the already-applied migration 0063.

## Testing

- No pure-function logic to unit-test (this is UI-only, gated by a boolean read from module state + a localStorage flag).
- Verify live on staging: fresh device (cleared localStorage) → switch to "Créer un compte" → popup appears once → dismiss → switch away and back → popup does not reappear → confirm the existing inline note still renders separately, unaffected.
- Per this project's standing rule, build+tests passing is not sufficient proof for a JSX change — live browser verification is required before shipping.
