# Envoi automatique réel d'emails d'invitation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `mailto:`-based "Email" buttons on the parent/observer/child invite flows with a real server-sent email, and add the same real-send capability to the referral (parrainage) share modal, with server-side anti-abuse rate limiting.

**Architecture:** One new Edge Function `send-invite-email` (JWT-authenticated, no admin role required — each caller sends their own invitations), backed by a new `invite_email_log` table used purely for rate-limit bookkeeping (no RLS policies — only the Edge Function's service-role client touches it). The client already builds the exact subject/body text it uses today for `mailto:` (via i18n) and passes it as-is to the function, which just validates, rate-limits, wraps it in the same HTML email shell as `notify-rating`, and sends via Resend (key already exists as a shared project secret).

**Tech Stack:** Supabase Postgres migration, Deno Edge Function (`serve`, `@supabase/supabase-js@2`, `Resend` HTTP API), React (existing `App.jsx` patterns), i18n (`src/i18n/*.js`).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-19-real-invite-email-sending-design.md` — read it if anything below is ambiguous, it is the source of truth for rationale.
- Anti-abuse limits are exact: **10 sends per sender per rolling 24h** (all invite types combined), **3 sends per recipient email per rolling 7 days** (all invite types combined, case-insensitive).
- `recipient_email` is always stored **lowercased** by the Edge Function — this is an invariant enforced in code, not a DB constraint (single writer: the service-role client).
- No new automated tests are added for the Edge Function or the React component changes — this repo has no Edge Function test harness and no component-test infrastructure (confirmed: `node --test` only covers pure functions in `src/utils/core.js`). Verification after each task is: `TZ=Europe/Paris npm test` (regression on the existing pure-function suite — must stay 140/140 passing) + `npm run build` (compile check). This matches this repo's established convention for UI/Edge-Function work.
- Every invite type's subject/body is built **client-side** (via `t.xxx`, already localized in the sender's current UI language) and sent as plain parameters to the Edge Function — the function never contains any hardcoded language-specific copy for these emails.
- `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) are bumped **once**, in the final task, after every other task is complete and verified — not per intermediate task.
- The Edge Function is deployed by the user pasting the file into the Supabase dashboard (no CLI link to this repo, see CLAUDE.md) — the plan's final task must print the full file content for the user to copy, and state exactly where to paste it (Supabase dashboard → **Edge Functions** → create new function named exactly `send-invite-email` → paste → deploy → confirm `RESEND_API_KEY` secret is available, project-level secrets are shared across functions so it should already be there from `notify-bug-report`/`notify-rating`). The migration SQL must be run in the Supabase SQL Editor (production project) before this client code reaches users.

---

### Task 1: Migration — `invite_email_log` table

**Files:**
- Create: `supabase/migrations/0042_invite_email_log.sql`

**Interfaces:**
- Produces: table `invite_email_log(id uuid, sender_user_id uuid, recipient_email text, invite_type text, sent_at timestamptz)`, consumed by Task 2's Edge Function.

- [ ] **Step 1: Write the migration file**

```sql
-- 0042_invite_email_log.sql
--
-- Anti-abus pour l'envoi réel d'emails d'invitation (feature "envoi
-- automatique réel d'emails d'invitation", voir docs/superpowers/specs/
-- 2026-07-19-real-invite-email-sending-design.md). Ne dépend d'aucune autre
-- migration.
--
-- Aucune policy RLS créée volontairement : ni lecture ni écriture pour un
-- client normal (authenticated/anon) — seule la Edge Function
-- send-invite-email (service role, qui bypass RLS) lit/écrit cette table.
-- C'est la table qui fait foi pour les plafonds anti-abus : 10 envois par
-- compte par 24h glissantes (tous types confondus), et 3 envois vers la
-- même adresse par 7 jours glissants (tous types confondus).
--
-- 🔧 recipient_email est TOUJOURS stocké en minuscules par la Edge Function
-- (invariant appliqué en code, pas par une contrainte SQL — un seul
-- écrivain possible : le client service-role de la fonction).

create table invite_email_log (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null,
  invite_type text not null check (invite_type in ('parent','observer','child','referral')),
  sent_at timestamptz not null default now()
);

create index idx_invite_email_log_sender_sent on invite_email_log(sender_user_id, sent_at);
create index idx_invite_email_log_recipient_sent on invite_email_log(recipient_email, sent_at);

alter table invite_email_log enable row level security;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0042_invite_email_log.sql
git commit -m "Add invite_email_log migration for invite-email anti-abuse rate limiting

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Note: this migration must be run by the user in the Supabase SQL Editor (production project) before Task 2's function can work — flag this in the final task's deployment instructions, don't block subsequent tasks on it (the function code can be written and committed regardless).

---

### Task 2: Edge Function `send-invite-email`

**Files:**
- Create: `supabase/functions/send-invite-email/index.ts`

**Interfaces:**
- Consumes: table `invite_email_log` from Task 1.
- Produces: an HTTP endpoint invoked as `supabase.functions.invoke("send-invite-email", { body: { type, to, subject, body } })` where `type` is one of `"parent"|"observer"|"child"|"referral"`, `to` is the recipient email, `subject`/`body` are plain strings already localized by the client. Returns `{ok:true}` on success or `{error: "invalid_type"|"invalid_email"|"missing_content"|"daily_limit_reached"|"recipient_limit_reached"|"send_failed"|...}` with a matching HTTP status (400/401/429/500) on failure. Consumed by Task 4's `sendInviteEmail()` client helper.

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/send-invite-email/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL       = "notifications@duvia.fr";
const APP_URL          = "https://app.duvia.fr";

const DAILY_LIMIT_PER_SENDER = 10;
const WEEKLY_LIMIT_PER_RECIPIENT = 3;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TYPES = ["parent", "observer", "child", "referral"];

// 🔒 subject/body sont du texte déjà généré par l'app (via i18n), mais qui
// peut contenir un prénom saisi librement par l'utilisateur — jamais
// interpolé tel quel dans le HTML (même précaution que notify-bug-report /
// notify-rating).
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "bad_json" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 🔒 Appelant authentifié obligatoire — chacun envoie SES PROPRES
  // invitations, pas de vérification de rôle admin ici (contrairement à
  // admin-manage-subscriptions).
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "missing_authorization" }, 401);
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user?.id) return jsonResponse({ error: "invalid_token" }, 401);
  const senderId = callerData.user.id;

  const type = String(payload?.type || "");
  const to = String(payload?.to || "").trim().toLowerCase();
  const subject = String(payload?.subject || "").trim();
  const bodyText = String(payload?.body || "").trim();

  if (!VALID_TYPES.includes(type)) return jsonResponse({ error: "invalid_type" }, 400);
  if (!EMAIL_RE.test(to)) return jsonResponse({ error: "invalid_email" }, 400);
  if (!subject || !bodyText) return jsonResponse({ error: "missing_content" }, 400);

  // ── Anti-abus : appliqué AVANT l'envoi Resend, jamais après ────────────────
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: dailyCount, error: dailyErr } = await admin
    .from("invite_email_log")
    .select("*", { count: "exact", head: true })
    .eq("sender_user_id", senderId)
    .gte("sent_at", since24h);
  if (dailyErr) return jsonResponse({ error: dailyErr.message }, 500);
  if ((dailyCount || 0) >= DAILY_LIMIT_PER_SENDER) {
    return jsonResponse({ error: "daily_limit_reached" }, 429);
  }

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count: recipientCount, error: recipientErr } = await admin
    .from("invite_email_log")
    .select("*", { count: "exact", head: true })
    .eq("recipient_email", to)
    .gte("sent_at", since7d);
  if (recipientErr) return jsonResponse({ error: recipientErr.message }, 500);
  if ((recipientCount || 0) >= WEEKLY_LIMIT_PER_RECIPIENT) {
    return jsonResponse({ error: "recipient_limit_reached" }, 429);
  }

  // ── Email (même charte visuelle que notify-rating) ─────────────────────────
  const safeSubject = escapeHtml(subject);
  const safeBody = escapeHtml(bodyText).replace(/\n/g, "<br>");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="color:#fff;font-size:18px;font-weight:800">${safeSubject}</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#333;margin:0;line-height:1.6">${safeBody}</p>
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
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("send-invite-email: Resend error", errBody);
      return jsonResponse({ error: "send_failed" }, 500);
    }
  } catch (e) {
    console.error("send-invite-email: Resend send failed", e);
    return jsonResponse({ error: "send_failed" }, 500);
  }

  // Enregistré APRÈS un envoi réussi seulement — un échec Resend ne doit
  // jamais consommer le plafond anti-abus de l'utilisateur.
  await admin.from("invite_email_log").insert({
    sender_user_id: senderId,
    recipient_email: to,
    invite_type: type,
  });

  return jsonResponse({ ok: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/send-invite-email/index.ts
git commit -m "Add send-invite-email Edge Function with per-sender/per-recipient rate limiting

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: i18n keys (5 languages)

**Files:**
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js`

**Interfaces:**
- Produces: the following keys, consumed by Tasks 4-7:
  - `parentInviteEmailSubject`, `parentInviteEmailBody` (placeholder `{link}`)
  - `childInviteEmailSubject`, `childInviteEmailBody` (placeholders `{childName}`, `{link}`)
  - `observerInviteEmailSubject`, `observerInviteEmailBody` (placeholders `{parentName}`, `{link}`)
  - `inviteEmailSending`, `inviteEmailSent`, `inviteEmailErrorGeneric`, `inviteEmailErrorDailyLimit`, `inviteEmailErrorRecipientLimit`
  - `refSendEmailLabel`, `refSendEmailPlaceholder`, `refSendEmailBtn`, `refSendEmailSentMsg` (referral modal only — reuses `inviteEmailSending`/error keys, but needs its own label/placeholder/button text since it's a new field, not an existing button being repurposed)

- [ ] **Step 1: Add keys to `src/i18n/fr.js`**

Find the existing line (near `refShareEmailBody`):
```js
    refShareEmailBody:"Salut !\n\nJe t'invite sur Duvia, l'app qui simplifie la coparentalité.\n\nTélécharge l'app et crée ton compte via ce lien : {link}\n\nÀ bientôt sur Duvia !",
```
Add immediately after it:
```js
    refSendEmailLabel:"Ou envoyer directement à un email",
    refSendEmailPlaceholder:"email@exemple.fr",
    refSendEmailBtn:"Envoyer",
    refSendEmailSentMsg:"✅ Invitation envoyée !",
```

Find the existing line (near `sendInviteLink`):
```js
    sendInviteLink:"📨 Envoyer le lien d'invitation",
```
Add immediately after it:
```js
    parentInviteEmailSubject:"Rejoins notre famille sur Duvia 👨‍👩‍👧",
    parentInviteEmailBody:"Bonjour 👋\nTu es invité(e) à rejoindre une famille sur Duvia.\nCrée ton compte ici :\n{link}",
    childInviteEmailSubject:"Rejoins notre famille sur Duvia 👨‍👩‍👧",
    childInviteEmailBody:"Bonjour {childName} 👋\nRejoins notre famille sur Duvia !\nClique ici pour créer ton compte :\n{link}",
    observerInviteEmailSubject:"Rejoins notre famille sur Duvia 👨‍👩‍👧",
    observerInviteEmailBody:"Bonjour 👋\n{parentName} t'invite à rejoindre la famille sur Duvia en tant qu'observateur.\nCrée ton compte ici :\n{link}",
    inviteEmailSending:"Envoi…",
    inviteEmailSent:"✅ Email envoyé",
    inviteEmailErrorGeneric:"⚠️ Échec de l'envoi. Réessaie.",
    inviteEmailErrorDailyLimit:"⚠️ Trop d'invitations envoyées aujourd'hui. Réessaie demain.",
    inviteEmailErrorRecipientLimit:"⚠️ Trop d'invitations envoyées à cette adresse récemment. Réessaie plus tard.",
```

- [ ] **Step 2: Add keys to `src/i18n/en.js`**

Same anchors (`refShareEmailBody` line, `sendInviteLink` line), English translations:
```js
    refSendEmailLabel:"Or send directly to an email",
    refSendEmailPlaceholder:"email@example.com",
    refSendEmailBtn:"Send",
    refSendEmailSentMsg:"✅ Invitation sent!",
```
```js
    parentInviteEmailSubject:"Join our family on Duvia 👨‍👩‍👧",
    parentInviteEmailBody:"Hello 👋\nYou're invited to join a family on Duvia.\nCreate your account here:\n{link}",
    childInviteEmailSubject:"Join our family on Duvia 👨‍👩‍👧",
    childInviteEmailBody:"Hello {childName} 👋\nJoin our family on Duvia!\nClick here to create your account:\n{link}",
    observerInviteEmailSubject:"Join our family on Duvia 👨‍👩‍👧",
    observerInviteEmailBody:"Hello 👋\n{parentName} is inviting you to join the family on Duvia as an observer.\nCreate your account here:\n{link}",
    inviteEmailSending:"Sending…",
    inviteEmailSent:"✅ Email sent",
    inviteEmailErrorGeneric:"⚠️ Sending failed. Try again.",
    inviteEmailErrorDailyLimit:"⚠️ Too many invitations sent today. Try again tomorrow.",
    inviteEmailErrorRecipientLimit:"⚠️ Too many invitations sent to this address recently. Try again later.",
```

- [ ] **Step 3: Add keys to `src/i18n/de.js`**

```js
    refSendEmailLabel:"Oder direkt an eine E-Mail senden",
    refSendEmailPlaceholder:"email@beispiel.de",
    refSendEmailBtn:"Senden",
    refSendEmailSentMsg:"✅ Einladung gesendet!",
```
```js
    parentInviteEmailSubject:"Tritt unserer Familie auf Duvia bei 👨‍👩‍👧",
    parentInviteEmailBody:"Hallo 👋\nDu bist eingeladen, einer Familie auf Duvia beizutreten.\nErstelle hier dein Konto:\n{link}",
    childInviteEmailSubject:"Tritt unserer Familie auf Duvia bei 👨‍👩‍👧",
    childInviteEmailBody:"Hallo {childName} 👋\nTritt unserer Familie auf Duvia bei!\nKlicke hier, um dein Konto zu erstellen:\n{link}",
    observerInviteEmailSubject:"Tritt unserer Familie auf Duvia bei 👨‍👩‍👧",
    observerInviteEmailBody:"Hallo 👋\n{parentName} lädt dich ein, der Familie auf Duvia als Beobachter beizutreten.\nErstelle hier dein Konto:\n{link}",
    inviteEmailSending:"Wird gesendet…",
    inviteEmailSent:"✅ E-Mail gesendet",
    inviteEmailErrorGeneric:"⚠️ Senden fehlgeschlagen. Versuche es erneut.",
    inviteEmailErrorDailyLimit:"⚠️ Zu viele Einladungen heute gesendet. Versuche es morgen erneut.",
    inviteEmailErrorRecipientLimit:"⚠️ Zu viele Einladungen kürzlich an diese Adresse gesendet. Versuche es später erneut.",
```

- [ ] **Step 4: Add keys to `src/i18n/es.js`**

```js
    refSendEmailLabel:"O enviar directamente a un email",
    refSendEmailPlaceholder:"email@ejemplo.es",
    refSendEmailBtn:"Enviar",
    refSendEmailSentMsg:"✅ ¡Invitación enviada!",
```
```js
    parentInviteEmailSubject:"Únete a nuestra familia en Duvia 👨‍👩‍👧",
    parentInviteEmailBody:"Hola 👋\nEstás invitado/a a unirte a una familia en Duvia.\nCrea tu cuenta aquí:\n{link}",
    childInviteEmailSubject:"Únete a nuestra familia en Duvia 👨‍👩‍👧",
    childInviteEmailBody:"Hola {childName} 👋\n¡Únete a nuestra familia en Duvia!\nHaz clic aquí para crear tu cuenta:\n{link}",
    observerInviteEmailSubject:"Únete a nuestra familia en Duvia 👨‍👩‍👧",
    observerInviteEmailBody:"Hola 👋\n{parentName} te invita a unirte a la familia en Duvia como observador/a.\nCrea tu cuenta aquí:\n{link}",
    inviteEmailSending:"Enviando…",
    inviteEmailSent:"✅ Email enviado",
    inviteEmailErrorGeneric:"⚠️ Error al enviar. Inténtalo de nuevo.",
    inviteEmailErrorDailyLimit:"⚠️ Demasiadas invitaciones enviadas hoy. Inténtalo mañana.",
    inviteEmailErrorRecipientLimit:"⚠️ Demasiadas invitaciones enviadas a esta dirección recientemente. Inténtalo más tarde.",
```

- [ ] **Step 5: Add keys to `src/i18n/pt.js`**

```js
    refSendEmailLabel:"Ou enviar diretamente para um email",
    refSendEmailPlaceholder:"email@exemplo.pt",
    refSendEmailBtn:"Enviar",
    refSendEmailSentMsg:"✅ Convite enviado!",
```
```js
    parentInviteEmailSubject:"Junte-se à nossa família no Duvia 👨‍👩‍👧",
    parentInviteEmailBody:"Olá 👋\nVocê está convidado(a) a se juntar a uma família no Duvia.\nCrie sua conta aqui:\n{link}",
    childInviteEmailSubject:"Junte-se à nossa família no Duvia 👨‍👩‍👧",
    childInviteEmailBody:"Olá {childName} 👋\nJunte-se à nossa família no Duvia!\nClique aqui para criar sua conta:\n{link}",
    observerInviteEmailSubject:"Junte-se à nossa família no Duvia 👨‍👩‍👧",
    observerInviteEmailBody:"Olá 👋\n{parentName} convida você para se juntar à família no Duvia como observador(a).\nCrie sua conta aqui:\n{link}",
    inviteEmailSending:"Enviando…",
    inviteEmailSent:"✅ Email enviado",
    inviteEmailErrorGeneric:"⚠️ Falha no envio. Tente novamente.",
    inviteEmailErrorDailyLimit:"⚠️ Muitos convites enviados hoje. Tente novamente amanhã.",
    inviteEmailErrorRecipientLimit:"⚠️ Muitos convites enviados para este endereço recentemente. Tente novamente mais tarde.",
```

- [ ] **Step 6: Verify build still compiles (no syntax error in the i18n files)**

Run: `npm run build`
Expected: builds clean, same as before (no test covers i18n file syntax directly, but a broken object literal would fail the build).

- [ ] **Step 7: Commit**

```bash
git add src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js
git commit -m "Add i18n keys for real invite-email sending (all 5 languages)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Shared helper + `ParentInviteShareBtns` real send

**Files:**
- Modify: `src/App.jsx:~9732` (`ParentInviteShareBtns`, add a module-level helper right before it)

**Interfaces:**
- Consumes: Task 2's `send-invite-email` function, Task 3's i18n keys.
- Produces: module-level function `sendInviteEmail({type, to, subject, body}) => Promise<{ok:boolean, error?:"daily"|"recipient"|"generic"}>`, consumed by Tasks 5, 6, 7.

- [ ] **Step 1: Add the shared helper and rewrite `ParentInviteShareBtns`**

Find:
```jsx
// ─── PARENT INVITE SHARE BUTTONS ─────────────────────────────────────────────
function ParentInviteShareBtns({ C, parent, familyName }) {
  const { t } = useApp();
  const msg = `Bonjour 👋\n${familyName} t'invite à rejoindre la famille sur Duvia.\nCrée ton compte ici :\n${parent.inviteUrl}`;

  function handleEmail() {
    const subject = encodeURIComponent(`Rejoins notre famille sur Duvia 👨‍👩‍👧`);
    const href = `mailto:${parent.inviteEmail||""}?subject=${subject}&body=${encodeURIComponent(msg)}`;
    const a = document.createElement("a");
    a.href = href;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.bor}`}}>
      <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:8}}>
        {t.sendInviteLink}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button onClick={handleEmail} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
          background:`${C.vio}12`,color:C.vio,border:`1.5px solid ${C.vio}44`,
        }}>✉️ Email</button>
      </div>
    </div>
  );
}
```

Replace with:
```jsx
// ─── ENVOI RÉEL D'EMAIL D'INVITATION (parent/observateur/enfant/parrainage) ──
// Helper partagé — voir docs/superpowers/specs/2026-07-19-real-invite-email-sending-design.md.
// Le sujet/corps sont déjà construits côté client (via t.xxx, dans la langue
// actuelle de l'expéditeur) — la fonction serveur ne fait qu'valider/anti-abus/
// envoyer, jamais de traduction côté serveur.
async function sendInviteEmail({ type, to, subject, body }) {
  try {
    const { data, error } = await supabase.functions.invoke("send-invite-email", { body: { type, to, subject, body } });
    if (error) return { ok: false, error: "generic" };
    if (data?.error === "daily_limit_reached") return { ok: false, error: "daily" };
    if (data?.error === "recipient_limit_reached") return { ok: false, error: "recipient" };
    if (data?.error) return { ok: false, error: "generic" };
    return { ok: true };
  } catch {
    return { ok: false, error: "generic" };
  }
}

function inviteEmailErrorMessage(t, errCode) {
  if (errCode === "daily") return t.inviteEmailErrorDailyLimit || "⚠️ Trop d'invitations envoyées aujourd'hui. Réessaie demain.";
  if (errCode === "recipient") return t.inviteEmailErrorRecipientLimit || "⚠️ Trop d'invitations envoyées à cette adresse récemment. Réessaie plus tard.";
  return t.inviteEmailErrorGeneric || "⚠️ Échec de l'envoi. Réessaie.";
}

// ─── PARENT INVITE SHARE BUTTONS ─────────────────────────────────────────────
function ParentInviteShareBtns({ C, parent, familyName }) {
  const { t } = useApp();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  async function handleEmail() {
    setSending(true); setErr(""); setSent(false);
    const link = parent.inviteUrl || "";
    const subject = (t.parentInviteEmailSubject || "Rejoins notre famille sur Duvia 👨‍👩‍👧");
    const body = (t.parentInviteEmailBody || "Bonjour 👋\nTu es invité(e) à rejoindre une famille sur Duvia.\nCrée ton compte ici :\n{link}").replace("{link}", link);
    const res = await sendInviteEmail({ type: "parent", to: parent.inviteEmail || "", subject, body });
    setSending(false);
    if (res.ok) setSent(true);
    else setErr(inviteEmailErrorMessage(t, res.error));
  }

  return (
    <div style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.bor}`}}>
      <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:8}}>
        {t.sendInviteLink}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button onClick={handleEmail} disabled={sending} style={{
          padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:sending?"wait":"pointer",
          background:`${C.vio}12`,color:C.vio,border:`1.5px solid ${C.vio}44`,
        }}>{sending ? `⏳ ${t.inviteEmailSending||"Envoi…"}` : sent ? `${t.inviteEmailSent||"✅ Email envoyé"}` : "✉️ Email"}</button>
      </div>
      {err && <div style={{fontSize:11,color:C.red,marginTop:6}}>{err}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Run the existing test suite (regression check)**

Run: `TZ=Europe/Paris npm test`
Expected: 140/140 pass (this task doesn't touch `src/utils/core.js`, so the count and results should be unchanged).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "Send real parent-invite emails via send-invite-email instead of mailto:

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `ChildInviteBtn` real send

**Files:**
- Modify: `src/App.jsx:~9835` (`ChildInviteBtn`'s `handleEmail`)

**Interfaces:**
- Consumes: `sendInviteEmail()` and `inviteEmailErrorMessage()` from Task 4 (module-level, already in scope — no import needed, same file).

- [ ] **Step 1: Rewrite `handleEmail` and add sending/sent/err state**

Find (near the top of `ChildInviteBtn`, alongside its other `useState` declarations):
```jsx
  const [inviteUrl, setInviteUrl] = useState("");
  const [loading, setLoading]     = useState(false);
  const [copied, setCopied]       = useState(false);
  const [errMsg, setErrMsg]       = useState("");
```
Replace with:
```jsx
  const [inviteUrl, setInviteUrl] = useState("");
  const [loading, setLoading]     = useState(false);
  const [copied, setCopied]       = useState(false);
  const [errMsg, setErrMsg]       = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent]       = useState(false);
  const [emailErr, setEmailErr]         = useState("");
```

Find:
```jsx
  async function handleEmail() {
    const url = await getOrGenUrl(); if (!url) return;
    const subject = encodeURIComponent(`Rejoins notre famille sur Duvia 👨‍👩‍👧`);
    const to = childEmail ? encodeURIComponent(childEmail) : "";
    window.open(`mailto:${to}?subject=${subject}&body=${encodeURIComponent(msgText(url))}`, "_blank");
  }
```
Replace with:
```jsx
  async function handleEmail() {
    const url = await getOrGenUrl(); if (!url) return;
    if (!childEmail) return;
    setEmailSending(true); setEmailErr(""); setEmailSent(false);
    const subject = (t.childInviteEmailSubject || "Rejoins notre famille sur Duvia 👨‍👩‍👧");
    const body = (t.childInviteEmailBody || "Bonjour {childName} 👋\nRejoins notre famille sur Duvia !\nClique ici pour créer ton compte :\n{link}")
      .replace("{childName}", childName || "").replace("{link}", url);
    const res = await sendInviteEmail({ type: "child", to: childEmail, subject, body });
    setEmailSending(false);
    if (res.ok) setEmailSent(true);
    else setEmailErr(inviteEmailErrorMessage(t, res.error));
  }
```

- [ ] **Step 2: Update the Email button's render and add the error line**

Find:
```jsx
            <button onClick={handleEmail} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",background:`${C.vio}18`,color:C.vio,border:`1.5px solid ${C.vio}44`}}>✉️ Email</button>
            <button onClick={handleCopy} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",background:copied?`${C.grn}18`:C.sur,color:copied?C.grn:C.mut,border:`1.5px solid ${C.bor}`}}>
              {copied ? "✅ Copié !" : "📋 Copier"}
            </button>
          </div>
          <button onClick={()=>setInviteUrl("")} style={{fontSize:11,color:C.mut,background:"none",border:"none",cursor:"pointer",textDecoration:"underline",padding:0}}>↩️ Regénérer un lien</button>
        </>
      )}
    </div>
  );
}
```
Replace with:
```jsx
            <button onClick={handleEmail} disabled={emailSending || !childEmail} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:(emailSending||!childEmail)?"not-allowed":"pointer",opacity:childEmail?1:.4,background:`${C.vio}18`,color:C.vio,border:`1.5px solid ${C.vio}44`}}>
              {emailSending ? `⏳ ${t.inviteEmailSending||"Envoi…"}` : emailSent ? (t.inviteEmailSent||"✅ Email envoyé") : "✉️ Email"}
            </button>
            <button onClick={handleCopy} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",background:copied?`${C.grn}18`:C.sur,color:copied?C.grn:C.mut,border:`1.5px solid ${C.bor}`}}>
              {copied ? "✅ Copié !" : "📋 Copier"}
            </button>
          </div>
          {emailErr && <div style={{fontSize:11,color:C.red,marginBottom:6}}>{emailErr}</div>}
          <button onClick={()=>setInviteUrl("")} style={{fontSize:11,color:C.mut,background:"none",border:"none",cursor:"pointer",textDecoration:"underline",padding:0}}>↩️ Regénérer un lien</button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run the existing test suite (regression check)**

Run: `TZ=Europe/Paris npm test`
Expected: 140/140 pass.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "Send real child-invite emails via send-invite-email instead of mailto:

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `StepAccess` (observer invite) real send

**Files:**
- Modify: `src/App.jsx:~11213` (`StepAccess`'s `handleSendEmail`)

**Interfaces:**
- Consumes: `sendInviteEmail()` and `inviteEmailErrorMessage()` from Task 4.

- [ ] **Step 1: Add sending/sent/err state**

Find (near `StepAccess`'s other `useState` declarations, alongside `genLoading`/`genErr`):
```jsx
  const [genLoading, setGenLoading] = useState(false);
  const [genErr, setGenErr]         = useState("");
```
Replace with:
```jsx
  const [genLoading, setGenLoading] = useState(false);
  const [genErr, setGenErr]         = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent]       = useState(false);
  const [emailErr, setEmailErr]         = useState("");
```

- [ ] **Step 2: Rewrite `handleSendEmail`**

Find:
```jsx
  function handleSendEmail(){
    if(!sent) return;
    const subject = encodeURIComponent("Rejoins notre famille sur Duvia 👨‍👩‍👧");
    const body    = encodeURIComponent(inviteMsg(sent));
    const a = document.createElement("a");
    a.href = `mailto:${email||""}?subject=${subject}&body=${body}`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
```
Replace with:
```jsx
  async function handleSendEmail(){
    if(!sent || !email) return;
    setEmailSending(true); setEmailErr(""); setEmailSent(false);
    const subject = (t.observerInviteEmailSubject || "Rejoins notre famille sur Duvia 👨‍👩‍👧");
    const body = (t.observerInviteEmailBody || "Bonjour 👋\n{parentName} t'invite à rejoindre la famille sur Duvia en tant qu'observateur.\nCrée ton compte ici :\n{link}")
      .replace("{parentName}", (cfg.parents?.[0]?.name)||"").replace("{link}", sent);
    const res = await sendInviteEmail({ type: "observer", to: email, subject, body });
    setEmailSending(false);
    if (res.ok) setEmailSent(true);
    else setEmailErr(inviteEmailErrorMessage(t, res.error));
  }
```

- [ ] **Step 3: Update the Email button's render and add the error line**

Find:
```jsx
                <button onClick={handleSendEmail} disabled={!o.email} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:o.email?"pointer":"not-allowed",opacity:o.email?1:.4,background:`${C.vio}18`,color:C.vio,border:`1.5px solid ${C.vio}44`}}>✉️ Email</button>
                <button onClick={copyInvite} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",background:copied?`${C.grn}18`:C.sur,color:copied?C.grn:C.mut,border:`1.5px solid ${C.bor}`}}>
                  {copied ? `✅ ${t.copied||"Copié"} !` : `📋 ${t.copy||"Copier"}`}
                </button>
              </div>
            </div>
          )}
```
Replace with:
```jsx
                <button onClick={handleSendEmail} disabled={!o.email || emailSending} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:(o.email&&!emailSending)?"pointer":"not-allowed",opacity:o.email?1:.4,background:`${C.vio}18`,color:C.vio,border:`1.5px solid ${C.vio}44`}}>
                  {emailSending ? `⏳ ${t.inviteEmailSending||"Envoi…"}` : emailSent ? (t.inviteEmailSent||"✅ Email envoyé") : "✉️ Email"}
                </button>
                <button onClick={copyInvite} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",background:copied?`${C.grn}18`:C.sur,color:copied?C.grn:C.mut,border:`1.5px solid ${C.bor}`}}>
                  {copied ? `✅ ${t.copied||"Copié"} !` : `📋 ${t.copy||"Copier"}`}
                </button>
              </div>
              {emailErr && <div style={{fontSize:11,color:C.red,marginTop:8}}>{emailErr}</div>}
            </div>
          )}
```

- [ ] **Step 4: Run the existing test suite (regression check)**

Run: `TZ=Europe/Paris npm test`
Expected: 140/140 pass.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Send real observer-invite emails via send-invite-email instead of mailto:

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `ParrainageSection` — email field + real send

**Files:**
- Modify: `src/App.jsx:~15085` (`ParrainageSection`, the `showInvite` modal)

**Interfaces:**
- Consumes: `sendInviteEmail()` and `inviteEmailErrorMessage()` from Task 4, `t.refSendEmailLabel`/`refSendEmailPlaceholder`/`refSendEmailBtn`/`refSendEmailSentMsg` from Task 3.

- [ ] **Step 1: Add state for the new email field**

Find (near `ParrainageSection`'s other `useState` declarations):
```jsx
  const [copiedLink,setCopiedLink] = useState(false);
  const [showInvite,setShowInvite] = useState(false);
  const [showDemo,setShowDemo]     = useState(false);
  const [demoStep,setDemoStep]     = useState(0);
```
Replace with:
```jsx
  const [copiedLink,setCopiedLink] = useState(false);
  const [showInvite,setShowInvite] = useState(false);
  const [showDemo,setShowDemo]     = useState(false);
  const [demoStep,setDemoStep]     = useState(0);
  const [refSendEmail,setRefSendEmail] = useState("");
  const [refSending,setRefSending]     = useState(false);
  const [refSent,setRefSent]           = useState(false);
  const [refSendErr,setRefSendErr]     = useState("");
```

- [ ] **Step 2: Add the `sendReferralEmail` handler**

Find:
```jsx
  function shareViaSMS(){
    const body=encodeURIComponent((t.refShareSmsBody||"Rejoins-moi sur Duvia 🏡 {link}").replace("{link}",inviteLink));
    window.open(`sms:?body=${body}`);
  }
```
Replace with:
```jsx
  function shareViaSMS(){
    const body=encodeURIComponent((t.refShareSmsBody||"Rejoins-moi sur Duvia 🏡 {link}").replace("{link}",inviteLink));
    window.open(`sms:?body=${body}`);
  }
  async function sendReferralEmail(){
    if(!refSendEmail.trim() || !isValidEmail(refSendEmail.trim())) return;
    setRefSending(true); setRefSendErr(""); setRefSent(false);
    const subject = (t.refShareEmailSubject||"Rejoins-moi sur Duvia 🏡");
    const body = (t.refShareEmailBody||"Salut !\n\nJe t'invite sur Duvia, l'app qui simplifie la coparentalité.\n\nTélécharge l'app et crée ton compte via ce lien : {link}\n\nÀ bientôt sur Duvia !").replace("{link}",inviteLink);
    const res = await sendInviteEmail({ type: "referral", to: refSendEmail.trim(), subject, body });
    setRefSending(false);
    if (res.ok) { setRefSent(true); setRefSendEmail(""); }
    else setRefSendErr(inviteEmailErrorMessage(t, res.error));
  }
```

- [ ] **Step 3: Add the email field + button to the invite modal**

Find:
```jsx
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
              {[
                {icon:copiedLink?"✅":"📋", label:copiedLink?(t.refCopied||"Copié !"):(t.refCopyLinkBtn||"Copier le lien"), action:copyLink, active:copiedLink},
                {icon:"✉️", label:t.refByEmail||"Par e-mail", action:shareViaEmail, active:false},
                {icon:"💬", label:t.refBySms||"Par SMS",    action:shareViaSMS,   active:false},
              ].map((btn,i)=>(
                <button key={i} onClick={btn.action} style={{padding:"12px 6px",background:btn.active?`${C.grn}15`:C.sur,color:btn.active?C.grn:C.txt,border:`1.5px solid ${btn.active?C.grn:C.bor}`,borderRadius:12,fontSize:12,fontWeight:700,display:"flex",flexDirection:"column",alignItems:"center",gap:4,cursor:"pointer"}}>
                  <span style={{fontSize:22}}>{btn.icon}</span>
                  {btn.label}
                </button>
              ))}
            </div>
            <button onClick={()=>setShowInvite(false)} style={{width:"100%",padding:12,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontSize:14,fontWeight:700,cursor:"pointer"}}>
              {t.refCloseBtn||"Fermer"}
            </button>
```
Replace with:
```jsx
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
              {[
                {icon:copiedLink?"✅":"📋", label:copiedLink?(t.refCopied||"Copié !"):(t.refCopyLinkBtn||"Copier le lien"), action:copyLink, active:copiedLink},
                {icon:"✉️", label:t.refByEmail||"Par e-mail", action:shareViaEmail, active:false},
                {icon:"💬", label:t.refBySms||"Par SMS",    action:shareViaSMS,   active:false},
              ].map((btn,i)=>(
                <button key={i} onClick={btn.action} style={{padding:"12px 6px",background:btn.active?`${C.grn}15`:C.sur,color:btn.active?C.grn:C.txt,border:`1.5px solid ${btn.active?C.grn:C.bor}`,borderRadius:12,fontSize:12,fontWeight:700,display:"flex",flexDirection:"column",alignItems:"center",gap:4,cursor:"pointer"}}>
                  <span style={{fontSize:22}}>{btn.icon}</span>
                  {btn.label}
                </button>
              ))}
            </div>
            <div style={{marginBottom:14,paddingTop:14,borderTop:`1px solid ${C.bor}`}}>
              <div style={{fontSize:11,fontWeight:700,color:C.mut,marginBottom:8}}>{t.refSendEmailLabel||"Ou envoyer directement à un email"}</div>
              <div style={{display:"flex",gap:8}}>
                <input type="email" value={refSendEmail} onChange={e=>{setRefSendEmail(e.target.value);setRefSent(false);setRefSendErr("");}}
                  placeholder={t.refSendEmailPlaceholder||"email@exemple.fr"}
                  style={{flex:1,height:40,padding:"0 12px",borderRadius:10,border:`1.5px solid ${C.bor}`,fontSize:13,background:C.sur,color:C.txt}} />
                <button onClick={sendReferralEmail} disabled={refSending || !refSendEmail.trim() || !isValidEmail(refSendEmail.trim())}
                  style={{height:40,padding:"0 16px",borderRadius:10,border:"none",fontSize:13,fontWeight:700,
                    cursor:(refSending||!refSendEmail.trim()||!isValidEmail(refSendEmail.trim()))?"not-allowed":"pointer",
                    background:(refSending||!refSendEmail.trim()||!isValidEmail(refSendEmail.trim()))?C.bor:`linear-gradient(135deg,${C.vio},${C.pin})`,
                    color:"#fff"}}>
                  {refSending ? (t.inviteEmailSending||"Envoi…") : (t.refSendEmailBtn||"Envoyer")}
                </button>
              </div>
              {refSent && <div style={{fontSize:11,color:C.grn,marginTop:6}}>{t.refSendEmailSentMsg||"✅ Invitation envoyée !"}</div>}
              {refSendErr && <div style={{fontSize:11,color:C.red,marginTop:6}}>{refSendErr}</div>}
            </div>
            <button onClick={()=>setShowInvite(false)} style={{width:"100%",padding:12,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:12,fontSize:14,fontWeight:700,cursor:"pointer"}}>
              {t.refCloseBtn||"Fermer"}
            </button>
```

- [ ] **Step 4: Run the existing test suite (regression check)**

Run: `TZ=Europe/Paris npm test`
Expected: 140/140 pass.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Add email field to referral share modal, sent via send-invite-email

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Version bump and final verification

**Files:**
- Modify: `src/config.js` (`APP_VERSION`)
- Modify: `public/sw.js` (`SW_VERSION`)

**Interfaces:**
- Consumes: nothing new — final integration check across all previous tasks.

- [ ] **Step 1: Bump both version constants together**

In `src/config.js`, find the current `APP_VERSION` line and increment by one `0.01` step (check the current value first with `grep APP_VERSION src/config.js` — do not assume it's still `2.59`, other work may have shipped since this plan was written).

In `public/sw.js`, find the current `SW_VERSION` line and set it to the exact same new value.

- [ ] **Step 2: Full regression run**

Run: `TZ=Europe/Paris npm test`
Expected: 140/140 pass.

Run: `npm run build`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add src/config.js public/sw.js
git commit -m "Bump version for real invite-email sending feature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Print deployment instructions for the user**

⚠️ **Updated during Task 2's fix round**: a second migration (`0043_check_and_log_invite_email.sql`) was added mid-development to close a TOCTOU race in the rate-limiting logic — the deployed function calls this RPC and does not work without it. This step's original 2-item list (written before that fix) is wrong if followed literally; use this corrected 3-item list instead.

This feature needs 3 manual steps outside this repo before it works in production, **in this exact order** (0043 depends on 0042's table; the function depends on 0043's RPC existing):
1. Run `supabase/migrations/0042_invite_email_log.sql` in the Supabase SQL Editor (production project).
2. Run `supabase/migrations/0043_check_and_log_invite_email.sql` in the same SQL Editor.
3. Create a new Edge Function named exactly `send-invite-email` in the Supabase dashboard (Edge Functions → Create a new function), paste the full contents of `supabase/functions/send-invite-email/index.ts` (written in Task 2, revised in its fix rounds), deploy. Confirm `RESEND_API_KEY` is available to it (project-level secret, shared with `notify-bug-report`/`notify-rating` — should already be there).

Print the full current contents of all three files (both migrations + function) in the final report so the user can copy-paste them directly, per this project's standing convention for Edge Function deployment instructions.

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage**: architecture ✅ (Task 2), anti-abuse table+limits ✅ (Tasks 1, 2), all 4 email content types ✅ (Task 3), all 4 client call sites ✅ (Tasks 4-7), version bump ✅ (Task 8). No spec section left uncovered.
- **Placeholder scan**: no TBD/TODO; every step has literal code, not a description of code.
- **Type consistency**: `sendInviteEmail({type, to, subject, body})` signature and its `{ok, error}` return shape are identical across Tasks 4-7. `inviteEmailErrorMessage(t, errCode)` signature identical everywhere it's called.
