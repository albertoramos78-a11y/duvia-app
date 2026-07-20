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
    .from("family_members").select("user_id").eq("family_id", familyId).eq("user_id", callerUserId).eq("status", "active").maybeSingle();
  if (!membership) return { error: "not_a_family_member" };

  const { data: parents } = await userClient
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
