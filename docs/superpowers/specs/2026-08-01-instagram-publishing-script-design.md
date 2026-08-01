# Instagram publishing script — design

## Problem

Duvia has an Instagram account (`@duvia_2homes_1family`, Business/Creator, linked to a
Facebook Page via Meta Business Suite) but no way to publish to it other than the
Instagram app itself. The goal is a small on-demand tool: prepare an image + caption,
run one command, the post goes live via the official Instagram Graph API.

No developer app / access token exists yet for this — only the Business Suite
connection. Part of this work is one-time manual Meta-side setup, documented for
reuse.

## Scope (v1)

- Single-image feed posts only. No carousels, no Reels/video, no Stories.
- On-demand only: a human runs a command when a post is ready. No scheduling, no cron,
  no queue.
- Lives in `duvia-app` (not `duvia-site`), as a local Node script — not an Edge
  Function, not deployed anywhere. Low frequency, manual use doesn't justify a deploy
  step or moving credentials into Supabase secrets.

Carousels, Reels, and any scheduled/automated publishing are explicitly out of scope
and left for a future iteration if needed.

## Meta-side setup (one-time, manual, documented not automated)

1. Create a Meta for Developers app.
2. In Meta Business Suite, create a **System User** in Business Settings, assign it the
   Page linked to the Instagram account, and grant `instagram_basic` +
   `instagram_content_publish` permissions.
3. Generate a token for the System User. Unlike a regular user token (60-day expiry),
   a System User token can be set to never expire — required so the script doesn't
   need periodic re-auth.
4. Resolve the Instagram Business Account ID (via `GET /{page-id}?fields=instagram_business_account`
   using the token).

These steps are documented in `scripts/README-instagram.md`, not scripted — they're a
one-time account configuration done in Meta's UI/Graph API Explorer.

## Components

### `supabase/migrations/00XX_social_posts_bucket.sql`

New **private** Storage bucket `social-posts`. No RLS policies — only the service role
key touches this bucket (which bypasses RLS entirely), so policies would be dead code.
Mirrors the bucket-creation pattern of `0019_expense_attachments_bucket.sql` but
without the per-family policies, since this bucket has no per-family concept.

### `scripts/post-instagram.mjs`

Node ESM script, run as:

```
node --env-file=.env scripts/post-instagram.mjs --image path/to/photo.jpg --caption "texte" [--dry-run]
```

(`--caption-file path/to/caption.txt` as an alternative to `--caption` for longer text.)

Uses `--env-file` (native since Node 20.6, available in the installed Node 24) to load
`.env` — no new `dotenv` dependency. Uses `@supabase/supabase-js`, already a project
dependency, for the storage upload. All Graph API calls are plain `fetch()` — the API
surface is 3 REST calls, not worth a wrapper library.

**New env vars** (added to the existing gitignored `.env`):
- `SUPABASE_SERVICE_ROLE_KEY` — not currently used anywhere locally (today only
  Edge Functions use a service role key, as a Supabase-managed secret). This is a new
  precedent: a service role key living in the local `.env`. Acceptable here because
  `.env` is gitignored and this is a manual, low-frequency admin script — consistent
  with `.env` already holding other non-public credentials for local `npm run dev`.
- `IG_BUSINESS_ACCOUNT_ID`
- `IG_ACCESS_TOKEN`

Reuses the existing `VITE_SUPABASE_URL` for the project URL — not secret, no need to
duplicate it under a second name.

### Flow

1. **Validate inputs.** Args (`--image`, one of `--caption`/`--caption-file`) and env
   vars are all checked before any network/filesystem call beyond existence checks.
   Missing/invalid input fails immediately with a message naming exactly what's
   missing.
2. **Validate image.** File must exist and have a `.jpg`/`.jpeg` extension — the only
   format the Graph API officially guarantees for photo posts. Anything else is
   rejected with a clear message (convert first).
3. **Upload.** Service role client uploads to
   `social-posts/posts/{timestamp}-{filename}`.
4. **Sign.** Generate a signed URL, 10 minute expiry (Meta fetches it near-instantly
   during container creation; this margin is just safety, not a real constraint).
5. **Create container.** `POST /{ig-business-account-id}/media` with `image_url`,
   `caption`, `access_token` → `creation_id`.
6. **Poll status.** `GET /{creation_id}?fields=status_code` every ~2s, up to ~10
   attempts, until `FINISHED`. `ERROR` status or exhausting attempts aborts the run.
7. **Publish** (skipped in `--dry-run`). `POST /{ig-business-account-id}/media_publish`
   with `creation_id` → published media id.
8. **Report.** On success, print the media id and permalink (one extra
   `GET /{media-id}?fields=permalink` call). On `--dry-run`, print "would publish
   here" instead of calling `media_publish`.
9. **Cleanup.** Delete the temp file from `social-posts` in a `finally` block, so it's
   removed whether the run succeeded, failed after upload, or was a dry run.

### `--dry-run`

Runs the full flow (upload → container → poll) and stops right before the publish
call. Exists so credentials/bucket/account config can be validated without risking an
accidental real post — meant to be the first thing run after setup, and after any
future change to the script.

## Error handling

Every step fails fast and surfaces Meta's own error message verbatim (`error.message`
from the Graph API response) rather than a generic wrapper — Graph API errors (bad
token, ineligible account, rejected image, etc.) are already specific enough to act on
directly. No retries are attempted automatically; if a publish fails partway (container
created but not published), the user re-runs the command.

## Testing

No automated test suite. This script is pure I/O against external systems (filesystem,
network, third-party API) — outside the `node --test` pattern this repo uses for pure
logic in `src/utils/core.js` (and consistent with the repo's Edge Functions, which also
have no automated tests). Verification is a real `--dry-run` after initial setup,
followed by one real post to confirm the end-to-end path.

## Explicitly out of scope

- Carousels, Reels/video, Stories.
- Scheduling/automation (cron, queue, content calendar integration).
- Token refresh automation (System User tokens don't expire, so not needed).
- Retry logic beyond "re-run the command."
