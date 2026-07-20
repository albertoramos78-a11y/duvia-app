# Assistant IA conversationnel (chatbot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the second Premium+IA feature — a floating chatbot bubble (visible on every tab) that answers both general Duvia usage questions and personalized questions about the user's own family (expenses/balance, weather, config, school schedule, messages/summaries), via a new Edge Function using Claude's tool-calling (function calling) to fetch only the data needed for each specific question.

**Architecture:** New Edge Function `ai-chatbot` (JWT-authenticated, reuses `ai_enabled`/`ai_usage_log` from the rephrasing feature with a new `feature='chatbot_query'` value) runs an Anthropic tool-calling loop. Each tool executes its Supabase query using a client scoped to the **caller's own JWT** (not the service-role key) so existing RLS applies automatically — except the weather tool's cross-parent lookup, which mirrors the already-shipped `get-family-weather` function's audited pattern (service-role read of `parent_locations`, but only derived forecast fields ever leave the function, never raw coordinates/city). Client-side, a new `ChatbotBubble` component (mounted once at the app root, visible whenever `sub.aiEnabled`) holds an ephemeral, plain-text conversation history and calls the Edge Function once per question.

**Tech Stack:** Supabase Postgres migration, Deno Edge Function (`serve`, `@supabase/supabase-js@2`, Anthropic Messages API with tool use), React (existing `App.jsx` patterns), i18n (`src/i18n/*.js`).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-20-ai-chatbot-assistant-design.md` — read it if anything below is ambiguous.
- Access gate: `subscriptions.ai_enabled = true` (client: `sub.aiEnabled`, already exposed — no new plumbing needed). Revert to forbidden/hide-the-bubble in every other case. This is the SAME flag as the rephrasing feature — do not introduce a second gate.
- Rate limit: **20 questions per account per rolling 24h**, scoped to `feature='chatbot_query'` in `ai_usage_log`. Non-atomic `SELECT count()` check, same as `rephrase_message` — same justification (admin-gated to a handful of trusted accounts). One `ai_usage_log` row per QUESTION, never per internal tool round-trip.
- No calendar tool. If a question needs the custody schedule, the chatbot must say it cannot answer — never invent a schedule.
- No server-side conversation persistence. The client keeps a plain array of `{role:"user"|"assistant", content:string}` turns (no tool-call internals) and resends it (capped at the last 20 entries) with each new question. The Edge Function's OWN internal tool-calling loop for a single question is not part of this persisted history.
- Every tool query MUST use a Supabase client constructed with `SUPABASE_ANON_KEY` + the caller's own `Authorization` header (JWT-scoped) — NOT the service-role client — so existing RLS enforces who can see what, without reproducing permission logic per role. The one exception: the weather tool's read of `parent_locations` for a family member OTHER than the caller, which uses the service-role client exactly like the already-shipped `get-family-weather` function does (`supabase/functions/get-family-weather/index.ts`) — because `parent_locations` deliberately has no family-wide RLS policy (migration `0035_parent_locations.sql` — a parent's home coordinates/city are sensitive and must never be readable by another family member directly). Even then, only derived forecast fields (`code`/`temp_max`/`temp_min`) may leave the tool — never `lat`/`lon`/`city`.
- The client must pass `family_id` explicticly in the request body (the app's own `familySync.familyId` — there is no other way for a stateless Edge Function to know "which family" for a given call). This is safe: a client passing a `family_id` it doesn't belong to gets `not_a_family_member`/empty results from RLS, never someone else's data.
- The expense balance (`get_expenses` tool) MUST reproduce the exact formula in `ExpensesTab` (`App.jsx:~13744-13760`) — never let Claude compute or restate a different number.
- No new automated tests — this repo has no Edge Function test harness and no component-test infrastructure. Verification after each task is `TZ=Europe/Paris npm test` (must stay 140/140) + `npm run build` (must stay clean). Manual/live verification steps are listed in the spec's "Test / vérification" section — flag them to the user at the end, do not attempt to automate them.
- `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) are bumped **once**, in the final task.
- The migration and the new Edge Function are deployed manually by the user (Supabase dashboard / SQL Editor) — the final task must print the full file contents and state exactly where to paste them, per this project's standing convention.

---

### Task 1: Migration — add `chatbot_query` to the `ai_usage_log.feature` allow-list

**Files:**
- Create: `supabase/migrations/0045_chatbot_query_feature.sql`

**Interfaces:**
- Produces: `ai_usage_log.feature` now also accepts `'chatbot_query'` (in addition to the existing `'rephrase_message'`). Consumed by Task 2 (Edge Function's rate-limit check and usage logging).

- [ ] **Step 1: Write the migration file**

```sql
-- 0045_chatbot_query_feature.sql
--
-- Ajoute 'chatbot_query' à la liste des features autorisées dans
-- ai_usage_log (posée par la migration 0044 pour 'rephrase_message'
-- uniquement). Voir docs/superpowers/specs/2026-07-20-ai-chatbot-assistant-
-- design.md — 2e fonctionnalité Premium+IA, réutilise la même table de log
-- et le même plafond quotidien non-atomique (20/jour), sur sa propre valeur
-- de feature pour ne pas partager le quota avec la reformulation de message.
--
-- Postgres ne permet pas de modifier les valeurs d'une contrainte CHECK en
-- place — il faut la supprimer puis la recréer. Le nom "ai_usage_log_feature_
-- check" est le nom auto-généré par Postgres pour la contrainte CHECK inline
-- posée sur la colonne "feature" par le CREATE TABLE de la migration 0044
-- (convention <table>_<colonne>_check).
alter table public.ai_usage_log drop constraint if exists ai_usage_log_feature_check;
alter table public.ai_usage_log add constraint ai_usage_log_feature_check
  check (feature in ('rephrase_message', 'chatbot_query'));
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0045_chatbot_query_feature.sql
git commit -m "Add chatbot_query to ai_usage_log's allowed feature values

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Edge Function `ai-chatbot`

**Files:**
- Create: `supabase/functions/ai-chatbot/index.ts`

**Interfaces:**
- Consumes: `subscriptions.ai_enabled`, `ai_usage_log` (feature `chatbot_query`) from Task 1; `get-family-weather`'s security pattern (read-only reference, not imported — this is a separate Deno function, code cannot be shared across Edge Functions in this project).
- Produces: an HTTP endpoint invoked as `supabase.functions.invoke("ai-chatbot", { body: { question, family_id, history } })` where `history` is `Array<{role:"user"|"assistant", content:string}>` (previous turns, empty array on the first question). Returns `{answer: string, history: Array<{role,content}>}` on success (the SAME shape as the input `history`, plus this turn, capped to the last 20 entries — the client should replace its own history with this value for the next call), or `{error: "missing_question"|"question_too_long"|"missing_family_id"|"forbidden"|"daily_limit_reached"|"chatbot_failed"|"too_many_tool_rounds"|...}` with a matching status (400/403/429/500). Consumed by Task 3 (`ChatbotBubble`).

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/ai-chatbot/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const DAILY_LIMIT = 20;
const MAX_TOOL_ROUNDS = 5;
const MAX_QUESTION_LEN = 2000;
const MAX_HISTORY_ENTRIES = 20;

const SYSTEM_PROMPT = `Tu es l'assistant IA de Duvia, une application de coparentalité partagée entre deux foyers ("Deux maisons. Une famille."). Tu réponds aux questions des parents, observateurs et enfants utilisant l'application.

Tu peux :
1. Aider sur l'utilisation de l'application (comment inviter quelqu'un, où trouver telle fonctionnalité, etc.) et donner des conseils généraux d'organisation de la coparentalité — réponds directement, sans outil.
2. Répondre à des questions sur les données de LEUR PROPRE famille (dépenses, solde entre parents, météo, configuration, emploi du temps scolaire, messages) — utilise les outils fournis pour aller chercher les données réelles avant de répondre. Ne devine JAMAIS un chiffre ou une information que tu pourrais vérifier avec un outil, et ne recalcule JAMAIS toi-même un solde déjà fourni par l'outil.
3. Résumer des conversations, décisions ou accords à partir des messages récupérés via l'outil de messagerie, sur demande.
4. Reformuler un message que l'utilisateur colle dans la conversation s'il te semble agressif, accusateur ou conflictuel, et expliquer brièvement en quoi la reformulation est plus constructive.
5. Traduire du texte à la demande, dans n'importe quelle langue.

Tu ne réponds JAMAIS à des questions d'ordre juridique (garde, pension alimentaire, droits parentaux, procédures judiciaires, litiges) — dans ce cas, explique poliment que tu ne peux pas conseiller sur ces sujets et recommande de consulter un avocat ou un professionnel qualifié. Tu peux donner des conseils GÉNÉRAUX d'organisation, de communication ou de médiation, mais jamais d'interprétation de la loi ni d'affirmation sur les droits d'un parent.

Reste neutre, factuel et bienveillant — le contexte familial est souvent sensible. Réponds dans la langue de la question. Si une information demandée n'est disponible dans aucun outil (ex. planning de garde, actuellement non disponible), dis-le clairement plutôt que d'inventer une réponse.`;

const TOOLS = [
  {
    name: "get_expenses",
    description: "Récupère les dépenses et remboursements de la famille de l'utilisateur, avec un solde déjà calculé (qui doit combien à qui), les remboursements en attente depuis plus de 14 jours, et les dépenses récurrentes à échéance dans les 30 prochains jours.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Date de début, format YYYY-MM-DD. Par défaut : il y a 3 mois." },
        to_date: { type: "string", description: "Date de fin, format YYYY-MM-DD. Par défaut : aujourd'hui." },
      },
    },
  },
  {
    name: "get_weather",
    description: "Récupère les prévisions météo pour les villes configurées par chaque parent de la famille.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Nombre de jours de prévision (1 à 16). Par défaut : 7." },
      },
    },
  },
  {
    name: "get_family_config",
    description: "Récupère les informations non sensibles de la configuration de la famille : prénoms/dates de naissance des enfants, prénoms des parents, dates personnalisées configurées, et l'emploi du temps scolaire de chaque enfant.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_messages",
    description: "Récupère les messages de la messagerie familiale de l'utilisateur, pour répondre à une question précise ou pour en faire un résumé.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Date de début (ISO 8601), optionnelle." },
        to_date: { type: "string", description: "Date de fin (ISO 8601), optionnelle." },
        limit: { type: "number", description: "Nombre maximum de messages (1 à 200). Par défaut : 30." },
      },
    },
  },
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// ── Solde entre parents — reproduit EXACTEMENT la formule de ExpensesTab
// (App.jsx:~13744-13760), jamais laissée au calcul de Claude. ──
function computeExpenseBalance(expenses: any[], reimbursements: any[]) {
  const confirmedExpenses = expenses.filter((e) => !e.status || e.status === "confirmed");
  const totals = [0, 1].map((i) => confirmedExpenses.filter((e) => e.paid_by === i).reduce((s, e) => s + Number(e.amount), 0));
  const owed = [0, 1].map((i) => confirmedExpenses.reduce((s, e) => {
    const sp = e.split_pct ?? 50;
    return s + (Number(e.amount) * (i === 1 ? sp : 100 - sp)) / 100;
  }, 0));
  const confirmedReims = reimbursements.filter((r) => r.status === "confirmed");
  const reimSent = [0, 1].map((i) => confirmedReims.filter((r) => r.from_parent === i).reduce((s, r) => s + Number(r.amount), 0));
  const reimReceived = [0, 1].map((i) => confirmedReims.filter((r) => r.to_parent === i).reduce((s, r) => s + Number(r.amount), 0));
  return [0, 1].map((i) => totals[i] - owed[i] + reimSent[i] - reimReceived[i]);
}

async function toolGetExpenses(userClient: ReturnType<typeof createClient>, args: any) {
  const toDate = args?.to_date || new Date().toISOString().slice(0, 10);
  const fromDate = args?.from_date || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

  const { data: expenses, error: expErr } = await userClient
    .from("expenses")
    .select("label, amount, paid_by, split_pct, category, date, status, recurring, recurring_end")
    .gte("date", fromDate).lte("date", toDate).order("date", { ascending: false });
  if (expErr) return { error: expErr.message };

  const { data: reims, error: reimErr } = await userClient
    .from("reimbursements")
    .select("from_parent, to_parent, amount, date, status")
    .gte("date", fromDate).lte("date", toDate).order("date", { ascending: false });
  if (reimErr) return { error: reimErr.message };

  const balance = computeExpenseBalance(expenses || [], reims || []);

  const since14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const forgottenReimbursements = (reims || []).filter((r) => r.status === "pending" && r.date && r.date < since14d);

  const in30d = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const upcomingRecurring = (expenses || []).filter((e) => e.recurring && (!e.recurring_end || e.recurring_end >= in30d));

  return {
    expenses: (expenses || []).map((e) => ({ label: e.label, amount: e.amount, category: e.category, date: e.date, status: e.status })),
    balance: { parent_0: balance[0], parent_1: balance[1] },
    forgotten_reimbursements: forgottenReimbursements,
    upcoming_recurring_expenses: upcomingRecurring,
  };
}

async function toolGetWeather(
  userClient: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createClient>,
  familyId: string,
  callerUserId: string,
  args: any,
) {
  // 🔒 parent_locations n'a AUCUNE policy RLS "famille entière" (voir
  // migration 0035_parent_locations.sql) — même modèle de sécurité que
  // get-family-weather (docs/superpowers/specs/2026-07-13-weather-location-
  // privacy-design.md) : vérifier l'appartenance familiale avec le client de
  // l'appelant, puis lire les coordonnées de TOUS les parents avec le client
  // service-role, mais ne renvoyer QUE les champs dérivés (code/température)
  // — jamais lat/lon/ville, même à Claude.
  const { data: membership } = await userClient
    .from("family_members").select("user_id").eq("family_id", familyId).eq("status", "active").maybeSingle();
  if (!membership) return { error: "not_a_family_member" };

  const { data: parents } = await admin
    .from("family_members").select("user_id").eq("family_id", familyId).eq("role", "parent").eq("status", "active");

  const days = Math.min(Math.max(Number(args?.days) || 7, 1), 16);
  const results: any[] = [];
  for (const p of parents || []) {
    const { data: loc } = await admin
      .from("parent_locations").select("lat, lon").eq("user_id", p.user_id).eq("family_id", familyId).maybeSingle();
    if (!loc) continue;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${days}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const forecast = (data?.daily?.time || []).map((date: string, i: number) => ({
        date, code: data.daily.weathercode[i], temp_max: data.daily.temperature_2m_max[i], temp_min: data.daily.temperature_2m_min[i],
      }));
      results.push({ who: p.user_id === callerUserId ? "vous" : "votre co-parent", forecast });
    } catch {
      continue;
    }
  }
  return { forecasts: results };
}

function extractWeeklySchedule(cfgData: any) {
  const dayNames = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
  const schedules = cfgData.schedules || {};
  const children = cfgData.children || [];
  return children.map((child: any) => ({
    child_name: child.name,
    week: dayNames.map((dayName, dayIdx) => {
      const key = `schedule_child${child.id}_day${dayIdx}`;
      const slots = (schedules[key] || []).map((s: any) => ({ subject: s.subject, room: s.room, from: s.from, to: s.to }));
      return { day: dayName, slots };
    }),
  }));
}

async function toolGetFamilyConfig(userClient: ReturnType<typeof createClient>, familyId: string) {
  const { data: family, error } = await userClient.from("families").select("data").eq("id", familyId).maybeSingle();
  if (error || !family) return { error: "family_not_found_or_no_access" };
  const cfgData = family.data || {};
  return {
    parents: (cfgData.parents || []).map((p: any) => ({ name: p.name })),
    children: (cfgData.children || []).map((c: any) => ({ name: c.name, birth_day: c.birthDay, birth_month: c.birthMonth, birth_year: c.birthYear })),
    custom_dates: (cfgData.specialDates?.custom || []).map((d: any) => ({ label: d.label, day: d.day, month: d.month, yearly: d.yearly })),
    schedules: extractWeeklySchedule(cfgData),
  };
}

async function toolGetMessages(userClient: ReturnType<typeof createClient>, familyId: string, args: any) {
  const limit = Math.min(Math.max(Number(args?.limit) || 30, 1), 200);
  let query = userClient
    .from("messages").select("sender_name, content, created_at")
    .eq("family_id", familyId).order("created_at", { ascending: false }).limit(limit);
  if (args?.from_date) query = query.gte("created_at", args.from_date);
  if (args?.to_date) query = query.lte("created_at", args.to_date);
  const { data, error } = await query;
  if (error) return { error: error.message };
  return { messages: (data || []).reverse().map((m: any) => ({ from: m.sender_name, content: m.content, date: m.created_at })) };
}

async function executeTool(
  name: string,
  args: any,
  ctx: { userClient: ReturnType<typeof createClient>; admin: ReturnType<typeof createClient>; familyId: string; callerUserId: string },
) {
  switch (name) {
    case "get_expenses": return toolGetExpenses(ctx.userClient, args);
    case "get_weather": return toolGetWeather(ctx.userClient, ctx.admin, ctx.familyId, ctx.callerUserId, args);
    case "get_family_config": return toolGetFamilyConfig(ctx.userClient, ctx.familyId);
    case "get_messages": return toolGetMessages(ctx.userClient, ctx.familyId, args);
    default: return { error: "unknown_tool" };
  }
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

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "missing_authorization" }, 401);
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user?.id) return jsonResponse({ error: "invalid_token" }, 401);
  const userId = callerData.user.id;

  const question = String(payload?.question || "").trim();
  if (!question) return jsonResponse({ error: "missing_question" }, 400);
  if (question.length > MAX_QUESTION_LEN) return jsonResponse({ error: "question_too_long" }, 400);

  const familyId = String(payload?.family_id || "");
  if (!familyId) return jsonResponse({ error: "missing_family_id" }, 400);

  const clientHistory: Array<{ role: string; content: string }> = Array.isArray(payload?.history) ? payload.history : [];

  // 🔒 ai_enabled revérifié côté serveur à chaque appel, jamais fait confiance
  // à un état client (même pattern que ai-rephrase-message).
  const { data: subRow, error: subErr } = await admin
    .from("subscriptions").select("ai_enabled").eq("user_id", userId).maybeSingle();
  if (subErr) return jsonResponse({ error: subErr.message }, 500);
  if (!subRow?.ai_enabled) return jsonResponse({ error: "forbidden" }, 403);

  // ── Anti-abus : plafond quotidien simple (non-atomique, même schéma/
  // justification que rephrase_message — voir migrations 0044/0045). Une
  // seule ligne par QUESTION, pas par aller-retour d'outil interne. ──
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countErr } = await admin
    .from("ai_usage_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId).eq("feature", "chatbot_query").gte("used_at", since24h);
  if (countErr) return jsonResponse({ error: countErr.message }, 500);
  if ((count || 0) >= DAILY_LIMIT) return jsonResponse({ error: "daily_limit_reached" }, 429);

  // 🔒 Client JWT-scopé pour les outils — les mêmes règles RLS déjà en
  // vigueur pour ce compte/rôle s'appliquent automatiquement (voir spec).
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  // `messages` est l'état de travail INTERNE à cette requête (peut contenir
  // des blocs tool_use/tool_result) — jamais renvoyé tel quel au client, voir
  // cleanHistory plus bas.
  const messages: any[] = [...clientHistory.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: question }];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          thinking: { type: "disabled" },
          tools: TOOLS,
          messages,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        console.error("ai-chatbot: Anthropic error", errBody);
        return jsonResponse({ error: "chatbot_failed" }, 500);
      }
      const data = await res.json();
      const content = data?.content || [];

      if (data?.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content });
        const toolResults = [];
        for (const block of content) {
          if (block.type !== "tool_use") continue;
          const result = await executeTool(block.name, block.input, { userClient, admin, familyId, callerUserId: userId });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // stop_reason "end_turn" (ou autre) : réponse finale.
      const textBlock = content.find((b: any) => b.type === "text");
      const answer = String(textBlock?.text || "").trim();
      if (!answer) return jsonResponse({ error: "chatbot_failed" }, 500);

      await admin.from("ai_usage_log").insert({ user_id: userId, feature: "chatbot_query" });

      // 🔧 cleanHistory ne contient QUE des tours texte user/assistant — jamais
      // les blocs tool_use/tool_result internes à cette requête. Le client
      // renvoie cette valeur telle quelle comme `history` au prochain appel.
      const cleanHistory = [...clientHistory, { role: "user", content: question }, { role: "assistant", content: answer }].slice(-MAX_HISTORY_ENTRIES);
      return jsonResponse({ answer, history: cleanHistory });
    }
    return jsonResponse({ error: "too_many_tool_rounds" }, 500);
  } catch (e) {
    console.error("ai-chatbot: request failed", e);
    return jsonResponse({ error: "chatbot_failed" }, 500);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/ai-chatbot/index.ts
git commit -m "Add ai-chatbot Edge Function with tool-calling over Claude

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `ChatbotBubble` — floating chat UI

**Files:**
- Modify: `src/App.jsx` (new component `ChatbotBubble`, mounted once at the app root)

**Interfaces:**
- Consumes: `sub.aiEnabled`, `familySync.familyId` (both already in `useApp()`'s context value), `ai-chatbot` Edge Function from Task 2, i18n keys from Task 4.
- Produces: nothing consumed by later tasks — this is the final user-facing surface.

- [ ] **Step 1: Add the `ChatbotBubble` component**

Find (`PremiumTab`'s own top-level declaration, used here only as a stable, unique anchor point — insert immediately BEFORE it):

```jsx
function PremiumTab() {
```

Insert this new component immediately before that line:

```jsx
function ChatbotBubble() {
  const { C, t, sub, familySync } = useApp();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role:"user"|"assistant", content:string}
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");

  // 🔧 ChatbotBubble reste monté en permanence (jamais démonté) — sans ça,
  // basculer d'une famille à l'autre (cas multi-famille observateur) laisserait
  // l'historique de conversation de l'ANCIENNE famille affiché après le
  // changement, alors que le prochain message interrogerait la NOUVELLE
  // famille (family_id envoyé à chaque appel). Réinitialise la conversation à
  // chaque changement de famille active.
  useEffect(() => { setMessages([]); setErr(""); }, [familySync?.familyId]);

  if (!sub?.aiEnabled || !familySync?.familyId) return null;

  async function send() {
    const question = input.trim();
    if (!question || sending) return;
    setSending(true); setErr("");
    const nextMessages = [...messages, { role: "user", content: question }];
    setMessages(nextMessages);
    setInput("");
    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      const { data, error } = await supabase.functions.invoke("ai-chatbot", {
        body: { question, family_id: familySync.familyId, history },
      });
      if (error) throw new Error("generic");
      if (data?.error === "daily_limit_reached") throw new Error("daily");
      if (data?.error) throw new Error("generic");
      setMessages([...nextMessages, { role: "assistant", content: data?.answer || "" }]);
    } catch (e) {
      setErr(e.message === "daily" ? (t.chatbotDailyLimitError||"⚠️ Limite quotidienne de questions atteinte. Réessaie demain.") : (t.chatbotError||"⚠️ Une erreur est survenue. Réessaie."));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button onClick={()=>setOpen(o=>!o)} style={{position:"fixed",bottom:20,right:20,width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",border:"none",fontSize:24,cursor:"pointer",boxShadow:"0 4px 16px rgba(0,0,0,.25)",zIndex:900,display:"flex",alignItems:"center",justifyContent:"center"}}>
        {open ? "✕" : "🤖"}
      </button>
      {open && (
        <div style={{position:"fixed",bottom:86,right:20,width:340,maxWidth:"calc(100vw - 40px)",height:460,maxHeight:"calc(100vh - 140px)",background:C.card,borderRadius:16,boxShadow:"0 8px 32px rgba(0,0,0,.3)",display:"flex",flexDirection:"column",zIndex:900,overflow:"hidden"}}>
          <div style={{padding:"12px 14px",background:`linear-gradient(135deg,${C.vio},${C.blu})`,color:"#fff",fontWeight:800,fontSize:14}}>
            🤖 {t.chatbotTitle||"Assistant Duvia"}
          </div>
          <div style={{flex:1,overflowY:"auto",padding:12,display:"flex",flexDirection:"column",gap:8}}>
            {messages.length===0 && <div style={{fontSize:12,color:C.mut,textAlign:"center",marginTop:20}}>{t.chatbotEmptyState||"Pose-moi une question sur ta famille ou sur l'utilisation de Duvia."}</div>}
            {messages.map((m,i)=>(
              <div key={i} style={{alignSelf:m.role==="user"?"flex-end":"flex-start",maxWidth:"85%",padding:"8px 12px",borderRadius:12,fontSize:13,lineHeight:1.4,whiteSpace:"pre-wrap",background:m.role==="user"?C.vio:C.sur,color:m.role==="user"?"#fff":C.txt}}>
                {m.content}
              </div>
            ))}
            {sending && <div style={{alignSelf:"flex-start",fontSize:12,color:C.mut}}>{t.chatbotThinking||"Réflexion…"}</div>}
          </div>
          {err && <div style={{padding:"0 12px 8px",fontSize:11,color:C.red}}>{err}</div>}
          <div style={{display:"flex",gap:8,padding:12,borderTop:`1px solid ${C.bor}`}}>
            <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")send();}}
              placeholder={t.chatbotPlaceholder||"Écris ta question…"} disabled={sending}
              style={{flex:1,height:38,padding:"0 12px",border:`1px solid ${C.bor}`,borderRadius:8,fontSize:13}} />
            <button onClick={send} disabled={sending||!input.trim()}
              style={{width:38,height:38,background:C.vio,color:"#fff",border:"none",borderRadius:8,cursor:"pointer",opacity:(sending||!input.trim())?.5:1}}>➤</button>
          </div>
        </div>
      )}
    </>
  );
}

function PremiumTab() {
```

- [ ] **Step 2: Mount it once at the app root**

Find (right after the bell-panel mount, inside the main render's `<AppContext.Provider>` — this is the exact line already present in the file):

```jsx
      {bell && <BellPanel onClose={()=>setBell(false)} />}
```

Replace with:

```jsx
      {bell && <BellPanel onClose={()=>setBell(false)} />}
      <ChatbotBubble />
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
git commit -m "Add ChatbotBubble floating chat UI, mounted at app root

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: i18n keys (5 languages)

**Files:**
- Modify: `src/i18n/fr.js`, `src/i18n/en.js`, `src/i18n/de.js`, `src/i18n/es.js`, `src/i18n/pt.js`

**Interfaces:**
- Produces: `chatbotTitle`, `chatbotEmptyState`, `chatbotPlaceholder`, `chatbotThinking`, `chatbotError`, `chatbotDailyLimitError` — consumed by Task 3.

- [ ] **Step 1: Add keys to `src/i18n/fr.js`**

Find the existing line `premAiActiveLabel:"Premium+IA Actif 🤖",` and add immediately after it:

```js
    chatbotTitle:"Assistant Duvia",
    chatbotEmptyState:"Pose-moi une question sur ta famille ou sur l'utilisation de Duvia.",
    chatbotPlaceholder:"Écris ta question…",
    chatbotThinking:"Réflexion…",
    chatbotError:"⚠️ Une erreur est survenue. Réessaie.",
    chatbotDailyLimitError:"⚠️ Limite quotidienne de questions atteinte. Réessaie demain.",
```

- [ ] **Step 2: Add keys to `src/i18n/en.js`**

Find the existing line `premAiActiveLabel:"Premium+AI Active 🤖",` and add immediately after it:

```js
    chatbotTitle:"Duvia Assistant",
    chatbotEmptyState:"Ask me a question about your family or about using Duvia.",
    chatbotPlaceholder:"Type your question…",
    chatbotThinking:"Thinking…",
    chatbotError:"⚠️ Something went wrong. Try again.",
    chatbotDailyLimitError:"⚠️ Daily question limit reached. Try again tomorrow.",
```

- [ ] **Step 3: Add keys to `src/i18n/de.js`**

Find the line `premFeatExportSchedule` (or the file's closing area if `premFeat*` keys are absent — this file has none of the `premFeat*`/`prem*Label` family, per the established French/English-only precedent for that specific key group) and add these NEW, standalone keys near the end of the object, right before its closing `};`:

```js
    chatbotTitle:"Duvia-Assistent",
    chatbotEmptyState:"Stelle mir eine Frage zu deiner Familie oder zur Nutzung von Duvia.",
    chatbotPlaceholder:"Schreibe deine Frage…",
    chatbotThinking:"Denke nach…",
    chatbotError:"⚠️ Etwas ist schiefgelaufen. Versuche es erneut.",
    chatbotDailyLimitError:"⚠️ Tägliches Fragenlimit erreicht. Versuche es morgen erneut.",
```

- [ ] **Step 4: Add keys to `src/i18n/es.js`**

Same placement approach as Step 3 (near the end of the object, before its closing `};`):

```js
    chatbotTitle:"Asistente Duvia",
    chatbotEmptyState:"Hazme una pregunta sobre tu familia o sobre el uso de Duvia.",
    chatbotPlaceholder:"Escribe tu pregunta…",
    chatbotThinking:"Pensando…",
    chatbotError:"⚠️ Algo salió mal. Inténtalo de nuevo.",
    chatbotDailyLimitError:"⚠️ Límite diario de preguntas alcanzado. Inténtalo mañana.",
```

- [ ] **Step 5: Add keys to `src/i18n/pt.js`**

Same placement approach as Step 3 (near the end of the object, before its closing `};`):

```js
    chatbotTitle:"Assistente Duvia",
    chatbotEmptyState:"Faça-me uma pergunta sobre a sua família ou sobre a utilização do Duvia.",
    chatbotPlaceholder:"Escreve a tua pergunta…",
    chatbotThinking:"A pensar…",
    chatbotError:"⚠️ Ocorreu um erro. Tenta novamente.",
    chatbotDailyLimitError:"⚠️ Limite diário de perguntas atingido. Tenta novamente amanhã.",
```

**Note for the implementer**: unlike the `premFeat*`/`prem*Label` family (confirmed absent from `de.js`/`es.js`/`pt.js` by established precedent — see `App.jsx`'s `PremiumTab`), this chatbot feature is BRAND NEW user-facing UI, not an extension of an already-French/English-only area — per this project's standing instruction, translate proactively into all 5 languages, do not skip DE/ES/PT.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: builds clean (no test covers i18n file syntax directly, build is the check).

- [ ] **Step 7: Commit**

```bash
git add src/i18n/fr.js src/i18n/en.js src/i18n/de.js src/i18n/es.js src/i18n/pt.js
git commit -m "Add i18n keys for the chatbot assistant (all 5 languages)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Version bump and final verification

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
git commit -m "Bump version for the AI chatbot assistant feature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Print deployment instructions for the user**

This feature needs 2 manual steps outside this repo before it works in production, in this order:
1. Run `supabase/migrations/0045_chatbot_query_feature.sql` in the Supabase SQL Editor (production project).
2. Create a new Edge Function named exactly `ai-chatbot` in the Supabase dashboard, paste the full contents of `supabase/functions/ai-chatbot/index.ts` (written in Task 2), deploy. No new secret is required — it reuses the `ANTHROPIC_API_KEY` secret already configured for `ai-rephrase-message`.

Print the full current contents of `supabase/functions/ai-chatbot/index.ts` and the migration file in the final report so the user can copy-paste them directly, per this project's standing convention for Edge Function deployment instructions.

Also remind the user of the manual/live verification checklist from the spec's "Test / vérification" section (no automated test can cover a real API call): general question, expense balance accuracy, forgotten reimbursements + monthly summary, weather accuracy, school schedule accuracy, message summary accuracy, message-tone reformulation via chat, translation, calendar question (must decline gracefully), legal question (must decline + redirect), and the 21st-question-same-day rate limit.

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage**: access gate reused ✅ (Global Constraints), Edge Function + system prompt + all 4 tools + the 6 merged capabilities (extended parental help, summaries, expense balance/forgotten reimbursements/upcoming recurring, school schedule, translation, conversational tone coaching) ✅ (Task 2's system prompt and tool set), JWT-scoped tool execution with the weather-tool exception documented and justified ✅ (Task 2, Global Constraints), floating bubble UI with ephemeral history ✅ (Task 3), i18n ✅ (Task 4), version bump + deployment instructions ✅ (Task 5). No spec section left uncovered; calendar/vault/transitions/events/dashboard/legal-knowledge-base explicitly out of scope per the spec's Non-objectifs, nothing in this plan attempts them.
- **Placeholder scan**: no TBD/TODO; every step has literal code.
- **Type consistency**: `history` shape (`Array<{role:"user"|"assistant", content:string}>`) is identical across Task 2's Edge Function contract (both request `history` and response `history`) and Task 3's `ChatbotBubble` (`messages` state maps to exactly this shape before sending, and the response's `history`/`answer` are consumed the same way). `family_id` is sent by the client (Task 3, `familySync.familyId`) and read the same way server-side (Task 2, `payload.family_id`).
- **Formula fidelity check**: `computeExpenseBalance` in Task 2 was transcribed field-by-field from the live `ExpensesTab` code (`App.jsx:13744-13760`) during spec/plan research, not reconstructed from memory — same variable roles (`totals`/`owed`/`reimSent`/`reimReceived`/`balance`), same split-percentage convention (`split_pct` always expresses parent-index-1's share, regardless of who paid).
- **Weather privacy check**: `toolGetWeather` was deliberately modeled on the ALREADY-SHIPPED `get-family-weather` function's exact security pattern (service-role read of `parent_locations`, membership verified via the caller's own JWT-scoped client first, only derived forecast fields ever returned) rather than a naive "just use the JWT-scoped client for everything" approach — `parent_locations` has no family-wide RLS policy by deliberate design (migration 0035), confirmed by reading that migration directly, not assumed.
- **Multi-family reset check (found during pre-flight review, fixed in the plan before dispatch)**: `ChatbotBubble` is mounted unconditionally at the app root and never unmounts, so its `messages` state would otherwise survive a family switch (the observer multi-family scenario already documented elsewhere in this project) — the previously-active family's figures would stay visible on screen while the next message actually queries the newly-active family (`family_id` is read fresh from `familySync.familyId` on every send). Added a `useEffect` keyed on `familySync?.familyId` that clears `messages`/`err` on every family change, declared before the component's early-return gate (respects this project's established "hooks before any gate" rule).
