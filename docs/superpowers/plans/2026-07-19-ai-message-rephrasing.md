# Assistant IA — Reformulation de message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first Premium+IA feature — an admin-gated "Reformuler" button in the messaging tab that sends the current draft to Claude (via a new Edge Function), shows the neutralized suggestion, and lets the user explicitly choose to send it or keep their original text.

**Architecture:** A boolean `ai_enabled` flag on `subscriptions` (admin-toggled, decoupled from the real Freemium/Trial/Premium ladder) gates a new Edge Function `ai-rephrase-message`, which calls the Anthropic Messages API server-side and logs usage to a new shared `ai_usage_log` table for a simple daily rate limit. Client-side, `MessagingTab` gets a new button + preview UI, and `sendMsg` gains an optional override-content parameter so the "send this one" action can send the AI suggestion without a stale-closure race against React state.

**Tech Stack:** Supabase Postgres migration, Deno Edge Function (`serve`, `@supabase/supabase-js@2`, Anthropic Messages API), React (existing `App.jsx` patterns), i18n (`src/i18n/*.js`).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-19-ai-message-rephrasing-design.md` — read it if anything below is ambiguous.
- `ai_enabled` is a plain boolean, NOT a new value in `sub.plan`/`subStatus()` — it must never be added to `TIER_RANK`, `subStatus()`, or any plan-comparison logic. It is checked directly (`sub.aiEnabled` client-side for UI visibility, `subscriptions.ai_enabled` server-side as the actual gate).
- Rate limit is **deliberately non-atomic** (simple `SELECT count()` before the Anthropic call, no advisory-lock RPC like `check_and_log_invite_email`) — this is a conscious simplification because the feature is admin-gated to a handful of trusted accounts, not a documentation gap. Do not "fix" this into an atomic RPC as part of this plan.
- Exact rate limit: **20 uses per account per rolling 24h**, scoped to `feature='rephrase_message'`.
- `ai_usage_log` never stores message content — only `user_id`, `feature`, `used_at`.
- `ai_enabled` must NEVER be added to the "Sync sub → table subscriptions" reverse-sync upsert (`App.jsx`, the effect at "── Sync sub → table subscriptions (Stripe-ready) ──") — it is admin-write-only, exactly like `plan`/`premium_since`/`cycle` are already excluded from that payload for the same reason (client must never be able to grant itself access).
- No new automated tests are added for the Edge Function or the React component changes — this repo has no Edge Function test harness and no component-test infrastructure (confirmed repeatedly in this project). Verification after each task is `TZ=Europe/Paris npm test` (must stay 140/140) + `npm run build` (must stay clean).
- `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) are bumped **once**, in the final task.
- The Edge Function and migration are deployed manually by the user (Supabase dashboard / SQL Editor) — the final task must print the full file contents and state exactly where to paste them, per this project's standing convention.

---

### Task 1: Migration — `ai_enabled` column + `ai_usage_log` table

**Files:**
- Create: `supabase/migrations/0044_ai_features_foundation.sql`

**Interfaces:**
- Produces: `public.subscriptions.ai_enabled boolean not null default false` (new column on an existing table) and `public.ai_usage_log(id uuid, user_id uuid, feature text, used_at timestamptz)`, consumed by Task 2 (Edge Function), Task 3 (admin toggle), Task 5 (client mapping).

- [ ] **Step 1: Write the migration file**

```sql
-- 0044_ai_features_foundation.sql
--
-- Infrastructure partagée pour les fonctionnalités IA (Premium+IA), en
-- commençant par la reformulation de message. Voir docs/superpowers/specs/
-- 2026-07-19-ai-message-rephrasing-design.md.
--
-- ai_enabled : interrupteur booléen par compte, complètement déconnecté de
-- l'échelle Freemium/Trial/Premium (aucun vrai palier "Premium+IA" vendable
-- n'existe encore, la vraie facturation Stripe est bloquée sur le SIRET) —
-- activé/désactivé uniquement depuis le panneau admin (admin-manage-
-- subscriptions), jamais par le client lui-même.
alter table public.subscriptions add column if not exists ai_enabled boolean not null default false;

-- ai_usage_log : partagée par les 4 futures fonctionnalités IA (reformulation
-- de message aujourd'hui, dépenses/calendrier/météo plus tard), chacune son
-- propre `feature`. Ne stocke JAMAIS le contenu envoyé/reçu à l'IA, seulement
-- l'usage (horodatage) pour le plafond anti-abus.
--
-- 🔧 Contrairement à invite_email_log (migrations 0042/0043), le plafond ici
-- est vérifié par un simple SELECT count() côté Edge Function, SANS RPC
-- atomique — accepté car cette fonctionnalité reste réservée aux comptes
-- activés par l'admin (risque d'abus bien plus faible qu'une fonctionnalité
-- ouverte à tous les utilisateurs authentifiés). À migrer vers le même schéma
-- atomique que check_and_log_invite_email si ai_enabled devient un vrai
-- palier vendable ouvert à tous.
create table if not exists public.ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null check (feature in ('rephrase_message')),
  used_at timestamptz not null default now()
);
create index if not exists idx_ai_usage_log_user_feature_used on public.ai_usage_log(user_id, feature, used_at);

alter table public.ai_usage_log enable row level security;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0044_ai_features_foundation.sql
git commit -m "Add ai_enabled flag and ai_usage_log table for Premium+IA foundation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Edge Function `ai-rephrase-message`

**Files:**
- Create: `supabase/functions/ai-rephrase-message/index.ts`

**Interfaces:**
- Consumes: `subscriptions.ai_enabled`, `ai_usage_log` from Task 1.
- Produces: an HTTP endpoint invoked as `supabase.functions.invoke("ai-rephrase-message", { body: { text } })`. Returns `{rephrased: string}` on success, or `{error: "missing_text"|"text_too_long"|"forbidden"|"daily_limit_reached"|"rephrase_failed"|...}` with a matching status (400/403/429/500) on failure. Consumed by Task 6 (`MessagingTab`).

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/ai-rephrase-message/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const DAILY_LIMIT = 20;
const MAX_TEXT_LEN = 2000; // aligné sur LIMITS.MSG_MAX côté client (App.jsx)

const SYSTEM_PROMPT = "Tu es un assistant qui aide des parents séparés à communiquer sereinement au sujet de leurs enfants. Reformule le message fourni par l'utilisateur en conservant STRICTEMENT son sens et les informations factuelles qu'il contient, dans un ton neutre, factuel et courtois — sans accusation, sans sarcasme, sans emportement. N'ajoute aucune information qui n'est pas dans le message original. Réponds UNIQUEMENT avec le message reformulé, dans la même langue que le message original, sans aucun commentaire ni introduction.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
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

  // 🔒 Appelant authentifié obligatoire — chacun reformule SES PROPRES
  // messages, pas de vérification de rôle admin ici.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "missing_authorization" }, 401);
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user?.id) return jsonResponse({ error: "invalid_token" }, 401);
  const userId = callerData.user.id;

  const text = String(payload?.text || "").trim();
  if (!text) return jsonResponse({ error: "missing_text" }, 400);
  if (text.length > MAX_TEXT_LEN) return jsonResponse({ error: "text_too_long" }, 400);

  // 🔒 ai_enabled est un interrupteur admin-only — jamais fait confiance à
  // un état client, revérifié ici à chaque appel.
  const { data: subRow, error: subErr } = await admin
    .from("subscriptions").select("ai_enabled").eq("user_id", userId).maybeSingle();
  if (subErr) return jsonResponse({ error: subErr.message }, 500);
  if (!subRow?.ai_enabled) return jsonResponse({ error: "forbidden" }, 403);

  // ── Anti-abus : plafond quotidien simple (non-atomique, voir migration
  // 0044 pour la justification — fonctionnalité réservée aux comptes admin) ──
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countErr } = await admin
    .from("ai_usage_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("feature", "rephrase_message")
    .gte("used_at", since24h);
  if (countErr) return jsonResponse({ error: countErr.message }, 500);
  if ((count || 0) >= DAILY_LIMIT) return jsonResponse({ error: "daily_limit_reached" }, 429);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("ai-rephrase-message: Anthropic error", errBody);
      return jsonResponse({ error: "rephrase_failed" }, 500);
    }
    const data = await res.json();
    const rephrased = String(data?.content?.[0]?.text || "").trim();
    if (!rephrased) return jsonResponse({ error: "rephrase_failed" }, 500);

    // Loggé uniquement après un succès réel — pas de réservation à compenser
    // ici (contrairement à send-invite-email), le seul écrivain est ce bloc.
    await admin.from("ai_usage_log").insert({ user_id: userId, feature: "rephrase_message" });

    return jsonResponse({ rephrased });
  } catch (e) {
    console.error("ai-rephrase-message: request failed", e);
    return jsonResponse({ error: "rephrase_failed" }, 500);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/ai-rephrase-message/index.ts
git commit -m "Add ai-rephrase-message Edge Function calling the Anthropic API

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Admin toggle for `ai_enabled`

**Files:**
- Modify: `supabase/functions/admin-manage-subscriptions/index.ts` (add `set_ai_enabled` action)
- Modify: `src/App.jsx` (`AccountSubscriptionCard`, add a toggle button)

**Interfaces:**
- Consumes: `subscriptions.ai_enabled` from Task 1.
- Produces: `supabase.functions.invoke("admin-manage-subscriptions", { body: { action: "set_ai_enabled", user_id, enabled } })` → `{ok:true}` or `{error}`. `lookup_user`'s existing response already includes `sub: subRow` (a `select("*")` — no change needed there, `ai_enabled` will appear automatically once Task 1's migration runs).

- [ ] **Step 1: Add the new action to `admin-manage-subscriptions`**

Read the CURRENT dashboard content of this function first if you have any doubt it might have drifted from the repo (per this project's standing rule for editing existing Edge Functions) — but this exact file was already confirmed in-sync with the dashboard earlier this same session (2026-07-19, admin cleanup button work), so proceeding directly is fine here.

Find the final `return jsonResponse({ error: "unknown_action" }, 400);` line (near the end of the file, after the existing `cleanup_anonymous_accounts` action block) and insert this new action block immediately before it:

```ts
  if (action === "set_ai_enabled") {
    const userId = String(payload?.user_id || "");
    const enabled = !!payload?.enabled;
    if (!userId) return jsonResponse({ error: "missing_user_id" }, 400);
    const { error } = await admin.from("subscriptions").upsert({ user_id: userId, ai_enabled: enabled }, { onConflict: "user_id" });
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

```

- [ ] **Step 2: Add the toggle button to `AccountSubscriptionCard`**

Find `function AccountSubscriptionCard({ C, onChanged }) {` in `src/App.jsx` and, inside it, find the `applyPlan` function:

```jsx
  async function applyPlan(plan) {
    if (!account) return;
    setApplying(plan); setErr(""); setMsg("");
    try {
      const body = { action: "set_user_plan", user_id: account.user_id, plan };
      if (plan === "premium") body.premium_cycle = premiumCycle;
      await call(body);
      setMsg(`✅ Compte mis à jour : ${plan}.`);
      const refreshed = await call({ action: "lookup_user", user_id: account.user_id });
      setAccount(refreshed);
      onChanged?.();
    } catch (ex) {
      setErr(String(ex?.message || ex));
    } finally {
      setApplying("");
    }
  }
```

Add a new function right after it:

```jsx
  async function toggleAi(enabled) {
    if (!account) return;
    setApplying("ai_toggle"); setErr(""); setMsg("");
    try {
      await call({ action: "set_ai_enabled", user_id: account.user_id, enabled });
      setMsg(`✅ IA ${enabled ? "activée" : "désactivée"}.`);
      const refreshed = await call({ action: "lookup_user", user_id: account.user_id });
      setAccount(refreshed);
      onChanged?.();
    } catch (ex) {
      setErr(String(ex?.message || ex));
    } finally {
      setApplying("");
    }
  }
```

Then find this block (the "Bulle 3 : plan payant" section):

```jsx
          {/* Bulle 3 : plan payant */}
          <div style={{padding:12,background:C.sur,borderRadius:10,border:`1px solid ${C.bor}`,marginBottom:12}}>
            <div style={{fontSize:10,fontWeight:800,color:C.mut,letterSpacing:".08em",textTransform:"uppercase",marginBottom:10}}>Premium (payant)</div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <select value={premiumCycle} onChange={e=>setPremiumCycle(e.target.value)}
                style={{height:38,borderRadius:8,border:`1.5px solid ${C.bor}`,padding:"0 10px",fontSize:13}}>
                <option value="monthly">Mensuel</option>
                <option value="yearly">Annuel</option>
              </select>
              <button onClick={()=>applyPlan("premium")} disabled={!!applying}
                style={{flex:1,minWidth:140,height:38,background:C.vio,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
                {applying==="premium"?"…":"⭐ Premium"}
              </button>
            </div>
          </div>
        </>
      )}
```

Replace with (adds a 4th "bulle" for the AI toggle, right after the Premium one):

```jsx
          {/* Bulle 3 : plan payant */}
          <div style={{padding:12,background:C.sur,borderRadius:10,border:`1px solid ${C.bor}`,marginBottom:12}}>
            <div style={{fontSize:10,fontWeight:800,color:C.mut,letterSpacing:".08em",textTransform:"uppercase",marginBottom:10}}>Premium (payant)</div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              <select value={premiumCycle} onChange={e=>setPremiumCycle(e.target.value)}
                style={{height:38,borderRadius:8,border:`1.5px solid ${C.bor}`,padding:"0 10px",fontSize:13}}>
                <option value="monthly">Mensuel</option>
                <option value="yearly">Annuel</option>
              </select>
              <button onClick={()=>applyPlan("premium")} disabled={!!applying}
                style={{flex:1,minWidth:140,height:38,background:C.vio,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
                {applying==="premium"?"…":"⭐ Premium"}
              </button>
            </div>
          </div>

          {/* Bulle 4 : interrupteur IA (Premium+IA, admin-only pour l'instant) */}
          <div style={{padding:12,background:C.sur,borderRadius:10,border:`1px solid ${C.bor}`,marginBottom:12}}>
            <div style={{fontSize:10,fontWeight:800,color:C.mut,letterSpacing:".08em",textTransform:"uppercase",marginBottom:10}}>🤖 Premium+IA (bêta admin)</div>
            <button onClick={()=>toggleAi(!account.sub?.ai_enabled)} disabled={!!applying}
              style={{width:"100%",height:38,background:account.sub?.ai_enabled?C.grn:C.bor,color:account.sub?.ai_enabled?"#fff":C.txt,border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer"}}>
              {applying==="ai_toggle" ? "…" : (account.sub?.ai_enabled ? "🤖 IA activée (cliquer pour désactiver)" : "🤖 Activer l'IA pour ce compte")}
            </button>
          </div>
        </>
      )}
```

- [ ] **Step 3: Run the existing test suite (regression check)**

Run: `TZ=Europe/Paris npm test`
Expected: 140/140 pass.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx supabase/functions/admin-manage-subscriptions/index.ts
git commit -m "Add admin toggle for the ai_enabled flag

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: i18n keys (5 languages)

**Files:**
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js`

**Interfaces:**
- Produces: `aiRephraseBtn`, `aiRephraseLoading`, `aiRephraseSuggestionLabel`, `aiRephraseUseBtn`, `aiRephraseKeepBtn`, `aiRephraseError`, `aiRephraseDailyLimitError` — consumed by Task 6.

- [ ] **Step 1: Add keys to `src/i18n/fr.js`**

Find the existing line `sendInviteLink:"📨 Envoyer le lien d'invitation",` (or any other stable anchor near it) and add nearby:

```js
    aiRephraseBtn:"✨ Reformuler",
    aiRephraseLoading:"Reformulation…",
    aiRephraseSuggestionLabel:"Suggestion reformulée",
    aiRephraseUseBtn:"Envoyer celle-ci",
    aiRephraseKeepBtn:"Garder mon texte original",
    aiRephraseError:"⚠️ Échec de la reformulation. Réessaie.",
    aiRephraseDailyLimitError:"⚠️ Limite quotidienne de reformulations atteinte. Réessaie demain.",
```

- [ ] **Step 2: Add keys to `src/i18n/en.js`**

```js
    aiRephraseBtn:"✨ Rephrase",
    aiRephraseLoading:"Rephrasing…",
    aiRephraseSuggestionLabel:"Rephrased suggestion",
    aiRephraseUseBtn:"Send this one",
    aiRephraseKeepBtn:"Keep my original text",
    aiRephraseError:"⚠️ Rephrasing failed. Try again.",
    aiRephraseDailyLimitError:"⚠️ Daily rephrasing limit reached. Try again tomorrow.",
```

- [ ] **Step 3: Add keys to `src/i18n/de.js`**

```js
    aiRephraseBtn:"✨ Umformulieren",
    aiRephraseLoading:"Wird umformuliert…",
    aiRephraseSuggestionLabel:"Umformulierter Vorschlag",
    aiRephraseUseBtn:"Diese Version senden",
    aiRephraseKeepBtn:"Meinen Originaltext behalten",
    aiRephraseError:"⚠️ Umformulierung fehlgeschlagen. Versuche es erneut.",
    aiRephraseDailyLimitError:"⚠️ Tägliches Limit für Umformulierungen erreicht. Versuche es morgen erneut.",
```

- [ ] **Step 4: Add keys to `src/i18n/es.js`**

```js
    aiRephraseBtn:"✨ Reformular",
    aiRephraseLoading:"Reformulando…",
    aiRephraseSuggestionLabel:"Sugerencia reformulada",
    aiRephraseUseBtn:"Enviar esta",
    aiRephraseKeepBtn:"Mantener mi texto original",
    aiRephraseError:"⚠️ Error al reformular. Inténtalo de nuevo.",
    aiRephraseDailyLimitError:"⚠️ Límite diario de reformulaciones alcanzado. Inténtalo mañana.",
```

- [ ] **Step 5: Add keys to `src/i18n/pt.js`**

```js
    aiRephraseBtn:"✨ Reformular",
    aiRephraseLoading:"Reformulando…",
    aiRephraseSuggestionLabel:"Sugestão reformulada",
    aiRephraseUseBtn:"Enviar esta",
    aiRephraseKeepBtn:"Manter meu texto original",
    aiRephraseError:"⚠️ Falha ao reformular. Tente novamente.",
    aiRephraseDailyLimitError:"⚠️ Limite diário de reformulações atingido. Tente novamente amanhã.",
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: builds clean (no test covers i18n file syntax directly, build is the check).

- [ ] **Step 7: Commit**

```bash
git add src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js
git commit -m "Add i18n keys for AI message rephrasing (all 5 languages)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Expose `sub.aiEnabled` client-side

**Files:**
- Modify: `src/App.jsx` (the "Vérification plan d'abonnement depuis Supabase" effect, and `doLogin()`'s `subRow` mapping)

**Interfaces:**
- Consumes: `subscriptions.ai_enabled` from Task 1.
- Produces: `sub.aiEnabled` (boolean), read by Task 6's `MessagingTab`.

- [ ] **Step 1: Add `ai_enabled` to the periodic verification effect's SELECT and mapping**

Find (the "Vérification plan d'abonnement depuis Supabase" effect):

```jsx
        const { data: subRow } = await supabase
          .from("subscriptions")
          .select("plan, premium_since, cycle, trial_start, trial_extension_days, beta_end, ref_count, validated_ref_count, ref_months, pending_spins, monthly_ref_month, monthly_ref_count")
          .eq("user_id", myUid)
          .maybeSingle();
```

Replace with:

```jsx
        const { data: subRow } = await supabase
          .from("subscriptions")
          .select("plan, premium_since, cycle, trial_start, trial_extension_days, beta_end, ref_count, validated_ref_count, ref_months, pending_spins, monthly_ref_month, monthly_ref_count, ai_enabled")
          .eq("user_id", myUid)
          .maybeSingle();
```

Then find, in the same effect, the `setSub(s => ({...` block's last mapped field:

```jsx
          refValidated:    subRow.ref_validated          ?? s.refValidated,
        }));
```

Replace with:

```jsx
          refValidated:    subRow.ref_validated          ?? s.refValidated,
          // 🔧 Interrupteur admin-only (Premium+IA, migration 0044) — jamais
          // écrit par le client (absent du payload de l'effet "Sync sub →
          // table subscriptions" plus bas dans ce fichier, exactement comme
          // plan/premium_since/cycle).
          aiEnabled:       subRow.ai_enabled              ?? s.aiEnabled,
        }));
```

- [ ] **Step 2: Add `aiEnabled` to `doLogin()`'s `subRow` mapping**

Find (in `doLogin()`, `LoginScreen`):

```jsx
          refValidated: subRow.ref_validated || false,
        };
```

Replace with:

```jsx
          refValidated: subRow.ref_validated || false,
          aiEnabled: subRow.ai_enabled || false,
        };
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
git commit -m "Expose sub.aiEnabled from the subscriptions table client-side

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `MessagingTab` — rephrase button + preview flow

**Files:**
- Modify: `src/App.jsx` (`MessagingTab`, `sendMsg`)

**Interfaces:**
- Consumes: `sub.aiEnabled` from Task 5, `ai-rephrase-message` from Task 2, i18n keys from Task 4.
- Modifies `sendMsg`'s signature: `sendMsg(toIds, overrideContent?)` — fully backward-compatible (every existing call site passes only `toIds`, so `overrideContent` stays `undefined` and behavior is unchanged).

- [ ] **Step 1: Add `sub` to `MessagingTab`'s `useApp()` destructuring**

Find:

```jsx
function MessagingTab(){
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,reactToCloudMessage,deleteCloudMessage,myUid,uidToLocal,localToUid,emailToUid,familySync,isChild,isObs,hiddenConvs,hideConversation,prem,onUpgrade}=useApp();
```

Replace with:

```jsx
function MessagingTab(){
  const {C,t,cfg,user,users,addRefAction,msgs,sendCloudMessage,markCloudMessageRead,reactToCloudMessage,deleteCloudMessage,myUid,uidToLocal,localToUid,emailToUid,familySync,isChild,isObs,hiddenConvs,hideConversation,prem,onUpgrade,sub}=useApp();
```

- [ ] **Step 2: Add rephrase state**

Find (near `MessagingTab`'s other `useState` declarations):

```jsx
  const [shakeDraft,setShakeDraft]=useState(false);
```

Replace with:

```jsx
  const [shakeDraft,setShakeDraft]=useState(false);
  const [rephrasing,setRephrasing]=useState(false);
  const [rephraseSuggestion,setRephraseSuggestion]=useState("");
  const [rephraseErr,setRephraseErr]=useState("");
```

- [ ] **Step 3: Change `sendMsg`'s signature to accept an optional override**

Find:

```jsx
  async function sendMsg(toIds){
    const content=draft.trim();
    if((!content&&!pendingFile)||!toIds.length)return;
```

Replace with:

```jsx
  async function sendMsg(toIds, overrideContent){
    // 🔧 overrideContent permet au bouton "Envoyer celle-ci" (suggestion IA)
    // d'envoyer un texte précis sans dépendre de l'état `draft` — un simple
    // setDraft(suggestion) suivi d'un sendMsg(toIds) dans le même clic
    // enverrait encore l'ANCIEN draft, React ne rafraîchissant l'état
    // qu'au rendu suivant. Tous les appels existants ne passent qu'un seul
    // argument, donc overrideContent reste undefined et le comportement est
    // inchangé partout ailleurs.
    const content=(overrideContent!==undefined?overrideContent:draft).trim();
    if((!content&&!pendingFile)||!toIds.length)return;
```

- [ ] **Step 4: Add the `handleRephrase` function**

Find (right after `sendMsg`'s closing, before `function convName(ids){`):

```jsx
    sendCloudMessage(myName, toIds, safeContent).then(()=>{
      _afterSend(toIds);
    }).catch(e=>alert("⚠️ Erreur d'envoi : "+(e?.message||e)));
  }

  function convName(ids){
```

Replace with:

```jsx
    sendCloudMessage(myName, toIds, safeContent).then(()=>{
      _afterSend(toIds);
    }).catch(e=>alert("⚠️ Erreur d'envoi : "+(e?.message||e)));
  }

  async function handleRephrase() {
    if (!draft.trim()) return;
    setRephrasing(true); setRephraseErr(""); setRephraseSuggestion("");
    try {
      const { data, error } = await supabase.functions.invoke("ai-rephrase-message", { body: { text: draft } });
      if (error) throw new Error("generic");
      if (data?.error === "daily_limit_reached") throw new Error("daily");
      if (data?.error) throw new Error("generic");
      setRephraseSuggestion(data?.rephrased || "");
    } catch (e) {
      setRephraseErr(e.message === "daily" ? (t.aiRephraseDailyLimitError||"⚠️ Limite quotidienne de reformulations atteinte. Réessaie demain.") : (t.aiRephraseError||"⚠️ Échec de la reformulation. Réessaie."));
    } finally {
      setRephrasing(false);
    }
  }

  function convName(ids){
```

- [ ] **Step 5: Add the UI (button + preview) above the composer**

Find (the composer's opening, right before the file-attachment preview / Input row — search for the unique comment `{/* Input */}` inside `MessagingTab`'s conversation view):

```jsx
        {/* Input */}
        <div style={{display:"flex",gap:8,paddingTop:10,borderTop:`1px solid ${C.bor}`,flexShrink:0,alignItems:"center"}}>
```

Replace with:

```jsx
        {sub?.aiEnabled && (
          <div style={{marginBottom:8,flexShrink:0}}>
            {rephraseSuggestion ? (
              <div style={{padding:"10px 12px",background:`${C.vio}08`,border:`1.5px solid ${C.vio}33`,borderRadius:14,marginBottom:8}}>
                <div style={{fontSize:10,fontWeight:800,color:C.vio,textTransform:"uppercase",letterSpacing:".05em",marginBottom:6}}>✨ {t.aiRephraseSuggestionLabel||"Suggestion reformulée"}</div>
                <div style={{fontSize:13,color:C.txt,lineHeight:1.5,marginBottom:10,whiteSpace:"pre-wrap"}}>{rephraseSuggestion}</div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>{ sendMsg(otherIds, rephraseSuggestion); setRephraseSuggestion(""); }} style={{flex:1,height:36,background:`linear-gradient(135deg,${C.vio},${C.pin})`,color:"#fff",border:"none",borderRadius:10,fontWeight:700,fontSize:12,cursor:"pointer"}}>
                    {t.aiRephraseUseBtn||"Envoyer celle-ci"}
                  </button>
                  <button onClick={()=>setRephraseSuggestion("")} style={{flex:1,height:36,background:C.sur,color:C.mut,border:`1.5px solid ${C.bor}`,borderRadius:10,fontWeight:700,fontSize:12,cursor:"pointer"}}>
                    {t.aiRephraseKeepBtn||"Garder mon texte original"}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={handleRephrase} disabled={!draft.trim() || rephrasing} style={{padding:"6px 14px",background:`${C.vio}12`,color:C.vio,border:`1.5px solid ${C.vio}44`,borderRadius:20,fontSize:12,fontWeight:700,cursor:(!draft.trim()||rephrasing)?"not-allowed":"pointer",opacity:draft.trim()?1:.5}}>
                {rephrasing ? `⏳ ${t.aiRephraseLoading||"Reformulation…"}` : (t.aiRephraseBtn||"✨ Reformuler")}
              </button>
            )}
            {rephraseErr && <div style={{fontSize:11,color:C.red,marginTop:6}}>{rephraseErr}</div>}
          </div>
        )}
        {/* Input */}
        <div style={{display:"flex",gap:8,paddingTop:10,borderTop:`1px solid ${C.bor}`,flexShrink:0,alignItems:"center"}}>
```

**Note**: `otherIds` (defined earlier in this same conversation-view render function, `App.jsx:~17157`: `const otherIds=currentConv.ids.filter(id=>id!==String(myUid));`) is already in scope at this point and is the exact same variable the existing send button uses (`onClick={()=>sendMsg(otherIds)}` a few lines below) — confirmed directly against the current file, no ambiguity.

- [ ] **Step 6: Run the existing test suite (regression check)**

Run: `TZ=Europe/Paris npm test`
Expected: 140/140 pass.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: builds clean.

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "Add AI message-rephrase button and preview flow to MessagingTab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Version bump and final verification

**Files:**
- Modify: `src/config.js` (`APP_VERSION`)
- Modify: `public/sw.js` (`SW_VERSION`)

**Interfaces:**
- Consumes: nothing new — final integration check across all previous tasks.

- [ ] **Step 1: Bump both version constants together**

Check the current value first with `grep APP_VERSION src/config.js` (do not assume — other work may have shipped since this plan was written) and increment by one `0.01` step in both `src/config.js` and `public/sw.js`, to the exact same new value.

- [ ] **Step 2: Full regression run**

Run: `TZ=Europe/Paris npm test`
Expected: 140/140 pass.

Run: `npm run build`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add src/config.js public/sw.js
git commit -m "Bump version for AI message-rephrasing feature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Print deployment instructions for the user**

This feature needs 4 manual steps outside this repo before it works in production, in this order:
1. Create an account on console.anthropic.com (if not already done), generate an API key, add it as a Supabase secret `ANTHROPIC_API_KEY` (production project).
2. Run `supabase/migrations/0044_ai_features_foundation.sql` in the Supabase SQL Editor (production project).
3. Create a new Edge Function named exactly `ai-rephrase-message` in the Supabase dashboard, paste the full contents of `supabase/functions/ai-rephrase-message/index.ts` (written in Task 2), deploy.
4. Update the existing `admin-manage-subscriptions` Edge Function in the dashboard with the new `set_ai_enabled` action (Task 3) — paste the FULL updated file content (not just the diff).

Print the full current contents of all relevant files in the final report so the user can copy-paste them directly, per this project's standing convention for Edge Function deployment instructions.

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage**: boolean access gate ✅ (Tasks 1, 3, 5), Edge Function + system prompt ✅ (Task 2), anti-abuse (deliberately simple) ✅ (Tasks 1, 2), UI flow with explicit send/keep choice ✅ (Task 6), admin toggle ✅ (Task 3), i18n ✅ (Task 4), version bump ✅ (Task 7). No spec section left uncovered.
- **Placeholder scan**: no TBD/TODO; every step has literal code.
- **Type consistency**: `sendMsg(toIds, overrideContent)`'s new optional parameter is used identically in Task 6's Step 3 (definition) and Step 5 (call site in the "Envoyer celle-ci" button). `sub.aiEnabled` (Task 5's output) matches `sub?.aiEnabled` (Task 6's consumption) exactly.
- **`otherIds` scope verified**: confirmed directly against the current file (not assumed) that it's defined earlier in the same conversation-view function and is the exact variable the existing send button already uses.
