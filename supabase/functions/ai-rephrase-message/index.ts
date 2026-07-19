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
        // 🔧 Thinking désactivé explicitement : ce modèle réfléchit par défaut
        // (adaptive thinking), ce qui insère un bloc "thinking" AVANT le bloc
        // "text" dans la réponse — content[0] devient alors ce bloc vide, pas
        // le texte reformulé. Une tâche de reformulation pure n'a besoin
        // d'aucun raisonnement, donc autant le désactiver plutôt que de
        // dépendre de la position du bloc dans le tableau.
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("ai-rephrase-message: Anthropic error", errBody);
      return jsonResponse({ error: "rephrase_failed" }, 500);
    }
    const data = await res.json();
    // 🔧 Cherche le bloc "text" par type plutôt que de supposer content[0] —
    // robuste même si un futur changement de modèle/paramètres réintroduit
    // un bloc "thinking" ou autre avant le texte.
    const textBlock = Array.isArray(data?.content) ? data.content.find((b: any) => b?.type === "text") : null;
    const rephrased = String(textBlock?.text || "").trim();
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
