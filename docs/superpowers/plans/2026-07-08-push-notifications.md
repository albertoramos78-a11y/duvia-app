# Notifications push (vraies, arrière-plan) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ Post-execution correction (Task 12, 2026-07-08):** Tasks 4-7 below were written and implemented against a **stale local copy** of `notify-expense`, and assumed `notify-message`/`notify-vault-document` didn't exist yet. Both assumptions were wrong: all three functions (`notify-expense`, `notify-message`, `notify-vault`) already existed live in production, deployed straight through the Supabase dashboard, never committed to this repo — genuine drift, same class of issue as the `delete-account` incident from the 2026-07-08 security review. The real deployed sources use `Deno.serve`, a `SUPABASE_SECRET_KEYS` fallback (the new non-deprecated secret name), `auth.admin.getUserById` per member instead of a `family_members→profiles` join, an `@phone.duvia.app` synthetic-email filter, and (for `notify-expense`) send to **all** members including the creator rather than excluding them. Commit `4cb0038` reconciles the repo onto the real sources with only the push-sending block added on top — read that commit, not the code blocks below, before touching any of these three files again. The vault function is `notify-vault`, not `notify-vault-document` — the folder was renamed. `notify-join-request` (Task 7) had no prod equivalent and was left as newly written, but was also switched from the untested `profiles(...)` join onto the same proven `getUserById` pattern for consistency. **Still not in this repo** (out of scope for this reconciliation, logged to project backlog): `notify-password-change`, `admin-backup-manager`, `backup-upload`.

**Goal:** Add real Web Push notifications (arrive even when the app is closed) for 4 events — new message, expense to validate/confirmed/refused, observer/child join request, new vault document — with independent per-channel (push/email) opt-in preferences.

**Architecture:** VAPID-based Web Push. A new `push_subscriptions` table stores one row per browser/device. Supabase Database Webhooks fire on INSERT into `messages`, `expenses`, `vault_documents`, `family_members`; each triggers an Edge Function that checks per-recipient prefs and sends push (via a shared `web-push` helper) and/or email (via Resend, mirroring the existing `notify-expense` pattern). The service worker gains a `push` handler that only displays a system notification when no tab of the app is currently open (the existing foreground code already handles the open-app case) — this avoids double notifications without having to touch the loosely-typed existing foreground notification code.

**Tech Stack:** Supabase (Postgres + RLS, Edge Functions on Deno, Database Webhooks), `web-push` npm package (via Deno `npm:` specifier), Web Push API / Service Worker API, React (existing `App.jsx` monolith + `src/hooks`/`src/services/supabase` pattern), Resend (existing email provider).

## Global Constraints

- Follow the existing three-layer pattern for any new persisted client state: `services/supabase/*Service.ts` → `hooks/use*.ts` → consumed in `App.jsx` (see CLAUDE.md).
- Edge Functions follow the exact CORS + `x-webhook-secret` header pattern already used in `supabase/functions/notify-expense/index.ts` — reuse the same `WEBHOOK_SECRET` env var, do not introduce a second webhook secret.
- Preferences use the existing opt-out model: stored in Supabase auth `user_metadata` via `supabase.auth.updateUser({data:{[key]:val}})`, read back with `!== false` (default enabled). Do not invent a different storage mechanism.
- No automated test harness exists in this repo for Edge Functions, the Service Worker, or React components — only pure functions in `src/utils/core.js` get `node:test` coverage (via `core.test.js`, run with `TZ=Europe/Paris npm test`). Every other task in this plan ends with an explicit manual verification step instead of a fabricated automated test.
- French (`src/i18n/fr.js`) is the reference language; every new i18n key must get a real translation in all 5 files (`fr.js`, `en.js`, `de.js`, `es.js`, `pt.js`), not a copy-paste placeholder.
- Migrations are numbered, idempotent (`IF NOT EXISTS`), and go in `supabase/migrations/`. The last one in the repo is `0026_message_delete_and_own_reactions.sql` — the new one is `0027_push_subscriptions.sql`.
- Do not remove or rewrite the existing ad-hoc foreground `Notification`/`reg.showNotification` calls in `App.jsx` (lines ~3743-3788, ~16779-16784) — they are reused for types this project doesn't cover (and are entangled with a loosely-typed, reused `type` tag across many unrelated notif kinds). De-duplication is handled entirely in the service worker instead (see Task 8).
- Deploy order matters: Edge Functions must exist and be verified manually (via direct `curl` invocation) **before** their corresponding Database Webhook is created in the Supabase dashboard — a function with a live webhook pointed at it will fire on real user actions in production.

---

## File Structure

**New files:**
- `supabase/migrations/0027_push_subscriptions.sql` — subscriptions table + RLS.
- `supabase/functions/_shared/push.ts` — shared Web Push sending helper, used by all 4 trigger functions.
- `supabase/functions/notify-message/index.ts` — new, triggered on `messages` INSERT.
- `supabase/functions/notify-vault-document/index.ts` — new, triggered on `vault_documents` INSERT.
- `supabase/functions/notify-join-request/index.ts` — new, triggered on `family_members` INSERT.
- `src/services/supabase/pushService.ts` — client-side subscribe/unsubscribe/list Supabase calls.
- `src/hooks/usePush.ts` — wraps `pushService` + exposes activation status (including iOS/denied/unsupported states).

**Modified files:**
- `supabase/functions/notify-expense/index.ts` — add push sending (email sending already exists).
- `public/sw.js` — add `push` and `notificationclick` handlers.
- `src/main.jsx` — no change expected, but verify the SW registration still works unchanged (informational, no code change).
- `src/App.jsx` — remove the auto `requestPermission()` effect; wire `usePush`; add activation UI + push/email preference toggles in `PrefsTab` and `ObserverPrefsTab`.
- `src/i18n/{fr,en,de,es,pt}.js` — new keys for the activation UI and the join-request notification row.
- `CLAUDE.md` — document the new `VITE_VAPID_PUBLIC_KEY` env var.

---

### Task 1: Generate VAPID keys and document secrets

**Files:**
- Modify: `CLAUDE.md` (Environment variables section)

**Interfaces:**
- Produces: a VAPID key pair (public + private + subject) that Task 3 onward assumes exists as Supabase secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and a `VITE_VAPID_PUBLIC_KEY` env var the client build assumes exists (consumed in Task 9/10).

- [ ] **Step 1: Generate the key pair**

Run:
```bash
npx web-push generate-vapid-keys
```
Expected output: a `Public Key` and `Private Key` (base64url strings, ~87 and ~43 chars respectively).

- [ ] **Step 2: Hand the values to the user for manual setup**

Tell the user, in the chat (do not commit secrets to the repo):
- Add to the Supabase dashboard → Project Settings → Edge Functions → Secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (the two values from Step 1), and `VAPID_SUBJECT` set to `mailto:duvia.services@gmail.com` (same contact address already used elsewhere in the app, e.g. `LicenseModal`).
- Add to the local `.env` (not committed) and to Vercel's project env vars: `VITE_VAPID_PUBLIC_KEY=<the public key from Step 1>`.

- [ ] **Step 3: Document the new client env var**

In `CLAUDE.md`, under "### Environment variables (`.env`, not committed)", change:
```
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (required — `src/supabaseClient.js` logs an error and the app can't reach the backend without them). `VITE_POSTHOG_KEY` is optional (PostHog EU analytics only initializes if set; `autocapture` is deliberately off).
```
to:
```
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (required — `src/supabaseClient.js` logs an error and the app can't reach the backend without them). `VITE_POSTHOG_KEY` is optional (PostHog EU analytics only initializes if set; `autocapture` is deliberately off). `VITE_VAPID_PUBLIC_KEY` is required for push notification opt-in to work (`src/hooks/usePush.ts`) — the matching private key lives only as a Supabase Edge Function secret, never in client code.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document VITE_VAPID_PUBLIC_KEY env var for push notifications"
```

---

### Task 2: `push_subscriptions` migration

**Files:**
- Create: `supabase/migrations/0027_push_subscriptions.sql`

**Interfaces:**
- Produces: table `public.push_subscriptions(id, user_id, endpoint, p256dh, auth_key, user_agent, created_at)`, RLS scoped to `user_id = auth.uid()`. `pushService.ts` (Task 9) and all 4 Edge Functions (Tasks 4-7, via service-role key which bypasses RLS) depend on this exact shape.

- [ ] **Step 1: Write the migration**

```sql
-- 0027_push_subscriptions.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Abonnements Web Push (un par appareil/navigateur). Alimentée par le client
-- (pushManager.subscribe(), voir src/services/supabase/pushService.ts) et
-- consommée par les Edge Functions de notification (notify-expense,
-- notify-message, notify-vault-document, notify-join-request) via le helper
-- partagé supabase/functions/_shared/push.ts.
--
-- À exécuter APRÈS 0026. Idempotent (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,
  auth_key    TEXT        NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_subscriptions_select_own" ON public.push_subscriptions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "push_subscriptions_insert_own" ON public.push_subscriptions FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "push_subscriptions_update_own" ON public.push_subscriptions FOR UPDATE
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "push_subscriptions_delete_own" ON public.push_subscriptions FOR DELETE
  USING (user_id = auth.uid());
```

- [ ] **Step 2: Hand to the user to run**

Following this repo's established workflow (no direct DB credentials available in this environment — see project memory "Supabase DB access"), paste the migration content into the Supabase SQL Editor and run it. Ask the user to confirm success ("Success. No rows returned" or similar) before moving on.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0027_push_subscriptions.sql
git commit -m "Add push_subscriptions table for Web Push"
```

---

### Task 3: Shared Web Push sending helper

**Files:**
- Create: `supabase/functions/_shared/push.ts`

**Interfaces:**
- Consumes: Supabase secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (Task 1); table `push_subscriptions` (Task 2).
- Produces: `sendPushToUser(admin: SupabaseClient, userId: string, payload: PushPayload): Promise<void>` and `interface PushPayload { title: string; body: string; tag: string; url?: string }` — consumed by Task 4 (notify-expense), Task 5 (notify-message), Task 6 (notify-vault-document), Task 7 (notify-join-request).

- [ ] **Step 1: Write the helper**

```ts
// supabase/functions/_shared/push.ts
// ─────────────────────────────────────────────────────────────────────────────
// Envoi de notifications Web Push, partagé par toutes les fonctions
// déclenchées par un Database Webhook (notify-expense, notify-message,
// notify-vault-document, notify-join-request).
// ─────────────────────────────────────────────────────────────────────────────

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY  = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT     = Deno.env.get("VAPID_SUBJECT")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url?: string;
}

/**
 * Envoie `payload` à tous les abonnements push d'un utilisateur (un par
 * appareil). Supprime automatiquement les abonnements qui répondent 404/410
 * (désinstallés côté navigateur) — pas de job de nettoyage séparé nécessaire.
 * Un échec sur un appareil n'empêche jamais l'envoi aux autres.
 */
export async function sendPushToUser(admin: any, userId: string, payload: PushPayload): Promise<void> {
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .eq("user_id", userId);

  if (!subs?.length) return;

  await Promise.all(subs.map(async (sub: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        JSON.stringify(payload)
      );
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", sub.id);
      } else {
        console.warn(`push: échec envoi vers ${userId} (sub ${sub.id})`, e?.statusCode ?? e);
      }
    }
  }));
}
```

- [ ] **Step 2: Verify (manual)**

This file has no HTTP endpoint of its own — Deno resolves `npm:` imports at deploy time. Verification happens indirectly: Task 4's deploy step will fail immediately if this import is broken. No standalone check needed here.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/push.ts
git commit -m "Add shared Web Push sending helper for Edge Functions"
```

---

### Task 4: Extend `notify-expense` to send push

**Files:**
- Modify: `supabase/functions/notify-expense/index.ts`

**Interfaces:**
- Consumes: `sendPushToUser` from `../_shared/push.ts` (Task 3).
- Produces: nothing new consumed by later tasks — this is the reference pattern Tasks 5-7 replicate for their own event types.

- [ ] **Step 1: Add the import**

In `supabase/functions/notify-expense/index.ts`, after the existing imports:

```ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
```

add:

```ts
import { sendPushToUser } from "../_shared/push.ts";
```

- [ ] **Step 2: Send push alongside the existing email, inside the same recipient loop**

Find the existing loop (`for (const member of recipients) { ... }`), right after the line:

```ts
    // Vérifie la préférence email_expenses
    const { data: userMeta } = await supabase.auth.admin.getUserById(member.user_id);
    const prefs = userMeta?.user?.user_metadata || {};
    if (prefs.email_expenses === false) continue;
```

insert a push send **before** the `if (prefs.email_expenses === false) continue;` line (push and email are independent preferences, so push must not be skipped just because email is off):

```ts
    // Vérifie la préférence email_expenses
    const { data: userMeta } = await supabase.auth.admin.getUserById(member.user_id);
    const prefs = userMeta?.user?.user_metadata || {};

    if (prefs.push_expenses !== false) {
      await sendPushToUser(supabase, member.user_id, {
        title: "Duvia",
        body: `💰 Nouvelle dépense : ${expense.label}`,
        tag: "expense",
        url: "/",
      });
    }

    if (prefs.email_expenses === false) continue;
```

- [ ] **Step 3: Deploy and verify manually**

Run:
```bash
supabase functions deploy notify-expense
```
Expected: deploy succeeds with no errors referencing the new import.

Then, with `WEBHOOK_SECRET` set to its real value, invoke it directly to confirm the function still runs end-to-end (replace `<family-id>` with a real family id from a test account, and `<webhook-secret>` with the real value from Supabase secrets):

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/notify-expense" \
  -H "x-webhook-secret: <webhook-secret>" \
  -H "Content-Type: application/json" \
  -d '{"record": {"family_id": "<family-id>", "label": "Test push", "amount": 10, "created_by": 0}}'
```
Expected: `200 ok`. Since no real `push_subscriptions` rows exist yet at this point in the plan, `sendPushToUser` will silently no-op (no error) — full push delivery is verified end-to-end in Task 12, once Tasks 9-11 give us a real subscribed device to test against.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/notify-expense/index.ts
git commit -m "Send push notification alongside existing expense email"
```

---

### Task 5: `notify-message` Edge Function

**Files:**
- Create: `supabase/functions/notify-message/index.ts`

**Interfaces:**
- Consumes: `sendPushToUser` (Task 3); `messages` table shape `{id, family_id, sender_id, sender_name, recipient_ids, content, read_by, reactions, created_at}` (from `src/services/supabase/messageService.ts`); `profiles(id, email, first_name)` table (same one joined in `notify-expense`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/notify-message/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Déclenchée par le webhook Supabase sur messages INSERT.
// Envoie un push + un email à chaque destinataire du message (tous sauf
// l'auteur). Avant ce chantier, la préférence "email_notifs" existait déjà
// côté UI mais n'était consommée par aucune fonction — ce fichier la rend
// enfin fonctionnelle, en plus d'ajouter le push.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUser } from "../_shared/push.ts";

const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET   = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM_EMAIL       = "notifications@duvia.fr";
const APP_URL          = "https://app.duvia.fr";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-webhook-secret, content-type",
      },
    });
  }

  const secret = req.headers.get("x-webhook-secret");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const message = payload?.record;
  if (!message?.family_id || !message?.sender_id) {
    return new Response("Missing message data", { status: 400 });
  }

  const recipientIds: string[] = (message.recipient_ids || []).filter(
    (id: string) => id !== message.sender_id
  );
  if (recipientIds.length === 0) return new Response("No recipients", { status: 200 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, email, first_name")
    .in("id", recipientIds);

  const senderName = message.sender_name || "Un parent";
  const preview = (message.content || "").startsWith("__ATTACH__")
    ? `📎 ${senderName} a partagé un fichier`
    : `💬 ${senderName} : ${(message.content || "").slice(0, 80)}`;

  for (const recipientId of recipientIds) {
    const { data: userMeta } = await supabase.auth.admin.getUserById(recipientId);
    const prefs = userMeta?.user?.user_metadata || {};

    if (prefs.push_notifs !== false) {
      await sendPushToUser(supabase, recipientId, {
        title: "Duvia",
        body: preview,
        tag: "message",
        url: "/",
      });
    }

    if (prefs.email_notifs === false) continue;
    const profile = profiles?.find((p: any) => p.id === recipientId);
    const email = profile?.email;
    const name  = profile?.first_name || "Parent";
    if (!email) continue;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">💬</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouveau message</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#666;margin:0 0 20px">Bonjour ${name},</p>
      <p style="color:#333;margin:0 0 24px">${preview}</p>
      <a href="${APP_URL}" style="display:block;background:linear-gradient(135deg,#7BA8F5,#9D8FF0);color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:700">
        💬 Répondre sur Duvia
      </a>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · Two homes, One family · <a href="${APP_URL}" style="color:#bbb">app.duvia.fr</a>
    </div>
  </div>
</body>
</html>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Duvia <${FROM_EMAIL}>`,
        to: [email],
        subject: `💬 Nouveau message de ${senderName}`,
        html,
      }),
    });
  }

  return new Response("ok", { status: 200 });
});
```

- [ ] **Step 2: Deploy and verify manually**

```bash
supabase functions deploy notify-message
```

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/notify-message" \
  -H "x-webhook-secret: <webhook-secret>" \
  -H "Content-Type: application/json" \
  -d '{"record": {"family_id": "<family-id>", "sender_id": "<sender-uuid>", "sender_name": "Test", "recipient_ids": ["<recipient-uuid>"], "content": "Hello"}}'
```
Expected: `200 ok`. Check the Supabase Functions logs (dashboard → Edge Functions → notify-message → Logs) for no unexpected errors. Full push/email delivery verified in Task 12.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/notify-message/index.ts
git commit -m "Add notify-message Edge Function (push + email on new message)"
```

---

### Task 6: `notify-vault-document` Edge Function

**Files:**
- Create: `supabase/functions/notify-vault-document/index.ts`

**Interfaces:**
- Consumes: `sendPushToUser` (Task 3); `vault_documents` table shape `{id, family_id, uploaded_by, added_by_name, name, ...}` (from `src/services/supabase/vaultService.ts`); `family_members` joined with `profiles(email, first_name)` (same join pattern as `notify-expense`).

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/notify-vault-document/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Déclenchée par le webhook Supabase sur vault_documents INSERT.
// Envoie un push + un email à tous les membres actifs de la famille sauf
// celui qui a ajouté le document. La préférence "email_vault" existait déjà
// côté UI mais n'était consommée par aucune fonction — ce fichier la rend
// enfin fonctionnelle, en plus d'ajouter le push.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUser } from "../_shared/push.ts";

const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET   = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM_EMAIL       = "notifications@duvia.fr";
const APP_URL          = "https://app.duvia.fr";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-webhook-secret, content-type",
      },
    });
  }

  const secret = req.headers.get("x-webhook-secret");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const doc = payload?.record;
  if (!doc?.family_id || !doc?.uploaded_by) {
    return new Response("Missing document data", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: members } = await supabase
    .from("family_members")
    .select("user_id, profiles(email, first_name)")
    .eq("family_id", doc.family_id)
    .eq("status", "active");

  const recipients = (members || []).filter((m: any) => m.user_id !== doc.uploaded_by);
  if (recipients.length === 0) return new Response("No recipients", { status: 200 });

  const uploaderName = doc.added_by_name || "Un membre de la famille";
  const docName = doc.name || "Document";

  for (const member of recipients) {
    const { data: userMeta } = await supabase.auth.admin.getUserById(member.user_id);
    const prefs = userMeta?.user?.user_metadata || {};

    if (prefs.push_vault !== false) {
      await sendPushToUser(supabase, member.user_id, {
        title: "Duvia",
        body: `🗄️ ${uploaderName} a ajouté "${docName}"`,
        tag: "vault",
        url: "/",
      });
    }

    if (prefs.email_vault === false) continue;
    const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
    const email = profile?.email;
    const name  = profile?.first_name || "Parent";
    if (!email) continue;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🗄️</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouveau document</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#666;margin:0 0 20px">Bonjour ${name},</p>
      <p style="color:#333;margin:0 0 24px"><strong>${uploaderName}</strong> a ajouté "${docName}" au coffre-fort.</p>
      <a href="${APP_URL}" style="display:block;background:linear-gradient(135deg,#7BA8F5,#9D8FF0);color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:700">
        🗄️ Voir sur Duvia
      </a>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · Two homes, One family · <a href="${APP_URL}" style="color:#bbb">app.duvia.fr</a>
    </div>
  </div>
</body>
</html>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `Duvia <${FROM_EMAIL}>`, to: [email], subject: `🗄️ Nouveau document : ${docName}`, html }),
    });
  }

  return new Response("ok", { status: 200 });
});
```

- [ ] **Step 2: Deploy and verify manually**

```bash
supabase functions deploy notify-vault-document
```

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/notify-vault-document" \
  -H "x-webhook-secret: <webhook-secret>" \
  -H "Content-Type: application/json" \
  -d '{"record": {"family_id": "<family-id>", "uploaded_by": "<uploader-uuid>", "added_by_name": "Test", "name": "Test doc"}}'
```
Expected: `200 ok`, no unexpected errors in the Functions logs.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/notify-vault-document/index.ts
git commit -m "Add notify-vault-document Edge Function (push + email on new vault doc)"
```

---

### Task 7: `notify-join-request` Edge Function

**Files:**
- Create: `supabase/functions/notify-join-request/index.ts`

**Interfaces:**
- Consumes: `sendPushToUser` (Task 3); `family_members` INSERT payload `{family_id, user_id, role, status, display_name, ...}` (columns confirmed via the existing pending-members query in `App.jsx`).

**Note on scope:** per the design spec, children auto-join as `status: 'active'` immediately (no approval step) while observers land as `status: 'pending'` awaiting a parent's validation — both already produce the same in-app "someone joined" notification to parents today (`App.jsx` lines ~3807 and ~3838), so this function fires on **any** non-parent `family_members` insert, regardless of status, and adjusts its wording based on `status`.

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/notify-join-request/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Déclenchée par le webhook Supabase sur family_members INSERT.
// Prévient les parents actifs qu'un observateur ou un enfant a rejoint (ou
// demande à rejoindre) la famille. Ignore les insertions de parents.
// Aucune préférence "email_join_requests"/"push_join_requests" n'existait
// avant ce chantier — les deux sont nouvelles.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUser } from "../_shared/push.ts";

const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET   = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM_EMAIL       = "notifications@duvia.fr";
const APP_URL          = "https://app.duvia.fr";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-webhook-secret, content-type",
      },
    });
  }

  const secret = req.headers.get("x-webhook-secret");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const joiner = payload?.record;
  if (!joiner?.family_id || !joiner?.user_id) {
    return new Response("Missing member data", { status: 400 });
  }
  if (joiner.role === "parent") {
    return new Response("Parent join, ignored", { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: parents } = await supabase
    .from("family_members")
    .select("user_id, profiles(email, first_name)")
    .eq("family_id", joiner.family_id)
    .eq("role", "parent")
    .eq("status", "active");

  if (!parents?.length) return new Response("No parents to notify", { status: 200 });

  const joinerName = joiner.display_name || "Un nouveau membre";
  const isPending = joiner.status === "pending";
  const body = isPending
    ? `👥 ${joinerName} demande à rejoindre la famille`
    : `🧒 ${joinerName} a rejoint la famille`;

  for (const parent of parents) {
    const { data: userMeta } = await supabase.auth.admin.getUserById(parent.user_id);
    const prefs = userMeta?.user?.user_metadata || {};

    if (prefs.push_join_requests !== false) {
      await sendPushToUser(supabase, parent.user_id, {
        title: "Duvia",
        body,
        tag: "join-request",
        url: "/",
      });
    }

    if (prefs.email_join_requests === false) continue;
    const profile = Array.isArray(parent.profiles) ? parent.profiles[0] : parent.profiles;
    const email = profile?.email;
    const name  = profile?.first_name || "Parent";
    if (!email) continue;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">👥</div>
      <div style="color:#fff;font-size:18px;font-weight:800">${isPending ? "Demande à valider" : "Nouveau membre"}</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#666;margin:0 0 20px">Bonjour ${name},</p>
      <p style="color:#333;margin:0 0 24px">${body}.</p>
      <a href="${APP_URL}" style="display:block;background:linear-gradient(135deg,#7BA8F5,#9D8FF0);color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:700">
        👥 Voir sur Duvia
      </a>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · Two homes, One family · <a href="${APP_URL}" style="color:#bbb">app.duvia.fr</a>
    </div>
  </div>
</body>
</html>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Duvia <${FROM_EMAIL}>`,
        to: [email],
        subject: `👥 ${joinerName} — ${isPending ? "demande à rejoindre" : "a rejoint"} Duvia`,
        html,
      }),
    });
  }

  return new Response("ok", { status: 200 });
});
```

- [ ] **Step 2: Deploy and verify manually**

```bash
supabase functions deploy notify-join-request
```

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/notify-join-request" \
  -H "x-webhook-secret: <webhook-secret>" \
  -H "Content-Type: application/json" \
  -d '{"record": {"family_id": "<family-id>", "user_id": "<joiner-uuid>", "role": "observer", "status": "pending", "display_name": "Mamie Test"}}'
```
Expected: `200 ok`, no unexpected errors in the Functions logs. Also verify the parent-role early-return:
```bash
curl -X POST "https://<project-ref>.functions.supabase.co/notify-join-request" \
  -H "x-webhook-secret: <webhook-secret>" \
  -H "Content-Type: application/json" \
  -d '{"record": {"family_id": "<family-id>", "user_id": "<uuid>", "role": "parent", "status": "active"}}'
```
Expected: `200 Parent join, ignored`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/notify-join-request/index.ts
git commit -m "Add notify-join-request Edge Function (push + email on observer/child join)"
```

---

### Task 8: Service worker `push` and `notificationclick` handlers

**Files:**
- Modify: `public/sw.js`

**Interfaces:**
- Consumes: the `PushPayload` shape sent by `sendPushToUser` (`{title, body, tag, url}`).
- Produces: nothing consumed by later tasks in code, but this is what makes push visible to the user at all — Task 12's manual E2E test depends on it.

- [ ] **Step 1: Add the handlers**

Current file:
```js
// Service worker minimal — ne met rien en cache, sert juste à rendre
// l'application "installable" sur Android/Chrome.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  // Ne jamais intercepter les requêtes cross-origin (photos Supabase Storage,
  // etc.) : les rejouer via fetch(event.request) casse les réponses opaques
  // cross-origin sur certains navigateurs mobiles (image cassée sur téléphone,
  // fonctionne sur PC) — on laisse le navigateur les traiter nativement.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});
```

New file (append the two new listeners):
```js
// Service worker minimal — ne met rien en cache, sert juste à rendre
// l'application "installable" sur Android/Chrome.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  // Ne jamais intercepter les requêtes cross-origin (photos Supabase Storage,
  // etc.) : les rejouer via fetch(event.request) casse les réponses opaques
  // cross-origin sur certains navigateurs mobiles (image cassée sur téléphone,
  // fonctionne sur PC) — on laisse le navigateur les traiter nativement.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});

// ── Web Push ──────────────────────────────────────────────────────────────
// Si l'app a déjà un onglet ouvert (peu importe le focus), le code JS
// in-app (App.jsx) affiche déjà sa propre notification OS pour les mêmes
// événements — on n'affiche donc la notification du push QUE si aucun
// onglet n'est ouvert, pour ne jamais doubler.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  event.waitUntil((async () => {
    const openClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (openClients.length > 0) return;

    await self.registration.showNotification(data.title || "Duvia", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon-192.png",
      data: { url: data.url || "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil((async () => {
    const openClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of openClients) {
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
```

- [ ] **Step 2: Verify manually**

There is no automated way to exercise a service worker's `push` event in this repo's `node --test` setup. Manual check, deferred to Task 12 (needs a real subscription first): open the app in a browser, close all its tabs, trigger one of the 4 events from another account, confirm a system notification appears; click it and confirm the app opens/focuses.

- [ ] **Step 3: Commit**

```bash
git add public/sw.js
git commit -m "Add push and notificationclick handlers to the service worker"
```

---

### Task 9: `pushService.ts` + `usePush.ts` hook

**Files:**
- Create: `src/services/supabase/pushService.ts`
- Create: `src/hooks/usePush.ts`

**Interfaces:**
- Consumes: `push_subscriptions` table (Task 2); `import.meta.env.VITE_VAPID_PUBLIC_KEY` (Task 1).
- Produces: `usePush(userId: string | null, vapidPublicKey: string)` returning `{ status: PushStatus, subscribe(): Promise<void>, unsubscribe(): Promise<void> }` where `PushStatus = "unsupported" | "ios-needs-install" | "denied" | "default" | "subscribed"` — consumed by Task 10 (wiring into `App()` + context) and Task 11 (UI).

- [ ] **Step 1: Write `pushService.ts`**

```ts
// src/services/supabase/pushService.ts
import { supabase } from "../../supabaseClient";

export async function saveSubscription(userId: string, sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint: json.endpoint!,
      p256dh: json.keys!.p256dh,
      auth_key: json.keys!.auth,
      user_agent: navigator.userAgent,
    },
    { onConflict: "endpoint" }
  );
  if (error) throw error;
}

export async function deleteSubscriptionByEndpoint(endpoint: string): Promise<void> {
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw error;
}
```

- [ ] **Step 2: Write `usePush.ts`**

```ts
// src/hooks/usePush.ts
import { useCallback, useEffect, useState } from "react";
import { saveSubscription, deleteSubscriptionByEndpoint } from "../services/supabase/pushService";

export type PushStatus = "unsupported" | "ios-needs-install" | "denied" | "default" | "subscribed";

function isIosNeedingInstall(): boolean {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as any).standalone === true;
  return isIos && !isStandalone;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function usePush(userId: string | null, vapidPublicKey: string) {
  const [status, setStatus] = useState<PushStatus>("default");

  const refreshStatus = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (isIosNeedingInstall()) {
      setStatus("ios-needs-install");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    setStatus(sub ? "subscribed" : "default");
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const subscribe = useCallback(async () => {
    if (!userId || !vapidPublicKey) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    await saveSubscription(userId, sub);
    await refreshStatus();
  }, [userId, vapidPublicKey, refreshStatus]);

  const unsubscribe = useCallback(async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await deleteSubscriptionByEndpoint(sub.endpoint);
      await sub.unsubscribe();
    }
    await refreshStatus();
  }, [refreshStatus]);

  return { status, subscribe, unsubscribe };
}
```

- [ ] **Step 3: Verify (build only — behavior verified in Task 12)**

```bash
npm run build
```
Expected: build succeeds with no TypeScript/import errors referencing these two new files.

- [ ] **Step 4: Commit**

```bash
git add src/services/supabase/pushService.ts src/hooks/usePush.ts
git commit -m "Add pushService and usePush hook for client-side Web Push subscription"
```

---

### Task 10: Wire `usePush` into `App()`, remove auto permission request

**Files:**
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `usePush` (Task 9).
- Produces: `pushStatus`, `pushSubscribe`, `pushUnsubscribe` added to the `AppContext` value — consumed by `PrefsTab`/`ObserverPrefsTab` in Task 11 via `useApp()`.

- [ ] **Step 1: Remove the auto-request effect**

In `src/App.jsx`, delete this line (around line 3731):
```js
  useEffect(()=>{ if(window.Notification&&Notification.permission==="default") Notification.requestPermission(); },[]);
```
It's replaced by the explicit opt-in button built in Task 11 — `pushManager.subscribe()` triggers the permission prompt itself, in direct response to a user gesture, which is both more correct and more reliable across browsers than an unprompted `requestPermission()` call on mount.

- [ ] **Step 2: Call `usePush` once, after `user` is available**

In `src/App.jsx`, right after the `const [user, setUser] = useState(...)` block ends (around line 2986, immediately before the comment `// handleSetUser défini plus bas, après tous les useState`), add:

```js
  // ── Notifications push ──────────────────────────────────────────────────
  const { status: pushStatus, subscribe: pushSubscribe, unsubscribe: pushUnsubscribe } =
    usePush(user?.id || null, import.meta.env.VITE_VAPID_PUBLIC_KEY);
```

And add the import near the top of the file alongside the other hook imports (find the existing `import { useMessages } from "./hooks/useMessages";`-style lines and add one more in the same group):
```js
import { usePush } from "./hooks/usePush";
```

- [ ] **Step 3: Expose through context**

In the `ctxValue` object (around line 4098-4109), add the three new values:

```js
  const ctxValue = {
    C, t, lang, setLang, dark, themeMode, cycleTheme,
    currency, setCurrency, weekStart, setWeekStart,
    cfg, setCfg, sub, setSub, user, users, setUsers,
    prem, perms, st, days, isAdm, isObs, isChild, unread, adminVerified,
    addHist, pushNotif, updateCal, onUpgrade, handleObsJoin,
    apiData, apiLoading,
    setMenuTab, setShowMenu,
    msgs, sendCloudMessage, markCloudMessageRead, reactToCloudMessage, deleteCloudMessage, myUid,
    activity, setActivity, allSeen, setAllSeen, _setSeen,
    unreadVaultDocIds, setUnreadVaultDocIds, custodyShadow,
    summerActive, setSummerActive, rgActive, setRgActive, wcActive, setWcActive, videoActive, setVideoActive,
    pushStatus, pushSubscribe, pushUnsubscribe,
```
(keep the rest of the object exactly as-is — only the last line is new).

- [ ] **Step 4: Verify manually**

```bash
npm run build
```
Expected: succeeds. Then run the app locally (`npm run dev`), log in, and confirm in the browser console that no error is thrown on load (the old auto-`requestPermission()` behavior is gone — no permission prompt should appear until Task 11's button is clicked).

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Wire usePush into App context; remove auto Notification.requestPermission()"
```

---

### Task 11: Activation UI + per-type push/email preference toggles + i18n

**Files:**
- Modify: `src/App.jsx` (`PrefsTab` ~line 6434-6641, `ObserverPrefsTab` ~line 6865-6970)
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js`

**Interfaces:**
- Consumes: `pushStatus`, `pushSubscribe`, `pushUnsubscribe` from `useApp()` (Task 10).
- Produces: user-visible feature completion — nothing further depends on this.

- [ ] **Step 1: Add i18n keys to `src/i18n/fr.js`**

Right after the existing block (around line 620-626):
```js
    emailNotifs:"Notifications email",
    notifMsg:"Nouveau message reçu",
    notifMsgDesc:"Email quand l'autre parent vous écrit",
    notifExp:"Nouvelle dépense",
    notifExpDesc:"Email quand une dépense est ajoutée ou modifiée",
    notifVault:"Nouveau document (coffre)",
    notifVaultDesc:"Email quand un document est ajouté au coffre-fort",
```
add:
```js
    notifJoinRequest:"Demande à rejoindre",
    notifJoinRequestDesc:"Email quand un observateur ou un enfant rejoint (ou demande à rejoindre) la famille",
    pushSectionTitle:"🔔 Notifications push",
    pushEnableBtn:"Activer les notifications push sur cet appareil",
    pushEnabledStatus:"✅ Activé sur cet appareil",
    pushDisableBtn:"Désactiver sur cet appareil",
    pushIosInstall:"Ajoute Duvia à ton écran d'accueil pour activer les notifications push (Réglages → Partager → Sur l'écran d'accueil).",
    pushDenied:"Notifications bloquées dans les réglages de ton navigateur. Réactive-les pour recevoir les notifications push.",
    pushUnsupported:"Les notifications push ne sont pas disponibles sur ce navigateur.",
```

- [ ] **Step 2: Add the matching i18n keys to `src/i18n/en.js`**

After the existing block (around line 569-575):
```js
    emailNotifs:"Email notifications",
    notifMsg:"New message received",
    notifMsgDesc:"Email when the other parent writes to you",
    notifExp:"New expense",
    notifExpDesc:"Email when an expense is added or modified",
    notifVault:"New document (vault)",
    notifVaultDesc:"Email when a document is added to the vault",
```
add:
```js
    notifJoinRequest:"Join request",
    notifJoinRequestDesc:"Email when an observer or child joins (or requests to join) the family",
    pushSectionTitle:"🔔 Push notifications",
    pushEnableBtn:"Enable push notifications on this device",
    pushEnabledStatus:"✅ Enabled on this device",
    pushDisableBtn:"Disable on this device",
    pushIosInstall:"Add Duvia to your home screen to enable push notifications (Share → Add to Home Screen).",
    pushDenied:"Notifications are blocked in your browser settings. Re-enable them to receive push notifications.",
    pushUnsupported:"Push notifications aren't available in this browser.",
```

- [ ] **Step 3: Add the same keys, translated, to `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js`**

Find the equivalent `emailNotifs`/`notifMsg`/`notifExp`/`notifVault` block in each file (same key names, translated values — locate via the same `notifVaultDesc` search used for `fr.js`/`en.js`) and add, right after it:

`de.js`:
```js
    notifJoinRequest:"Beitrittsanfrage",
    notifJoinRequestDesc:"E-Mail, wenn ein Beobachter oder ein Kind der Familie beitritt (oder dies beantragt)",
    pushSectionTitle:"🔔 Push-Benachrichtigungen",
    pushEnableBtn:"Push-Benachrichtigungen auf diesem Gerät aktivieren",
    pushEnabledStatus:"✅ Auf diesem Gerät aktiviert",
    pushDisableBtn:"Auf diesem Gerät deaktivieren",
    pushIosInstall:"Füge Duvia zum Startbildschirm hinzu, um Push-Benachrichtigungen zu aktivieren (Teilen → Zum Home-Bildschirm).",
    pushDenied:"Benachrichtigungen sind in deinen Browsereinstellungen blockiert. Aktiviere sie erneut, um Push-Benachrichtigungen zu erhalten.",
    pushUnsupported:"Push-Benachrichtigungen sind in diesem Browser nicht verfügbar.",
```

`es.js`:
```js
    notifJoinRequest:"Solicitud para unirse",
    notifJoinRequestDesc:"Email cuando un observador o un hijo se une (o solicita unirse) a la familia",
    pushSectionTitle:"🔔 Notificaciones push",
    pushEnableBtn:"Activar notificaciones push en este dispositivo",
    pushEnabledStatus:"✅ Activado en este dispositivo",
    pushDisableBtn:"Desactivar en este dispositivo",
    pushIosInstall:"Añade Duvia a tu pantalla de inicio para activar las notificaciones push (Compartir → Añadir a pantalla de inicio).",
    pushDenied:"Las notificaciones están bloqueadas en la configuración de tu navegador. Reactívalas para recibir notificaciones push.",
    pushUnsupported:"Las notificaciones push no están disponibles en este navegador.",
```

`pt.js`:
```js
    notifJoinRequest:"Pedido para entrar",
    notifJoinRequestDesc:"Email quando um observador ou filho entra (ou pede para entrar) na família",
    pushSectionTitle:"🔔 Notificações push",
    pushEnableBtn:"Ativar notificações push neste aparelho",
    pushEnabledStatus:"✅ Ativado neste aparelho",
    pushDisableBtn:"Desativar neste aparelho",
    pushIosInstall:"Adiciona o Duvia ao ecrã principal para ativar as notificações push (Partilhar → Adicionar ao ecrã principal).",
    pushDenied:"As notificações estão bloqueadas nas definições do teu navegador. Reativa-as para receber notificações push.",
    pushUnsupported:"As notificações push não estão disponíveis neste navegador.",
```

- [ ] **Step 4: Add prefs state + activation UI in `PrefsTab`**

In `src/App.jsx`, in `PrefsTab()` (around line 6434-6441), add two new state vars alongside the existing ones:

```js
  const [emailMsg,    setEmailMsg]    = useState(true);
  const [emailExp,    setEmailExp]    = useState(true);
  const [emailVault,  setEmailVault]  = useState(true);
  const [emailJoin,   setEmailJoin]   = useState(true);
  const [pushMsg,     setPushMsg]     = useState(true);
  const [pushExp,     setPushExp]     = useState(true);
  const [pushVault,   setPushVault]   = useState(true);
  const [pushJoin,    setPushJoin]    = useState(true);
```

Then in the destructure at the top of `PrefsTab` (line 6435), add `pushStatus, pushSubscribe, pushUnsubscribe`:
```js
  const {C,t,lang,setLang,sub,setConfirmDeleteAccount,user,currency,setCurrency,weekStart,setWeekStart,cfg,setCfg,history,familySync,addHist,msgs,expenses,reimbursements,pushStatus,pushSubscribe,pushUnsubscribe} = useApp();
```

In the `useEffect` that loads prefs from `user_metadata` (around line 6465-6477), add the 4 new reads:
```js
  useEffect(()=>{
    supabase.auth.getUser().then(({data})=>{
      const m = data?.user?.user_metadata || {};
      setEmailMsg(m.email_notifs    !== false);
      setEmailExp(m.email_expenses  !== false);
      setEmailVault(m.email_vault   !== false);
      setEmailJoin(m.email_join_requests !== false);
      setPushMsg(m.push_notifs      !== false);
      setPushExp(m.push_expenses    !== false);
      setPushVault(m.push_vault     !== false);
      setPushJoin(m.push_join_requests   !== false);
      if(m.week_start) setWeekStart(m.week_start);
      // Détecte les comptes Google (pas de mot de passe Supabase)
      const provider = data?.user?.app_metadata?.provider;
      setIsGoogleUser(provider === "google");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
```

Replace the "Notifications email" section (lines 6632-6641) with a combined "Notifications" section with paired columns, plus the activation control:

```jsx
      {/* ── Notifications push ── */}
      <div style={{marginBottom:16}}>
        <div className="sec">{t.pushSectionTitle||"🔔 Notifications push"}</div>
        {pushStatus==="unsupported" && (
          <div style={{fontSize:12,color:C.mut,padding:"10px 12px"}}>{t.pushUnsupported}</div>
        )}
        {pushStatus==="ios-needs-install" && (
          <div style={{fontSize:12,color:C.mut,padding:"10px 12px"}}>{t.pushIosInstall}</div>
        )}
        {pushStatus==="denied" && (
          <div style={{fontSize:12,color:C.red,padding:"10px 12px"}}>{t.pushDenied}</div>
        )}
        {pushStatus==="default" && (
          <button onClick={pushSubscribe} style={{width:"100%",padding:"13px 16px",background:C.vio,color:"#fff",border:"none",borderRadius:12,fontSize:13,fontWeight:700,cursor:"pointer"}}>
            {t.pushEnableBtn}
          </button>
        )}
        {pushStatus==="subscribed" && (
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 16px",background:C.sur,borderRadius:12,border:`1px solid ${C.bor}`}}>
            <div style={{fontSize:13,fontWeight:700,color:C.grn}}>{t.pushEnabledStatus}</div>
            <button onClick={pushUnsubscribe} style={{padding:"6px 12px",background:"transparent",color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              {t.pushDisableBtn}
            </button>
          </div>
        )}
      </div>

      {/* ── Notifications par type (email + push) ── */}
      <div style={{marginBottom:28}}>
        <div className="sec">{t.emailNotifs||"Notifications"}</div>
        <NotifRow label={t.notifMsg||"Nouveau message reçu"} desc={t.notifMsgDesc||"Email quand l'autre parent vous écrit"}
          val={emailMsg} onToggle={()=>{ const v=!emailMsg; setEmailMsg(v); savePref("email_notifs",v); }}
          pushVal={pushMsg} onPushToggle={()=>{ const v=!pushMsg; setPushMsg(v); savePref("push_notifs",v); }} />
        <NotifRow label={t.notifExp||"Nouvelle dépense"} desc={t.notifExpDesc||"Email quand une dépense est ajoutée ou modifiée"}
          val={emailExp} onToggle={()=>{ const v=!emailExp; setEmailExp(v); savePref("email_expenses",v); }}
          pushVal={pushExp} onPushToggle={()=>{ const v=!pushExp; setPushExp(v); savePref("push_expenses",v); }} />
        <NotifRow label={t.notifVault||"Nouveau document (coffre)"} desc={t.notifVaultDesc||"Email quand un document est ajouté au coffre-fort"}
          val={emailVault} onToggle={()=>{ const v=!emailVault; setEmailVault(v); savePref("email_vault",v); }}
          pushVal={pushVault} onPushToggle={()=>{ const v=!pushVault; setPushVault(v); savePref("push_vault",v); }} />
        <NotifRow label={t.notifJoinRequest||"Demande à rejoindre"} desc={t.notifJoinRequestDesc||"Email quand un observateur ou un enfant rejoint la famille"}
          val={emailJoin} onToggle={()=>{ const v=!emailJoin; setEmailJoin(v); savePref("email_join_requests",v); }}
          pushVal={pushJoin} onPushToggle={()=>{ const v=!pushJoin; setPushJoin(v); savePref("push_join_requests",v); }} />
      </div>
```

- [ ] **Step 5: Extend the local `NotifRow` component to render two toggles side by side**

In `PrefsTab`, replace the local `NotifRow` definition (around line 6569-6579):
```js
  function NotifRow({label,desc,val,onToggle}){
    const row={display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 16px",background:C.sur,borderRadius:12,border:`1px solid ${C.bor}`,marginBottom:8};
    return (
      <div style={row}>
        <div style={{flex:1,marginRight:12}}>
          <div style={{fontSize:13,fontWeight:700,color:C.txt}}>{label}</div>
          <div style={{fontSize:11,color:C.mut,marginTop:2}}>{desc}</div>
        </div>
        <Toggle val={val} onToggle={onToggle} />
      </div>
    );
  }
```
with:
```js
  function NotifRow({label,desc,val,onToggle,pushVal,onPushToggle}){
    const row={display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 16px",background:C.sur,borderRadius:12,border:`1px solid ${C.bor}`,marginBottom:8,gap:12};
    return (
      <div style={row}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:700,color:C.txt}}>{label}</div>
          <div style={{fontSize:11,color:C.mut,marginTop:2}}>{desc}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
          <span style={{fontSize:10,color:C.mut}}>📧</span>
          <Toggle val={val} onToggle={onToggle} />
        </div>
        {onPushToggle && (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            <span style={{fontSize:10,color:C.mut}}>🔔</span>
            <Toggle val={pushVal} onToggle={onPushToggle} />
          </div>
        )}
      </div>
    );
  }
```
(`onPushToggle` is optional so this component still works with only an email toggle if ever reused elsewhere without change.)

- [ ] **Step 6: Add the push toggle to `ObserverPrefsTab`**

In `ObserverPrefsTab()` (around line 6865-6970), add the same pattern used for the parent tab but scoped to the single "message" row it already shows. Add state (near line 6868):
```js
  const [emailMsg, setEmailMsg] = useState(true);
  const [pushMsg,  setPushMsg]  = useState(true);
```
Destructure the context additions (near wherever `useApp()` is called in this component):
```js
  const {..., pushStatus, pushSubscribe, pushUnsubscribe} = useApp();
```
In the load effect (around line 6896), add:
```js
      setEmailMsg(m.email_notifs !== false);
      setPushMsg(m.push_notifs !== false);
```
Replace the "Notifications email" block (lines 6960-6970) with:
```jsx
      {/* ── Notifications push ── */}
      <div style={{marginBottom:16}}>
        <div className="sec">{t.pushSectionTitle||"🔔 Notifications push"}</div>
        {pushStatus==="unsupported" && <div style={{fontSize:12,color:C.mut,padding:"10px 12px"}}>{t.pushUnsupported}</div>}
        {pushStatus==="ios-needs-install" && <div style={{fontSize:12,color:C.mut,padding:"10px 12px"}}>{t.pushIosInstall}</div>}
        {pushStatus==="denied" && <div style={{fontSize:12,color:C.red,padding:"10px 12px"}}>{t.pushDenied}</div>}
        {pushStatus==="default" && (
          <button onClick={pushSubscribe} style={{width:"100%",padding:"13px 16px",background:C.vio,color:"#fff",border:"none",borderRadius:12,fontSize:13,fontWeight:700,cursor:"pointer"}}>
            {t.pushEnableBtn}
          </button>
        )}
        {pushStatus==="subscribed" && (
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 16px",background:C.sur,borderRadius:12,border:`1px solid ${C.bor}`}}>
            <div style={{fontSize:13,fontWeight:700,color:C.grn}}>{t.pushEnabledStatus}</div>
            <button onClick={pushUnsubscribe} style={{padding:"6px 12px",background:"transparent",color:C.mut,border:`1px solid ${C.bor}`,borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              {t.pushDisableBtn}
            </button>
          </div>
        )}
      </div>

      {/* ── Notifications email + push : messages uniquement ── */}
      <div style={{marginBottom:28}}>
        <div className="sec">{t.emailNotifs||"Notifications"}</div>
        <div style={{...row,gap:12}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,color:C.txt}}>{t.notifMsg||"Nouveau message reçu"}</div>
            <div style={{fontSize:11,color:C.mut,marginTop:2}}>{t.obsNotifMsgDesc||t.notifMsgDesc||"Email quand vous recevez un nouveau message"}</div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            <span style={{fontSize:10,color:C.mut}}>📧</span>
            <Toggle val={emailMsg} onToggle={()=>{ const v=!emailMsg; setEmailMsg(v); savePref("email_notifs",v); }} />
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            <span style={{fontSize:10,color:C.mut}}>🔔</span>
            <Toggle val={pushMsg} onToggle={()=>{ const v=!pushMsg; setPushMsg(v); savePref("push_notifs",v); }} />
          </div>
        </div>
      </div>
```

- [ ] **Step 7: Verify manually**

```bash
npm run build
```
Expected: succeeds with no errors.

Then run `npm run dev`, log in as a parent, open Préférences, and check:
- The push section shows the "Activer" button (or the iOS/denied message if applicable to your test browser).
- Clicking it triggers the browser's permission prompt, and on grant, the row switches to "✅ Activé sur cet appareil".
- All 4 rows show both a 📧 and a 🔔 toggle, independently clickable, each persisting (reload the page and confirm the state survives).
- Log in as an observer and confirm the single message row also shows both toggles.

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js
git commit -m "Add push activation UI and per-type push/email preference toggles"
```

---

### Task 12: Deployment checklist and end-to-end verification

**Files:** none (operational task — dashboard configuration + manual testing).

**Interfaces:** none — this is the final integration check tying Tasks 1-11 together.

- [ ] **Step 1: Confirm all secrets are set**

In the Supabase dashboard → Project Settings → Edge Functions → Secrets, confirm `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` are present (Task 1) alongside the pre-existing `RESEND_API_KEY`, `WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 2: Confirm the migration ran**

In the Supabase SQL Editor: `select * from public.push_subscriptions limit 1;` — expect an empty result with no error (table exists, RLS doesn't block the dashboard's elevated access).

- [ ] **Step 3: Deploy the client**

Push to `main` (or the relevant branch) so Vercel picks up the build with `VITE_VAPID_PUBLIC_KEY` set in its project env vars (confirm it's set there — Task 1, Step 2).

- [ ] **Step 4: Subscribe a real device**

On app.duvia.fr, log in, go to Préférences, click "Activer les notifications push sur cet appareil", grant the permission. Confirm a new row appears in `push_subscriptions` for that `user_id` (check via SQL Editor).

- [ ] **Step 5: Wire the Database Webhooks, one at a time, testing after each**

In the Supabase dashboard → Database → Webhooks, create (if not already existing for expenses) a webhook per table, each configured with:
- Table: `messages` / `vault_documents` / `family_members` (three new ones) — `expenses` should already exist for `notify-expense`.
- Events: `INSERT`.
- Type: HTTP Request → the corresponding Edge Function URL.
- HTTP Headers: `x-webhook-secret: <the same WEBHOOK_SECRET value>`.

After creating **each** webhook, immediately test it before creating the next:
1. `messages` → send a real message between two test accounts (one of which is the device subscribed in Step 4) → confirm push arrives when that device's app is fully closed, and confirm no duplicate notification appears when the app is open in a tab.
2. `vault_documents` → upload a document as the other test account → same check.
3. `family_members` → have a test observer/child join the family → same check, and confirm parents (not the joiner) receive it.
4. `expenses` (if not already wired from before this project) → add a test expense → same check.

- [ ] **Step 6: Confirm preference gating works**

Turn off the 🔔 toggle for one event type (e.g. expenses) in Préférences, trigger that event again, confirm no push arrives while email (if still on) still does. Turn off 📧 for the same type, confirm neither arrives. Re-enable both.

- [ ] **Step 7: Confirm the iOS path**

On an iPhone, open app.duvia.fr in Safari **without** adding it to the home screen — confirm the Préférences push section shows the "Ajoute Duvia à ton écran d'accueil…" message instead of the activation button. Add it to the home screen, reopen from there, confirm the activation button now appears and works.

- [ ] **Step 8: Report back to the user**

Summarize what was tested and what (if anything) didn't behave as expected, before considering this feature done.
