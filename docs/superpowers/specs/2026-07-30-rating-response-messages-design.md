# Star-rating response messages — design

**Date:** 2026-07-30
**Status:** approved, ready for implementation plan

## Problem

Backlog item 11 ("star-rating response messages") asked for richer feedback
after a user rates the app in `RatingTab` (`src/App.jsx`). Today there are
only two messages, both a binary split on `selected >= 4`:

- A **live preview** shown under the star selector, before submission
  (`message` at `src/App.jsx:13598`, rendered at `:13700`): `ratingMsgHigh`
  ("Merci beaucoup ! 😍") or `ratingMsgLow` ("Merci 🙏 Dites-nous comment
  améliorer").
- A **static post-submit thank-you screen** (`submitted` block,
  `src/App.jsx:13633-13640`) that shows the same generic `t.ratingThanks`
  ("Merci pour votre retour !") regardless of the star count, with no call
  to action.

## Decisions

1. **Five distinct messages, not two.** Both the live preview and the
   post-submit screen move from a `>=4` binary split to one message per
   star count (1 through 5).
2. **The live preview stays lightweight — text only, no CTA.** It's shown
   while the user is still mid-selection, before they've committed
   anything; a call-to-action button there would be premature and clutter
   a small, transient UI element.
3. **The post-submit thank-you screen gets the richer message + a CTA**,
   since that's after the action is complete — the natural moment to offer
   a next step:
   - **1-2★:** an understanding/apologetic message + a "Nous contacter"
     button (`mailto:duvia.services@gmail.com` — the same admin address
     already used in `supabase/functions/notify-rating/index.ts`). No new
     plumbing: a plain `mailto:` link, not the in-app bug-report modal
     (that would require lifting `setShowBugModal` state into `RatingTab`,
     out of proportion for this feature).
   - **3★:** neutral, encourages elaborating in the comment field (which
     already exists just below). No CTA.
   - **4★:** happy, lightly asks what's missing for a 5th star. No hard
     CTA.
   - **5★:** enthusiastic + a "Partager Duvia" button reusing the existing
     referral system already available via `useApp()`'s `sub`/`user`
     (`sub.refCode || user?.refCode`, `${APP_URL}?ref=${code}` — same
     pattern as the referral tab's `shareViaEmail`/`copyLink`, `src/App.jsx`
     ~16262-16292). No app-store review prompt — the app isn't published
     yet (backlog Tier 5 item 25), so that CTA would go nowhere; revisit
     once actually published.
4. **No schema change, no new admin view.** This is purely richer
   client-side copy + two `mailto:`/share buttons — `ratings` table,
   `notify-rating`, and the admin email notification are untouched.

## Data flow

No new data. `selected` (1-5, already in state) drives:
- `src/utils/core.js`: a new pure lookup function,
  `ratingLiveHintFor(stars)` → one of 5 short strings (i18n keys), used by
  the live preview.
- Inline in the `submitted` render block: a second lookup,
  `ratingThankYouFor(stars)` → `{ text, ctaLabel, ctaAction }` where
  `ctaAction` is `"contact"` (1-2), `"share"` (5), or `null` (3-4).

Both lookups are pure functions of an integer 1-5 — straightforward to
unit-test in `core.test.js`, matching this repo's convention of pure logic
living in `core.js` rather than inline in `App.jsx`.

## i18n

Ten new translation keys (5 live-hint + 5 thank-you texts) plus two CTA
label keys (`ratingCtaContact`, `ratingCtaShare`), added to `fr.js` as the
reference language; other 4 languages get best-effort translations
(incomplete-by-design fallback already covers any gap, per this project's
i18n convention).

## Testing

- `isFirstOccurrenceOfRecurringExpense`-style pure functions
  (`ratingLiveHintFor`, `ratingThankYouFor`) get unit tests in
  `core.test.js` — deterministic, no network/DB involved.
- No live browser verification is strictly required for correctness (pure
  string lookups + two `mailto:`/existing-share-pattern buttons), but per
  this project's UI standing rule, a quick manual check in the running app
  (all 5 star counts, confirm the right text + CTA shows, confirm both
  buttons open the right thing) happens before calling this done.

## Out of scope

- Any admin-facing view of ratings or personalized admin replies (a
  different, larger feature — not what "richer automatic message" means
  here, confirmed with the user during brainstorming).
- An app-store review CTA for 5★ (deferred until the app is actually
  published).
