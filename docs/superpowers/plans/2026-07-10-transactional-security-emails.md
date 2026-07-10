# Transactional Security Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. **Only Task 3 goes through the implementer/reviewer dispatch flow.** Tasks 1, 2, 4, and 5 require live Supabase dashboard interaction (running SQL, pasting Edge Function code, reading/toggling a dashboard setting) that no subagent can perform — the controller does these directly and hands each one to the human to run/deploy, exactly as established earlier in this same session for the parent-email-verification feature's migration and Edge Function. Do not dispatch an implementer for Tasks 1, 2, 4, or 5.

**Goal:** Notify a user by email when their account is logged into from a device it's never seen before, and close two pieces of repo debt (password-change notification source never committed, email-change notification config never verified) — all three pieces of backlog item 3 ("automated transactional emails").

**Architecture:** A new `known_devices` table + `SECURITY DEFINER` RPC (`record_device_login`) tracks per-account device IDs server-side; a new Edge Function (`notify-new-device-login`) sends the alert via Resend, mirroring `send-parent-verification-email`'s auth pattern exactly. The client generates a persistent `localStorage` device ID and calls the RPC after every real login (not registration), gated to accounts with a genuine (non-synthetic) email.

**Tech Stack:** React (single-file `src/App.jsx`), Supabase (Postgres + Auth + Edge Functions), Resend for email delivery.

## Global Constraints

- Table name: `known_devices`. RPC name: `record_device_login(p_device_id TEXT) RETURNS BOOLEAN`. Edge Function name: `notify-new-device-login`. Use these exact names — later tasks and any future code referencing this feature depend on them.
- Client device-ID localStorage key: `duvia_device_id`. Never cleared on logout (identifies the physical device, not the account/session).
- Synthetic-email exclusion check: `!email.includes("@phone.duvia.app")` — exact string already used elsewhere in `src/App.jsx` (e.g. line ~14980) for the same purpose. Any account whose email contains this substring must never trigger the new-device Edge Function call.
- Trigger points are exactly 3: `doLogin()` (`src/App.jsx:5435`), `doLoginAndJoin()` (`src/App.jsx:5837`), and the Google OAuth `SIGNED_IN` handler inside the `onAuthStateChange` effect (`src/App.jsx:3502`). **Never** `doReg()` — a brand-new account's first device is not a meaningful signal and would be noise right after signup.
- `record_device_login` and the Edge Function call must never block or fail a login — always `.catch(()=>{})` or equivalent, matching the existing `notify-password-change` call pattern already in the codebase (`src/App.jsx:6800`, `src/App.jsx:7173`).
- CLAUDE.md requires `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) bumped together on every push that changes app code. Current value: `1.43` → bump to `1.44` in Task 3 (the only task touching `src/App.jsx`).
- CLAUDE.md requires asking the user to paste an *existing* Edge Function's current dashboard content before editing it — this applies to Task 4 (`notify-password-change` already exists live). It does **not** apply to Task 2 (`notify-new-device-login` is brand new, no drift risk).
- Test command: `TZ=Europe/Paris npm test` (122 passing at plan time). Build command: `npm run build`. No new pure-logic functions are expected for this feature (per the spec's Tests section) — Task 3 does not need a `core.js` addition or test, its verification is the existing test suite still passing plus a manual login check.

---

## Task 1: `known_devices` table + `record_device_login` RPC (controller-direct, no subagent)

**Files:**
- Create: `supabase/migrations/0031_known_devices.sql`

**Interfaces:**
- Produces: table `public.known_devices(id, user_id, device_id, first_seen, last_seen)` with `UNIQUE(user_id, device_id)`; RPC `public.record_device_login(p_device_id TEXT) RETURNS BOOLEAN`, callable by `authenticated`, returns `TRUE` only the first time a given `(auth.uid(), p_device_id)` pair is seen.
- Consumes: nothing (first task).

- [ ] **Step 1: Write the migration file**

```sql
-- 0031_known_devices.sql
--
-- Tracks which devices (browsers) have logged into each account, so a
-- "new device" security email can be sent the first time a genuinely new
-- device_id shows up for a given user. device_id is a client-generated
-- UUID persisted in localStorage (src/App.jsx, key duvia_device_id) — this
-- table is the server-side record of which ones have been seen before.
--
-- Depends on: none (standalone new table).

CREATE TABLE IF NOT EXISTS public.known_devices (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id   TEXT        NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS known_devices_user_id_idx ON public.known_devices(user_id);

ALTER TABLE public.known_devices ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all to anon/authenticated by default. Only reachable
-- via the SECURITY DEFINER RPC below (same pattern as
-- parent_email_verifications, migration 0029).

CREATE OR REPLACE FUNCTION public.record_device_login(p_device_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_existing UUID;
BEGIN
  SELECT id INTO v_existing FROM public.known_devices
  WHERE user_id = auth.uid() AND device_id = p_device_id;

  IF v_existing IS NOT NULL THEN
    UPDATE public.known_devices SET last_seen = NOW() WHERE id = v_existing;
    RETURN FALSE;
  END IF;

  INSERT INTO public.known_devices (user_id, device_id) VALUES (auth.uid(), p_device_id);
  RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_device_login(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_device_login(TEXT) TO authenticated;
```

- [ ] **Step 2: Hand the file to the user to run**

Tell the user: "Peux-tu exécuter `supabase/migrations/0031_known_devices.sql` dans le SQL Editor Supabase ?" Wait for confirmation ("Success. No rows returned" or equivalent) before proceeding to Task 2.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0031_known_devices.sql
git commit -m "Add known_devices table + record_device_login RPC"
git push
```

---

## Task 2: `notify-new-device-login` Edge Function (controller-direct, no subagent)

**Files:**
- Create: `supabase/functions/notify-new-device-login/index.ts`

**Interfaces:**
- Consumes: `record_device_login` RPC existing (Task 1) — not called by this function, but this function is only ever invoked by the client after that RPC returned `TRUE`.
- Produces: an HTTP endpoint invoked via `supabase.functions.invoke("notify-new-device-login", { body: { user_id, email, device_info } })` from Task 3's client code — same call shape as `send-parent-verification-email`.

- [ ] **Step 1: Write the Edge Function**

This mirrors `supabase/functions/send-parent-verification-email/index.ts`'s structure and auth pattern exactly (JWT extraction, `admin.auth.getUser(token)` match against `payload.user_id`, 403 on mismatch) — but sends a plain notification email instead of a token-based verification link, so there's no database write.

```typescript
// supabase/functions/notify-new-device-login/index.ts — syntaxe Deno.serve (moderne)
// ─────────────────────────────────────────────────────────────────────────────
// Appelée directement par le client (supabase.functions.invoke) juste après
// une connexion réussie, quand record_device_login (migration 0031) a
// renvoyé TRUE (première fois que ce device_id est vu pour ce compte).
// Envoie un simple email d'alerte via Resend — pas d'écriture en base ici,
// c'est record_device_login qui a déjà enregistré l'appareil.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL           = "https://app.duvia.fr";
const FROM_EMAIL        = "notifications@duvia.fr";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: CORS });
  }

  const userId: string | undefined = payload?.user_id;
  const email: string | undefined  = payload?.email;
  const deviceInfo: string         = payload?.device_info || "un appareil inconnu";
  if (!userId || !email) {
    return new Response("Missing user_id or email", { status: 400, headers: CORS });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 🔒 Vérifie que l'appelant authentifié est bien le titulaire du compte visé
  // — sans ça, n'importe quel utilisateur connecté pourrait déclencher l'envoi
  // d'un email vers n'importe quel user_id de son choix.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("Missing authorization", { status: 401, headers: CORS });
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || callerData?.user?.id !== userId) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }

  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🔐</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouvelle connexion détectée</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#333;margin:0 0 12px">Une connexion à ton compte Duvia a été détectée depuis un nouvel appareil :</p>
      <p style="color:#333;margin:0 0 20px;font-weight:700">${deviceInfo} — ${now}</p>
      <p style="color:#333;margin:0 0 20px">Si c'était toi, tu peux ignorer cet email.</p>
      <p style="color:#c0392b;margin:0;font-weight:700">Si ce n'était pas toi, change ton mot de passe immédiatement dans les Préférences de l'application.</p>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · <a href="${APP_URL}" style="color:#bbb">app.duvia.fr</a>
    </div>
  </div>
</body></html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Duvia <${FROM_EMAIL}>`,
        to: [email],
        subject: "🔐 Nouvelle connexion détectée sur ton compte Duvia",
        html,
      }),
    });
    const resBody = await res.json();
    console.log("notify-new-device-login: Resend response:", JSON.stringify(resBody));
  } catch (e) {
    console.error("notify-new-device-login: Resend send failed", e);
    return new Response(JSON.stringify({ error: "send_failed" }), { status: 500, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
```

- [ ] **Step 2: Hand the code to the user to deploy**

Tell the user: "Crée une nouvelle Edge Function `notify-new-device-login` dans le dashboard Supabase et colle ce code." (No drift risk — this is a brand-new function, nothing to paste-back-first per CLAUDE.md's rule, which only applies to *existing* functions.) Wait for confirmation before proceeding to Task 3.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/notify-new-device-login/index.ts
git commit -m "Add notify-new-device-login Edge Function"
git push
```

---

## Task 3: Client-side device tracking wiring (subagent-driven-development task)

**Files:**
- Modify: `src/App.jsx` (three call sites below, plus one new helper function)
- Modify: `src/config.js:13` (`APP_VERSION`)
- Modify: `public/sw.js:13` (`SW_VERSION`)

**Interfaces:**
- Consumes: RPC `record_device_login(p_device_id TEXT) RETURNS BOOLEAN` (Task 1, already deployed and confirmed by the user before this task starts). Edge Function `notify-new-device-login`, invoked as `supabase.functions.invoke("notify-new-device-login", { body: { user_id, email, device_info } })` (Task 2, already deployed and confirmed by the user before this task starts).
- Produces: nothing consumed by later tasks (this is the last code task).

This task has no automated test (per Global Constraints — no new pure-logic function is being added). Its "test" is: `TZ=Europe/Paris npm test` still shows 122/122 passing, `npm run build` succeeds, and a manual login on a fresh browser profile triggers the new-device email (the user verifies this live after the task is deployed — no browser tooling exists in this environment to verify it directly).

- [ ] **Step 1: Add the device-ID helper and a shared "record + notify" function**

In `src/App.jsx`, find this existing block (currently around line 3155-3179, right after the `?verify_email=` URL-param `useEffect` and the shared email-verification handlers added earlier this session):

```js
  async function handleRefreshVerification() {
    const { data } = await supabase.rpc("is_parent_email_verified");
    setEmailVerified(!!data);
  }
  // ── Notifications push ──────────────────────────────────────────────────
```

Insert a new block between the closing `}` of `handleRefreshVerification` and the `// ── Notifications push ──` comment:

```js
  async function handleRefreshVerification() {
    const { data } = await supabase.rpc("is_parent_email_verified");
    setEmailVerified(!!data);
  }
  // 🔧 Alerte "nouvel appareil" : device_id persistant en localStorage
  // (jamais effacé à la déconnexion — il identifie l'appareil physique, pas
  // le compte). Appelée après CHAQUE connexion réussie (pas l'inscription,
  // voir les 3 sites d'appel plus bas) : la RPC record_device_login fait
  // l'upsert atomique côté serveur et renvoie true seulement la première
  // fois pour ce (compte, appareil). Ne bloque jamais la connexion en cas
  // d'échec réseau/RPC — même esprit que notify-password-change existant.
  function getOrCreateDeviceId() {
    try {
      let id = window.localStorage.getItem("duvia_device_id");
      if (!id) {
        id = crypto.randomUUID();
        window.localStorage.setItem("duvia_device_id", id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }
  async function notifyIfNewDevice(userId, userEmail) {
    if (!userId || !userEmail || userEmail.includes("@phone.duvia.app")) return;
    try {
      const deviceId = getOrCreateDeviceId();
      const { data: isNew } = await supabase.rpc("record_device_login", { p_device_id: deviceId });
      if (!isNew) return;
      const ua = navigator.userAgent || "";
      const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "un navigateur";
      const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : "un appareil";
      await supabase.functions.invoke("notify-new-device-login", {
        body: { user_id: userId, email: userEmail, device_info: `${browser} sur ${os}` },
      });
    } catch (e) {
      console.warn("[Duvia][sync] notifyIfNewDevice failed:", e);
    }
  }
  // ── Notifications push ──────────────────────────────────────────────────
```

- [ ] **Step 2: Wire into `doLogin()`**

Find this exact block in `src/App.jsx` (currently around line 5446-5450):

```js
    const { data, error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(error){
      setOk(""); setErr(t.wrongPw); return;
    }

    // Admin vérifié côté serveur (table app_admins) — personne ne peut se
```

Replace with:

```js
    const { data, error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(error){
      setOk(""); setErr(t.wrongPw); return;
    }
    notifyIfNewDevice(data.user.id, cleanEmail);

    // Admin vérifié côté serveur (table app_admins) — personne ne peut se
```

- [ ] **Step 3: Wire into `doLoginAndJoin()`**

Find this exact block (currently around line 5843-5845):

```js
    const { data, error: signErr } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(signErr){ setErr(t.wrongPw); return; }
    const meta = data.user?.user_metadata || {};
```

Replace with:

```js
    const { data, error: signErr } = await supabase.auth.signInWithPassword({ email: cleanEmail, password: pw });
    if(signErr){ setErr(t.wrongPw); return; }
    notifyIfNewDevice(data.user.id, cleanEmail);
    const meta = data.user?.user_metadata || {};
```

- [ ] **Step 4: Wire into the Google OAuth handler**

Find this exact line (currently around line 3513):

```js
          if (currentSession === u.email || sessionEmail === u.email) return; // déjà connecté
          const googleUser = {
```

Replace with:

```js
          if (currentSession === u.email || sessionEmail === u.email) return; // déjà connecté
          notifyIfNewDevice(u.id, u.email);
          const googleUser = {
```

- [ ] **Step 5: Bump the version**

In `src/config.js`, change:
```js
export const APP_VERSION = "1.43";
```
to:
```js
export const APP_VERSION = "1.44";
```

In `public/sw.js`, change:
```js
const SW_VERSION = "1.43";
```
to:
```js
const SW_VERSION = "1.44";
```

- [ ] **Step 6: Run the test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `tests 122`, `pass 122`, `fail 0` (no new tests are added by this task — this confirms nothing existing broke).

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: build succeeds with no errors (warnings about chunk size are pre-existing and expected).

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "Wire new-device-login detection into login, join, and Google OAuth flows"
git push
```

- [ ] **Step 9: Report manual verification needed**

In your DONE report, explicitly state: "No browser/email tooling exists in this environment — the user must verify live: log in from a browser profile that has never logged into this account (or clear `duvia_device_id` from localStorage), confirm the new-device email arrives; log in again from the same profile, confirm no second email; confirm an account with a `@phone.duvia.app` email never triggers it."

---

## Task 4: Commit `notify-password-change`'s existing source (controller-direct, no subagent)

**Files:**
- Create: `supabase/functions/notify-password-change/index.ts`

**Interfaces:**
- Consumes: nothing new — this function is already deployed and already called by `src/App.jsx:6800` and `src/App.jsx:7173` (`changePassword()`, two copies). This task only makes its source visible in git for the first time.

- [ ] **Step 1: Ask the user for the current dashboard content**

Per CLAUDE.md's Edge Function drift-risk rule, this function already exists live and has never been pulled into the repo — its real source is unknown until the user provides it. Ask: "Peux-tu coller le contenu actuel de la fonction `notify-password-change` depuis le dashboard Supabase ?" Do not write placeholder or guessed content — wait for the paste.

- [ ] **Step 2: Commit the pasted content verbatim**

Save the user's pasted content exactly as `supabase/functions/notify-password-change/index.ts` — no rewriting, no "improving" the code the user didn't ask to change. This is a repo-debt fix (get already-working code under version control), not a refactor.

- [ ] **Step 3: Sanity read**

Read the committed file back and check it roughly follows this project's established Edge Function conventions (JWT/caller-match pattern like `send-parent-verification-email`, Resend HTTP call like the sibling functions). If something looks clearly broken or insecure (e.g., no caller-authentication check at all), flag it to the user as a separate finding — do not silently rewrite it as part of this task.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/notify-password-change/index.ts
git commit -m "Pull notify-password-change source into the repo (was deployed-only)"
git push
```

---

## Task 5: Verify/enable Supabase's "Secure email change" setting (controller-direct, no subagent)

**Files:** none (dashboard configuration only, no code).

**Interfaces:** none — this task does not touch code any other task depends on.

- [ ] **Step 1: Ask the user to check the setting**

Ask: "Peux-tu vérifier dans le dashboard Supabase → Authentication → Settings si l'option 'Secure email change' est activée ?"

- [ ] **Step 2: Act on the answer**

If disabled: ask the user to enable it (sends a confirmation to both the old and new email address on an email change — protects against an attacker with a stolen password locking the real owner out by changing the email unnoticed). If already enabled: nothing to do.

- [ ] **Step 3: Record the outcome**

No commit needed (dashboard-only change). Note the outcome in the plan's progress tracking (or tell the user directly) so it's not re-investigated later: e.g. "Secure email change était déjà activé, rien à faire" or "activé le 2026-07-10".
