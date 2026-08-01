# Instagram Publishing Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an on-demand local Node script (`scripts/post-instagram.mjs`) that publishes a single-image post to Instagram (`@duvia_2homes_1family`) via the Instagram Graph API, using a temporary Supabase Storage upload to satisfy the API's public-image-URL requirement.

**Architecture:** A private Supabase Storage bucket (`social-posts`) holds the image just long enough for Meta's servers to fetch it via a short-lived signed URL. The script itself is a single ESM file with no new npm dependencies: `@supabase/supabase-js` (already a project dependency) for the upload, and plain `fetch()` for the three Graph API calls (create container → poll status → publish). See `docs/superpowers/specs/2026-08-01-instagram-publishing-script-design.md` for the full design rationale.

**Tech Stack:** Node 24 (`--env-file` flag, native, no `dotenv`), `@supabase/supabase-js`, Instagram Graph API v21.0.

## Global Constraints

- No new npm dependencies — use `@supabase/supabase-js` (already present) and Node built-ins only.
- Run via `node --env-file=.env scripts/post-instagram.mjs ...` — requires Node ≥ 20.6 (repo has v24.18.0).
- Graph API version pinned to `v21.0` everywhere it's called.
- Image input restricted to `.jpg`/`.jpeg` only — the only format the Graph API officially guarantees for photo posts.
- Signed URL expiry: 600 seconds. Status polling: 2000ms interval, 10 max attempts before giving up.
- `social-posts` Storage bucket is **private**, no RLS policies (service role only), 10MB file size limit, `image/jpeg` only.
- No automated test suite for this script — it's pure I/O (filesystem, network, third-party API), consistent with this repo's Edge Functions also having no automated tests. Verification is manual: `--dry-run` first, then one real post.
- This work touches `scripts/`, `supabase/migrations/`, and `docs/` only — never `src/` or `public/sw.js` — so **no `APP_VERSION`/`SW_VERSION` bump is needed** for any task in this plan.
- Before running the migration against a live Supabase project, or running the script against real credentials (dry-run or real post), **confirm with the user which Supabase project (staging vs prod) to use** — never assume.
- Never commit real credentials — `IG_ACCESS_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, and `IG_BUSINESS_ACCOUNT_ID` live only in the gitignored local `.env`, never in a migration, README, commit message, or this plan.

---

### Task 1: Storage bucket migration

**Files:**
- Create: `supabase/migrations/0064_social_posts_bucket.sql`

**Interfaces:**
- Produces: a Storage bucket named `social-posts` that Task 3's `uploadImage()` writes to.

- [ ] **Step 1: Write the migration file**

```sql
-- 0064_social_posts_bucket.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Bucket Supabase Storage temporaire pour le script de publication Instagram
-- (scripts/post-instagram.mjs).
--
-- Bucket PRIVÉ. Pas de policy RLS : seule la service role key y accède (le
-- script tourne en local avec cette clé, qui bypass RLS de toute façon), donc
-- des policies pour les rôles anon/authenticated seraient du code mort.
-- Convention de chemin : posts/{timestamp}-{filename}
-- Les fichiers sont temporaires : le script les supprime après chaque
-- publication (réussie ou non) via une URL signée à courte durée de vie.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'social-posts',
  'social-posts',
  false,
  10485760,       -- 10 Mo max
  ARRAY['image/jpeg']
)
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Confirm environment with the user**

Ask the user explicitly which Supabase project (staging vs prod) this migration should be applied to. Do not assume — this is a standing project convention. Wait for their answer.

- [ ] **Step 3: Apply the migration**

In that project's Supabase Dashboard → SQL Editor, paste the full contents of `0064_social_posts_bucket.sql` and run it.

- [ ] **Step 4: Verify the bucket exists**

In Supabase Dashboard → Storage, confirm a bucket named `social-posts` is listed and marked **Private**.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0064_social_posts_bucket.sql
git commit -m "Add private Storage bucket for the Instagram publishing script"
```

---

### Task 2: Script skeleton — CLI args, env validation, image validation

**Files:**
- Create: `scripts/post-instagram.mjs`

**Interfaces:**
- Produces:
  - `parseArgs(argv: string[]): { image: string, caption: string, dryRun: boolean }` — throws `Error` with a human-readable message on invalid/missing args.
  - `validateEnv(env: object): { supabaseUrl: string, serviceRoleKey: string, igBusinessAccountId: string, igAccessToken: string }` — throws `Error` listing missing var names.
  - `validateImage(path: string): void` — throws `Error` if the path doesn't exist, isn't a file, or isn't `.jpg`/`.jpeg`.

- [ ] **Step 1: Create the file with initial content**

```javascript
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const SIGNED_URL_EXPIRY_SECONDS = 600;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 10;
const BUCKET = "social-posts";

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--image") args.image = argv[++i];
    else if (arg === "--caption") args.caption = argv[++i];
    else if (arg === "--caption-file") args.captionFile = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.image) throw new Error("Missing required argument: --image <path>");
  if (!args.caption && !args.captionFile) {
    throw new Error("Missing required argument: --caption <text> or --caption-file <path>");
  }
  if (args.caption && args.captionFile) {
    throw new Error("Pass either --caption or --caption-file, not both");
  }
  if (args.captionFile) {
    args.caption = readFileSync(args.captionFile, "utf8").trim();
  }
  return args;
}

function validateEnv(env) {
  const required = [
    "VITE_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "IG_BUSINESS_ACCOUNT_ID",
    "IG_ACCESS_TOKEN",
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
  return {
    supabaseUrl: env.VITE_SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    igBusinessAccountId: env.IG_BUSINESS_ACCOUNT_ID,
    igAccessToken: env.IG_ACCESS_TOKEN,
  };
}

function validateImage(path) {
  const ext = extname(path).toLowerCase();
  if (ext !== ".jpg" && ext !== ".jpeg") {
    throw new Error(`Image must be a .jpg/.jpeg file (Instagram Graph API requirement), got: ${path}`);
  }
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`Image file not found: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Image path is not a file: ${path}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = validateEnv(process.env);
  validateImage(args.image);
  console.log("Inputs OK:", { image: args.image, dryRun: args.dryRun, hasIgBusinessAccountId: !!env.igBusinessAccountId });
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Verify missing-argument handling**

Run: `node scripts/post-instagram.mjs`
Expected output: `Error: Missing required argument: --image <path>`, and the process exits with a non-zero code.

- [ ] **Step 3: Verify missing-env handling**

Run: `node scripts/post-instagram.mjs --image nope.jpg --caption "x"` (with none of the four required env vars set in the shell)
Expected output: `Error: Missing required environment variable(s): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IG_BUSINESS_ACCOUNT_ID, IG_ACCESS_TOKEN`

- [ ] **Step 4: Verify image validation**

Create a throwaway empty file to test against (any convenient scratch path, e.g. `test.png`), then run:
`VITE_SUPABASE_URL=x SUPABASE_SERVICE_ROLE_KEY=x IG_BUSINESS_ACCOUNT_ID=x IG_ACCESS_TOKEN=x node scripts/post-instagram.mjs --image test.png --caption "x"`
Expected output: `Error: Image must be a .jpg/.jpeg file (Instagram Graph API requirement), got: test.png`

Then run the same command with `--image does-not-exist.jpg` instead.
Expected output: `Error: Image file not found: does-not-exist.jpg`

Delete the throwaway `test.png` afterward.

- [ ] **Step 5: Commit**

```bash
git add scripts/post-instagram.mjs
git commit -m "Add CLI arg/env/image validation for the Instagram publishing script"
```

---

### Task 3: Supabase upload, signed URL, and cleanup

**Files:**
- Modify: `scripts/post-instagram.mjs`

**Interfaces:**
- Consumes: `validateEnv()`'s return shape from Task 2 (`supabaseUrl`, `serviceRoleKey` fields).
- Produces:
  - `uploadImage(supabase, imagePath: string): Promise<string>` — returns the uploaded object's storage path (e.g. `posts/1735689600000-photo.jpg`).
  - `getSignedUrl(supabase, storagePath: string): Promise<string>` — returns a fetchable signed URL.
  - `cleanupImage(supabase, storagePath: string): Promise<void>` — best-effort delete, logs a warning on failure instead of throwing (so cleanup failures never mask the real error from earlier in the flow).

- [ ] **Step 1: Add the import and the three functions**

Add near the top of `scripts/post-instagram.mjs`, right after the `node:fs` import:

```javascript
import { createClient } from "@supabase/supabase-js";
```

Change the existing `node:path` import line (from Task 2) from:

```javascript
import { extname } from "node:path";
```

to:

```javascript
import { basename, extname } from "node:path";
```

Add these functions after `validateImage`, before `main`:

```javascript
async function uploadImage(supabase, imagePath) {
  const fileBuffer = readFileSync(imagePath);
  const storagePath = `posts/${Date.now()}-${basename(imagePath)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, fileBuffer, {
    contentType: "image/jpeg",
    upsert: false,
  });
  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }
  return storagePath;
}

async function getSignedUrl(supabase, storagePath) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);
  if (error) {
    throw new Error(`Failed to create signed URL: ${error.message}`);
  }
  return data.signedUrl;
}

async function cleanupImage(supabase, storagePath) {
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) {
    console.error(`Warning: failed to clean up temp file ${storagePath}: ${error.message}`);
  }
}
```

- [ ] **Step 2: Wire these into `main()`**

Replace the existing `main()` function with:

```javascript
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = validateEnv(process.env);
  validateImage(args.image);

  const supabase = createClient(env.supabaseUrl, env.serviceRoleKey);

  const storagePath = await uploadImage(supabase, args.image);
  try {
    const imageUrl = await getSignedUrl(supabase, storagePath);
    console.log("Uploaded and signed:", imageUrl);
  } finally {
    await cleanupImage(supabase, storagePath);
  }
}
```

(The signed URL is only logged for now — Task 4 replaces this body with the real Graph API flow.)

- [ ] **Step 3: Confirm environment with the user**

Ask which Supabase project (staging vs prod) to test against — reuse the answer from Task 1 if it was given in this same session, otherwise ask again. Do not assume.

- [ ] **Step 4: Run a real upload/cleanup check**

With `.env` populated with real `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the confirmed project, run:
`node --env-file=.env scripts/post-instagram.mjs --image <any small real .jpg> --caption "test"`
(the other two env vars can still be dummy values at this point, e.g. `IG_BUSINESS_ACCOUNT_ID=x IG_ACCESS_TOKEN=x` — they're required by `validateEnv` but unused until Task 4).

Expected: a signed URL is logged. In Supabase Dashboard → Storage → `social-posts`, confirm the file is gone after the script finishes (cleanup worked).

- [ ] **Step 5: Commit**

```bash
git add scripts/post-instagram.mjs
git commit -m "Add Supabase upload/signed-URL/cleanup to the Instagram publishing script"
```

---

### Task 4: Graph API integration and full publish flow

**Files:**
- Modify: `scripts/post-instagram.mjs`

**Interfaces:**
- Consumes: `validateEnv()`'s `igBusinessAccountId`/`igAccessToken` fields; `uploadImage`/`getSignedUrl`/`cleanupImage` from Task 3.
- Produces:
  - `createContainer(env, imageUrl: string, caption: string): Promise<string>` — returns `creation_id`.
  - `pollUntilFinished(env, creationId: string): Promise<void>` — resolves once `status_code === "FINISHED"`, throws on `ERROR` or timeout.
  - `publishContainer(env, creationId: string): Promise<string>` — returns published media id.
  - `getPermalink(env, mediaId: string): Promise<string>` — returns the post's public URL.
  - Final `main()` — full end-to-end orchestration, including `--dry-run` short-circuit.

- [ ] **Step 1: Add the Graph API helpers**

Add after the `cleanupImage` function, before `main`:

```javascript
async function graphApiRequest(method, path, params) {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { method });
  const body = await response.json();
  if (body.error) {
    const subcode = body.error.error_subcode ? `, subcode ${body.error.error_subcode}` : "";
    throw new Error(`Graph API error: ${body.error.message} (code ${body.error.code}${subcode})`);
  }
  return body;
}

async function createContainer(env, imageUrl, caption) {
  const body = await graphApiRequest("POST", `/${env.igBusinessAccountId}/media`, {
    image_url: imageUrl,
    caption,
    access_token: env.igAccessToken,
  });
  return body.id;
}

async function pollUntilFinished(env, creationId) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const body = await graphApiRequest("GET", `/${creationId}`, {
      fields: "status_code",
      access_token: env.igAccessToken,
    });
    if (body.status_code === "FINISHED") return;
    if (body.status_code === "ERROR") {
      throw new Error(`Container processing failed (status: ERROR) for creation_id ${creationId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Container ${creationId} did not finish processing after ${POLL_MAX_ATTEMPTS} attempts`);
}

async function publishContainer(env, creationId) {
  const body = await graphApiRequest("POST", `/${env.igBusinessAccountId}/media_publish`, {
    creation_id: creationId,
    access_token: env.igAccessToken,
  });
  return body.id;
}

async function getPermalink(env, mediaId) {
  const body = await graphApiRequest("GET", `/${mediaId}`, {
    fields: "permalink",
    access_token: env.igAccessToken,
  });
  return body.permalink;
}
```

- [ ] **Step 2: Replace `main()` with the final version**

```javascript
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = validateEnv(process.env);
  validateImage(args.image);

  const supabase = createClient(env.supabaseUrl, env.serviceRoleKey);

  const storagePath = await uploadImage(supabase, args.image);
  try {
    const imageUrl = await getSignedUrl(supabase, storagePath);
    const creationId = await createContainer(env, imageUrl, args.caption);
    await pollUntilFinished(env, creationId);

    if (args.dryRun) {
      console.log(`Dry run OK — container ${creationId} is ready to publish. Re-run without --dry-run to publish.`);
      return;
    }

    const mediaId = await publishContainer(env, creationId);
    const permalink = await getPermalink(env, mediaId);
    console.log(`Published: ${permalink} (media id: ${mediaId})`);
  } finally {
    await cleanupImage(supabase, storagePath);
  }
}
```

- [ ] **Step 3: Confirm Meta setup is complete**

Ask the user to confirm `IG_BUSINESS_ACCOUNT_ID` and `IG_ACCESS_TOKEN` are already set in their local `.env` with real values (System User token from Meta Business Suite). If not done yet, pause here and point them to `scripts/README-instagram.md` (Task 5) before continuing — don't attempt a dry run with placeholder credentials, the Graph API call will just fail with an auth error.

- [ ] **Step 4: Run a real dry run**

`node --env-file=.env scripts/post-instagram.mjs --image <real small .jpg> --caption "Test dry-run" --dry-run`
Expected output: `Dry run OK — container <id> is ready to publish. Re-run without --dry-run to publish.`
Also confirm in Supabase Dashboard → Storage → `social-posts` that the temp file is gone afterward.

- [ ] **Step 5: Commit**

```bash
git add scripts/post-instagram.mjs
git commit -m "Add Graph API publish flow and --dry-run to the Instagram publishing script"
```

---

### Task 5: Setup documentation

**Files:**
- Create: `scripts/README-instagram.md`

**Interfaces:** None — documentation only, no code.

- [ ] **Step 1: Write the README**

```markdown
# Publier sur Instagram — `post-instagram.mjs`

Script à la demande pour publier un post image simple sur le compte
@duvia_2homes_1family via l'API Instagram Graph. Pas de planification, pas
d'automatisation — tu le lances quand un post est prêt.

## Configuration (une seule fois)

1. **Créer une app Meta for Developers** sur https://developers.facebook.com/apps
   (type "Business").
2. Dans **Meta Business Suite** → Paramètres de l'entreprise → Utilisateurs →
   **Utilisateurs système**, créer un System User, l'assigner à la Page Facebook
   liée au compte Instagram, avec les permissions `instagram_basic` et
   `instagram_content_publish`.
3. Générer un token pour ce System User (durée "Ne jamais expirer"). Contrairement
   à un token utilisateur classique (60 jours), un token de System User ne se
   régénère pas périodiquement.
4. Récupérer l'ID du compte Instagram Business :
   `GET https://graph.facebook.com/v21.0/{page-id}?fields=instagram_business_account&access_token={token}`
   (via l'onglet Graph API Explorer de Meta for Developers, ou `curl`).

## Variables d'environnement

Ajouter à `.env` (déjà gitignored) :

\`\`\`
SUPABASE_SERVICE_ROLE_KEY=...   # Supabase → Project Settings → API → service_role
IG_BUSINESS_ACCOUNT_ID=...      # récupéré à l'étape 4 ci-dessus
IG_ACCESS_TOKEN=...             # token System User de l'étape 3
\`\`\`

(`VITE_SUPABASE_URL`, déjà présent dans `.env`, est réutilisé.)

## Usage

\`\`\`bash
# Test à blanc (upload + création du container, sans publier)
node --env-file=.env scripts/post-instagram.mjs --image photo.jpg --caption "Texte du post" --dry-run

# Publication réelle
node --env-file=.env scripts/post-instagram.mjs --image photo.jpg --caption "Texte du post"

# Légende longue depuis un fichier
node --env-file=.env scripts/post-instagram.mjs --image photo.jpg --caption-file legende.txt
\`\`\`

L'image doit être un `.jpg`/`.jpeg` (seul format garanti par l'API Graph pour les
posts image).
```

- [ ] **Step 2: Commit**

```bash
git add scripts/README-instagram.md
git commit -m "Add setup/usage README for the Instagram publishing script"
```

---

### Task 6: End-to-end verification with a real post

**Files:** None (verification only, no code changes).

**Interfaces:** None.

- [ ] **Step 1: Confirm readiness with the user**

This step publishes a real, visible post to the live @duvia_2homes_1family account — confirm explicitly with the user before running it for real (this is exactly the kind of hard-to-reverse, externally-visible action that needs a check-in first, not an assumption).

- [ ] **Step 2: Run a real publish**

`node --env-file=.env scripts/post-instagram.mjs --image <real image> --caption "<real caption>"`

- [ ] **Step 3: Verify the result**

Confirm the printed permalink opens the real post on Instagram, and confirm in Supabase Dashboard → Storage → `social-posts` that the temp file was cleaned up.

- [ ] **Step 4: Done**

No commit needed (no code changed in this task). Mark the plan complete.
