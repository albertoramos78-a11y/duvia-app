# Notification email à chaque signalement de bug — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send an email to `duvia.services@gmail.com` automatically whenever a user submits a bug report, without touching any client-side code.

**Architecture:** A new Supabase Edge Function `notify-bug-report`, modeled on the existing `notify-new-device-login` function's Resend-email pattern, is triggered by a Supabase Database Webhook (dashboard-configured, not committed as code) on `INSERT` into `public.bug_reports`. The function reads the inserted row from the webhook payload, builds an email with the report's key fields (excluding the screenshot and raw logs), and sends it via Resend. A shared-secret HTTP header replaces the per-caller identity check used by other notify-* functions, since this function is called by Supabase's own webhook infrastructure, not by an authenticated app user.

**Tech Stack:** Deno (`Deno.serve`), Resend HTTP API, Supabase Database Webhooks (dashboard-configured).

## Global Constraints

- New file path: exactly `supabase/functions/notify-bug-report/index.ts`.
- Shared-secret header name: exactly `x-webhook-secret`. Environment variable name: exactly `BUG_REPORT_WEBHOOK_SECRET`.
- Fixed recipient: exactly `duvia.services@gmail.com`.
- Email subject: exactly `🐛 Nouveau bug signalé sur Duvia`.
- Email body must include: `record.comment`, `record.app_version`, `record.system?.platform`, `record.system?.userAgent`, `record.user_id` (fallback `"non connecté"` if null/absent), `record.family_id` (fallback `"aucune famille"` if null/absent), `record.id`.
- Email body must NOT include: `record.screenshot`, `record.logs`, `record.errors`.
- No version bump for this task — no `App.jsx`/`src/config.js`/`public/sw.js` change at all, per the spec (this deviates from every other plan this session, which all bumped `APP_VERSION`/`SW_VERSION`; do not add that step here).
- No automated test applies — this is a Deno Edge Function deployed via the Supabase dashboard, outside the `npm test` suite.

---

### Task 1: `notify-bug-report` Edge Function + CLAUDE.md update

**Files:**
- Create: `supabase/functions/notify-bug-report/index.ts`
- Modify: `CLAUDE.md:37` (Edge Functions list) and `CLAUDE.md:51` (append one sentence near the `pg_cron` mention)

**Interfaces:**
- Consumes: nothing from other tasks — this is the only task in this plan. Reads the existing `bug_reports` table's row shape (columns: `id`, `created_at`, `user_id`, `family_id`, `app_version`, `comment`, `system` (jsonb: at least `platform`, `userAgent`), `app_state`, `logs`, `errors`, `screenshot` — see `src/services/diagnostics.js:143-156` for the exact shape `buildReport()` produces, which is what gets inserted).
- Produces: nothing consumed elsewhere — deployment (pasting into the Supabase dashboard, creating the Database Webhook) happens manually after this task, guided step-by-step outside this plan.

- [ ] **Step 1: Read the template file**

Read `supabase/functions/notify-new-device-login/index.ts` in full. It is the template for CORS headers, the `Deno.serve` structure, and the Resend `fetch` call shape. Note its constants block:

```ts
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
```

and its Resend call shape:

```ts
const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${RESEND_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from: `Duvia <${FROM_EMAIL}>`,
    to: [email],
    subject: "...",
    html,
  }),
});
const resBody = await res.json();
console.log("...: Resend response:", JSON.stringify(resBody));
```

This task's function reuses this exact structure but does NOT need `SUPABASE_URL`/`SERVICE_ROLE_KEY`/`createClient` at all — this function never queries the database (everything it needs arrives in the webhook payload), unlike `notify-new-device-login` which calls `admin.auth.getUser(token)`.

- [ ] **Step 2: Write `supabase/functions/notify-bug-report/index.ts`**

Create the file with exactly this content:

```ts
// supabase/functions/notify-bug-report/index.ts — syntaxe Deno.serve (moderne)
// ─────────────────────────────────────────────────────────────────────────────
// Déclenchée par un Database Webhook Supabase (Database → Webhooks, configuré
// dans le tableau de bord, PAS dans ce dépôt) sur INSERT dans `bug_reports`.
// Contrairement aux autres fonctions notify-*, elle n'est pas appelée par le
// client juste après l'action — elle part automatiquement côté serveur dès
// qu'une ligne est insérée, même si l'onglet du navigateur qui a soumis le
// rapport se ferme immédiatement après. Envoie un email de synthèse (sans la
// capture d'écran ni les logs bruts, trop volumineux) à une adresse fixe.
// ─────────────────────────────────────────────────────────────────────────────

const RESEND_API_KEY        = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET         = Deno.env.get("BUG_REPORT_WEBHOOK_SECRET")!;
const APP_URL                = "https://app.duvia.fr";
const FROM_EMAIL             = "notifications@duvia.fr";
const ADMIN_EMAIL            = "duvia.services@gmail.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  // 🔒 Seul le Database Webhook Supabase (configuré avec ce secret en en-tête)
  // peut déclencher l'envoi — sans ça, n'importe qui connaissant l'URL de la
  // fonction pourrait faire partir de faux emails.
  const providedSecret = req.headers.get("x-webhook-secret") || "";
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 401, headers: CORS });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: CORS });
  }

  const record = payload?.record;
  if (!record) {
    return new Response("Missing record", { status: 400, headers: CORS });
  }

  const comment    = record.comment || "(aucun commentaire)";
  const appVersion = record.app_version || "?";
  const platform   = record.system?.platform || "?";
  const userAgent  = record.system?.userAgent || "?";
  const userId     = record.user_id || "non connecté";
  const familyId   = record.family_id || "aucune famille";
  const reportId   = record.id || "?";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🐛</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouveau bug signalé sur Duvia</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#333;margin:0 0 16px;white-space:pre-wrap">${comment}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#555">
        <tr><td style="padding:4px 0;font-weight:700">Version app</td><td style="padding:4px 0">${appVersion}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Plateforme</td><td style="padding:4px 0">${platform}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Navigateur</td><td style="padding:4px 0">${userAgent}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Utilisateur</td><td style="padding:4px 0">${userId}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Famille</td><td style="padding:4px 0">${familyId}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">ID rapport</td><td style="padding:4px 0">${reportId}</td></tr>
      </table>
      <p style="color:#999;margin:20px 0 0;font-size:12px">Capture d'écran et logs détaillés : voir la table bug_reports dans Supabase (ID ci-dessus).</p>
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
        to: [ADMIN_EMAIL],
        subject: "🐛 Nouveau bug signalé sur Duvia",
        html,
      }),
    });
    const resBody = await res.json();
    console.log("notify-bug-report: Resend response:", JSON.stringify(resBody));
  } catch (e) {
    console.error("notify-bug-report: Resend send failed", e);
    return new Response(JSON.stringify({ error: "send_failed" }), { status: 500, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
```

- [ ] **Step 2b: Self-check the file**

Read the file back and confirm:
- `WEBHOOK_SECRET` check happens before `await req.json()` (rejects unauthorized calls without even parsing the body).
- No `SUPABASE_URL`, no `SERVICE_ROLE_KEY`, no `createClient` import — this function doesn't need database access.
- The email HTML does not reference `record.screenshot`, `record.logs`, or `record.errors` anywhere.
- Subject line matches exactly: `🐛 Nouveau bug signalé sur Duvia` (both in the `html` header div and the Resend `subject` field).

- [ ] **Step 3: Update `CLAUDE.md`'s Edge Functions list**

In `CLAUDE.md`, find this exact line (currently line 37):

```
- Edge Functions: `supabase/functions/delete-account`, `supabase/functions/notify-expense`.
```

Replace it with:

```
- Edge Functions: `supabase/functions/delete-account`, `supabase/functions/notify-expense`, `supabase/functions/notify-bug-report` (triggered by a Supabase Database Webhook on `bug_reports` INSERT, not a client-side call — see its header comment).
```

- [ ] **Step 4: Note the Database Webhook as dashboard-only config in `CLAUDE.md`**

In `CLAUDE.md`, find this sentence (currently inside the "Not yet done" paragraph, containing the text below):

```
`expire_stale_family_data()` is now scheduled via `pg_cron` (daily, see migration history / Supabase dashboard cron jobs — not committed as a migration file in this repo).
```

Immediately after that sentence (same paragraph), insert this new sentence:

```
Similarly, `notify-bug-report`'s trigger (a Database Webhook on `bug_reports` INSERT) and its `BUG_REPORT_WEBHOOK_SECRET` are configured only in the Supabase dashboard — not captured as a migration file in this repo.
```

- [ ] **Step 5: Verify no other files changed**

Run: `git status`
Expected: only `supabase/functions/notify-bug-report/index.ts` (new) and `CLAUDE.md` (modified) appear — no changes to `src/App.jsx`, `src/config.js`, or `public/sw.js`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/notify-bug-report/index.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
Add notify-bug-report Edge Function for admin email alerts

Triggered by a Supabase Database Webhook on bug_reports INSERT rather
than a client-side call, so the notification fires even if the
reporting tab closes right after submitting, and can't be triggered by
anyone who doesn't already have a real row to report. Deployment (the
webhook itself and its shared secret) happens in the Supabase dashboard,
guided separately -- not part of this commit.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Edge Function (spec section 1) → Task 1 Steps 1-2b. Database Webhook trigger mechanism (spec section 2) is dashboard-only config, correctly left OUT of this plan's code changes (mentioned only as a doc note in Step 4) — actual webhook creation happens in the manual deployment walkthrough after this task, as the spec's "Mise en place" section describes. No-client-change / no-version-bump (spec section 3) → enforced via Global Constraints and Step 5's verification. Documentation (spec's "Documentation" section) → Steps 3-4.
- **Placeholder scan:** no TBD/TODO; every step has literal file content or exact commands.
- **Type consistency:** n/a (single new file, no cross-task interfaces).
