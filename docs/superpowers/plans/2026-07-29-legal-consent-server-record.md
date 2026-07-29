# Legal Consent Server Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record CGU/CGV/privacy-policy consent acceptance server-side (not just in localStorage) so it's independently verifiable, and email the user a confirmation only when they just accepted it in the current session.

**Architecture:** A new `legal_consents` table + a `SECURITY DEFINER` RPC (`record_legal_consent`) that the client calls once a real authenticated session exists — not at the checkbox click itself, since that happens before login. The write is an idempotent upsert (`on conflict do nothing`), so calling it on every login is harmless and self-healing, and it retroactively backfills existing users the next time they sign in. A confirmation email (new Edge Function `notify-legal-consent`) fires only when the checkbox was just checked in the current browser session, tracked via a transient (non-persisted) React state flag.

**Tech Stack:** Supabase Postgres (migration + `plpgsql` RPC), Supabase Edge Functions (Deno + Resend), React (`App.jsx`), `src/services/supabase/*.ts`.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-07-29-legal-consent-server-record-design.md` — read it if anything below is ambiguous.
- **Version bump on every push that changes app code:** `src/config.js`'s `APP_VERSION` and `public/sw.js`'s `SW_VERSION` must both move together. Current value is `"3.83"` (an unrelated expense-filter dropdown fix consumed `"3.83"` mid-plan); this plan bumps to `"3.84"`.
- **Next free migration number is `0061`** (latest existing is `0060_ai_faq_cache_function_grants.sql`).
- **No client INSERT policy** on `legal_consents` — all writes go through the `record_legal_consent` RPC (`SECURITY DEFINER`), matching this project's convention for sensitive writes (see `supabase/migrations/0053_parent_removal_confirmation.sql`).
- **Transactional emails in this codebase are French-only** — no `notify-*` function takes a `lang` param; don't add one here either.
- **Edge Functions deploy via `npx supabase functions deploy <name> --use-api`** — never paste code into the Supabase dashboard (see `CLAUDE.md`).
- **Two Supabase projects, confusingly named:** production is ref `ifhriyvvqkwqgzmrjjxp` (dashboard name "DUVIA-RMS-DEV"); the project actually named "duvia-staging" is ref `xqborcugpzjzungwgepn` and has **no data, no deployed Edge Functions, and an unconfirmed `RESEND_API_KEY`** (see `reference-duvia-staging-environment` — schema-only clone). This repo is currently linked to **prod** (`ifhriyvvqkwqgzmrjjxp`, confirmed via `supabase/.temp/project-ref`).
- **Always ask the user which environment** before running `supabase db push`, `supabase link`, or `supabase functions deploy` — never assume. Tasks 1 and 4 below have an explicit stop-and-ask step for this.
- Test command: `TZ=Europe/Paris npm test` (the timezone matters — one existing regression test depends on it).
- This feature has no new pure-function logic worth a `core.test.js` unit test (everything here is a network side effect) — verification is a structural SQL check (Task 1) plus a real live end-to-end check with a test account (Task 6), not new automated tests.

---

### Task 1: Migration — `legal_consents` table + `record_legal_consent` RPC

**Files:**
- Create: `supabase/migrations/0061_legal_consents.sql`

**Interfaces:**
- Produces: table `public.legal_consents(id uuid, user_id uuid, notice_version text, accepted_at timestamptz)`, unique on `(user_id, notice_version)`; RPC `public.record_legal_consent(p_notice_version text) returns void`, callable by any `authenticated` user, writes only for `auth.uid()`.

- [ ] **Step 1: Write the migration file**

```sql
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
```

- [ ] **Step 2: STOP — ask the user which environment(s) to apply this to**

Ask explicitly: staging (`xqborcugpzjzungwgepn`) first for a quick schema smoke test, then prod (`ifhriyvvqkwqgzmrjjxp`), or prod only? Do not proceed to Step 3 without an answer. This repo is currently linked to prod already (confirmed via `supabase/.temp/project-ref`), so switching to staging requires `npx supabase link --project-ref xqborcugpzjzungwgepn` first, and switching back with `npx supabase link --project-ref ifhriyvvqkwqgzmrjjxp` afterward.

- [ ] **Step 3: Apply the migration to the confirmed environment(s)**

Run: `npx supabase db push`
Expected output: the migration list shows `0061_legal_consents.sql` applied, no errors.

- [ ] **Step 4: Verify the structural result with a SQL query**

Run this in the Supabase SQL Editor (or via `psql`) for whichever project was just migrated:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'legal_consents'
order by ordinal_position;

select proname, prosecdef
from pg_proc
where proname = 'record_legal_consent';
```

Expected: 4 columns (`id`, `user_id`, `notice_version`, `accepted_at`); `record_legal_consent` present with `prosecdef = true` (confirms `SECURITY DEFINER` took effect).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0061_legal_consents.sql
git commit -m "Add legal_consents table + record_legal_consent RPC"
```

---

### Task 2: Client service — `legalConsentService.ts`

**Files:**
- Create: `src/services/supabase/legalConsentService.ts`

**Interfaces:**
- Consumes: `supabase` client from `../../supabaseClient`; RPC `record_legal_consent` from Task 1.
- Produces: `recordLegalConsent(noticeVersion: string): Promise<void>` — used by Task 3.

- [ ] **Step 1: Write the service file**

```ts
import { supabase } from "../../supabaseClient";

export async function recordLegalConsent(noticeVersion: string): Promise<void> {
  const { error } = await supabase.rpc("record_legal_consent", { p_notice_version: noticeVersion });
  if (error) throw error;
}
```

- [ ] **Step 2: Verify it builds cleanly**

Run: `npm run build`
Expected: build succeeds, no TypeScript/bundling errors mentioning `legalConsentService`.

- [ ] **Step 3: Commit**

```bash
git add src/services/supabase/legalConsentService.ts
git commit -m "Add legalConsentService.recordLegalConsent"
```

---

### Task 3: Wire consent sync into `App.jsx`

**Files:**
- Modify: `src/App.jsx:1` (add import near the other hook/service imports, e.g. next to line 20's `useExpenses` import)
- Modify: `src/App.jsx:3838-3845` (the existing `rgpdOk` state / `acceptRgpd` function)
- Modify: `src/App.jsx:4144` (insert a new effect right after the existing "invite link clicked with an active session" effect, which ends at this line)

**Interfaces:**
- Consumes: `recordLegalConsent` from `src/services/supabase/legalConsentService.ts` (Task 2); `RGPD_NOTICE_VERSION` (already imported from `./config.js` at line 26); `supabase` (already imported at line 14); `user` state (declared at line 3490).
- Produces: `justAcceptedRgpd` React state, `legalConsentSyncedForUserRef` ref — internal to `App.jsx`, no other task depends on these names.

- [ ] **Step 1: Add the import**

In the import block near the top of `src/App.jsx` (alongside the other `./services/...` and `./hooks/...` imports, e.g. right after the `useExpenses` import on line 20), add:

```js
import { recordLegalConsent } from './services/supabase/legalConsentService';
```

- [ ] **Step 2: Add `justAcceptedRgpd` state and set it in `acceptRgpd`**

Find this existing block (currently lines 3838-3845):

```js
  const [rgpdOk,setRgpdOk] = useState(()=>{
    try { return isRgpdConsentValid(window.localStorage.getItem(RGPD_STORAGE_KEY), RGPD_NOTICE_VERSION); }
    catch { return false; }
  });
  function acceptRgpd(){
    try { window.localStorage.setItem(RGPD_STORAGE_KEY, JSON.stringify(makeRgpdConsentRecord(RGPD_NOTICE_VERSION))); } catch {}
    setRgpdOk(true);
  }
```

Replace it with:

```js
  const [rgpdOk,setRgpdOk] = useState(()=>{
    try { return isRgpdConsentValid(window.localStorage.getItem(RGPD_STORAGE_KEY), RGPD_NOTICE_VERSION); }
    catch { return false; }
  });
  // 🔧 Distingue "vient d'être coché dans cette session" (déclenche l'email
  // de confirmation) de "déjà accepté lors d'une session précédente" (simple
  // rattrapage silencieux serveur, voir l'effet de synchronisation plus bas).
  // Volontairement PAS persisté : un rechargement de page doit repartir à
  // false, c'est exactement le comportement voulu.
  const [justAcceptedRgpd, setJustAcceptedRgpd] = useState(false);
  function acceptRgpd(){
    try { window.localStorage.setItem(RGPD_STORAGE_KEY, JSON.stringify(makeRgpdConsentRecord(RGPD_NOTICE_VERSION))); } catch {}
    setJustAcceptedRgpd(true);
    setRgpdOk(true);
  }
```

- [ ] **Step 3: Add the sync effect**

Find the existing effect that ends at line 4144:

```js
      } catch (e) { console.warn("[Duvia] invite join (session active):", e); }
    })();
  }, [user, familySync]);
```

Right after that closing `}, [user, familySync]);` line, insert:

```js

  // ── Synchronisation serveur du consentement RGPD (CGU/CGV/confidentialité) ──
  // La case (RgpdConsentScreen) est acceptée AVANT toute connexion — aucune
  // session authentifiée n'existe à cet instant précis (voir design doc).
  // On écrit donc la preuve serveur ici, dès qu'une session réelle apparaît.
  // record_legal_consent() fait un upsert idempotent (ON CONFLICT DO
  // NOTHING) : rejouer cet appel à chaque connexion est sans risque, et
  // rattrape silencieusement les comptes déjà existants qui n'avaient que
  // l'ancien consentement localStorage. L'email de confirmation ne part
  // que si la case vient d'être cochée DANS CETTE SESSION
  // (justAcceptedRgpd) — jamais lors de ce rattrapage silencieux, qui ne
  // correspond à aucune action visible de l'utilisateur.
  // Ref keyed par user.id (pas juste un booléen) : sur un appareil partagé,
  // si le parent A se déconnecte et le parent B se connecte SANS recharger
  // la page, B doit aussi déclencher sa propre synchronisation.
  const legalConsentSyncedForUserRef = useRef(null);
  useEffect(() => {
    if (!user?.id || legalConsentSyncedForUserRef.current === user.id) return;
    legalConsentSyncedForUserRef.current = user.id;
    const shouldNotify = justAcceptedRgpd;
    recordLegalConsent(RGPD_NOTICE_VERSION).catch(() => {});
    if (shouldNotify) {
      supabase.functions.invoke("notify-legal-consent", { body: { notice_version: RGPD_NOTICE_VERSION } }).catch(() => {});
    }
  }, [user?.id, justAcceptedRgpd]);
```

- [ ] **Step 4: Verify it builds cleanly**

Run: `npm run build`
Expected: build succeeds, no errors.

- [ ] **Step 5: Run the existing test suite**

Run: `TZ=Europe/Paris npm test`
Expected: all existing tests still pass (this change adds no new pure-function logic, so no new test count, but nothing should regress).

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Sync legal consent to server on login, notify only on fresh accept"
```

---

### Task 4: Edge Function — `notify-legal-consent`

**Files:**
- Create: `supabase/functions/notify-legal-consent/index.ts`

**Interfaces:**
- Consumes: invoked by `App.jsx` (Task 3) via `supabase.functions.invoke("notify-legal-consent", { body: { notice_version } })`, only when a real user just accepted in the current session.
- Produces: nothing consumed by later tasks — this is a leaf.

- [ ] **Step 1: Write the Edge Function**

```ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!
const SB_URL     = Deno.env.get("SUPABASE_URL")!
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const APP_URL    = "https://app.duvia.fr"
const FROM       = "Duvia <notifications@duvia.fr>"

serve(async (req) => {
  // Vérifie que l'utilisateur est bien connecté via son JWT
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "")
  const supabase = createClient(SB_URL, SB_SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return new Response("Unauthorized", { status: 401 })

  const email = user.email
  if (!email || email.includes("@phone.duvia.app")) {
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
  }

  let noticeVersion = "?"
  try {
    const body = await req.json()
    if (body && typeof body.notice_version === "string") noticeVersion = body.notice_version
  } catch {}

  const name = user.user_metadata?.name || user.user_metadata?.full_name || email.split("@")[0]
  const now  = new Date().toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" })

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: "✅ Confirmation de votre consentement Duvia",
      html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#F8F2FF;margin:0;padding:20px;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 24px rgba(123,124,245,.1);">
  <div style="text-align:center;margin-bottom:24px;">
    <div style="font-size:40px">✅</div>
    <h1 style="color:#7B7CF5;font-size:20px;margin:8px 0 0">Consentement enregistré</h1>
  </div>
  <p style="color:#17103A;font-size:15px;line-height:1.6;text-align:center">
    Bonjour <strong>${name}</strong>,<br>
    le ${now}, vous avez accepté la politique de confidentialité et les conditions d'utilisation de Duvia (version ${noticeVersion}).
  </p>
  <p style="color:#17103A;font-size:13px;line-height:1.6;text-align:center;margin-top:16px;">
    Vous pouvez consulter ces documents à tout moment :
  </p>
  <div style="text-align:center;margin:16px 0;line-height:2.2;">
    <a href="${APP_URL}/?legal=cgu" style="color:#7B7CF5;font-weight:700;text-decoration:underline;">Conditions d'utilisation</a><br>
    <a href="${APP_URL}/?legal=cgv" style="color:#7B7CF5;font-weight:700;text-decoration:underline;">Conditions de vente</a><br>
    <a href="${APP_URL}/?legal=privacy" style="color:#7B7CF5;font-weight:700;text-decoration:underline;">Politique de confidentialité</a>
  </div>
  <p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px;">
    Duvia · Two homes. One family.
  </p>
</div>
</body></html>`,
    }),
  })

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
})
```

- [ ] **Step 2: STOP — confirm environment before deploying**

Deploy to the same environment(s) chosen in Task 1, Step 2. If staging was included, first confirm `RESEND_API_KEY` is actually set as a secret on the staging project (`npx supabase secrets list`) — staging is a schema-only clone and this secret may not exist there; if it's missing, the function will fail silently at the `RESEND_KEY!` line at import time (same failure class as the backtick incident documented in `feedback-faq-knowledge-backtick-escaping` — a startup crash, not a clean runtime error).

- [ ] **Step 3: Deploy**

Run: `npx supabase functions deploy notify-legal-consent --use-api`
Expected: JSON response with `"message":"Deployed Functions."`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/notify-legal-consent/index.ts
git commit -m "Add notify-legal-consent Edge Function"
```

---

### Task 5: Version bump + full regression check

**Files:**
- Modify: `src/config.js` (`APP_VERSION`)
- Modify: `public/sw.js` (`SW_VERSION`)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Bump both version constants**

In `src/config.js`, change:
```js
export const APP_VERSION = "3.83";
```
to:
```js
export const APP_VERSION = "3.84";
```

In `public/sw.js`, change:
```js
const SW_VERSION = "3.83";
```
to:
```js
const SW_VERSION = "3.84";
```

- [ ] **Step 2: Run the full test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `ℹ pass 202` (or higher if other work landed in between), `ℹ fail 0`.

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: `✓ built in` with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.js public/sw.js
git commit -m "Bump version to 3.84"
```

---

### Task 6: Live end-to-end verification

**Files:** none (verification only — no code changes).

**Interfaces:** none.

This task requires a human (checking a real inbox, confirming DB rows) — if executed via subagent-driven-development, the controlling session should run this task directly rather than delegating it blind.

- [ ] **Step 1: Confirm which environment was used for Tasks 1 and 4**

Use that same environment for this verification (if staging lacks the `RESEND_API_KEY` secret confirmed in Task 4 Step 2, the email half of this test can only run against prod).

- [ ] **Step 2: Fresh signup path (expect: row + email)**

Register a brand-new throwaway test account in the app (fresh browser profile or private window, so no `duvia_rgpd_consent` localStorage exists yet). Accept the RGPD screen, complete registration. Then run:

```sql
select user_id, notice_version, accepted_at
from public.legal_consents
where user_id = (select id from auth.users where email = '<test-account-email>');
```

Expected: exactly one row, `notice_version` matching the current `RGPD_NOTICE_VERSION` (check `src/config.js`), `accepted_at` within the last few minutes. Confirm the test inbox received the "✅ Confirmation de votre consentement Duvia" email with working `?legal=cgu` / `?legal=cgv` / `?legal=privacy` links.

- [ ] **Step 3: Existing-user backfill path (expect: row, no email)**

Using an existing test account that already has a valid `duvia_rgpd_consent` entry in localStorage from before this feature (or: log in once first to let Task 3's effect fire and create a baseline row, then manually `delete from public.legal_consents where user_id = '<that-users-id>'` to simulate "pre-existing local consent, no server row yet"), log out and log back in. Run the same query as Step 2.

Expected: the row now exists (backfilled), but **no** confirmation email arrives this time.

- [ ] **Step 4: Idempotency check**

Log in a third time with either test account. Run the same query again.

Expected: still exactly one row per `(user_id, notice_version)` — no duplicate, confirming the `on conflict do nothing` upsert works as intended.

- [ ] **Step 5: Push**

Once all of the above pass:

```bash
git push
```
