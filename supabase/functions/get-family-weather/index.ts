// supabase/functions/get-family-weather/index.ts — syntaxe Deno.serve (moderne)
// ─────────────────────────────────────────────────────────────────────────────
// Seul chemin autorisé pour connaître la météo d'un AUTRE membre de la
// famille : le client envoie {family_id, target_user_id, date}, jamais de
// coordonnées. Cette fonction vérifie l'appartenance à la famille avec le JWT
// de l'appelant (RLS naturelle sur family_members), puis lit la ligne
// parent_locations de target_user_id AVEC le client service-role (contourne
// volontairement le RLS, uniquement pour cette lecture interne — jamais
// renvoyée telle quelle). Ne renvoie que {code, tempMax, tempMin} — jamais
// lat/lon, jamais city. Voir docs/superpowers/specs/2026-07-13-weather-
// location-privacy-design.md.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  const familyId = payload?.family_id;
  const targetUserId = payload?.target_user_id;
  const date = payload?.date; // "YYYY-MM-DD"
  if (!familyId || !targetUserId || !date) {
    return new Response("Missing family_id/target_user_id/date", { status: 400, headers: CORS });
  }

  // 🔒 Le client appelant s'identifie avec son propre JWT (Authorization
  // header transmis automatiquement par supabase.functions.invoke côté
  // client). On l'utilise pour vérifier son appartenance à la famille via la
  // RLS existante sur family_members — pas besoin de service role ici.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("Missing authorization", { status: 401, headers: CORS });

  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerUser, error: callerErr } = await callerClient.auth.getUser(token);
  if (callerErr || !callerUser?.user) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }

  const { data: membership } = await callerClient
    .from("family_members")
    .select("user_id")
    .eq("family_id", familyId)
    .eq("user_id", callerUser.user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!membership) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }

  // 🔒 Client service-role UNIQUEMENT pour cette lecture précise — la ligne
  // n'est jamais renvoyée telle quelle au client, seul le résumé météo dérivé
  // l'est.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: loc } = await admin
    .from("parent_locations")
    .select("lat, lon")
    .eq("user_id", targetUserId)
    .eq("family_id", familyId)
    .maybeSingle();
  if (!loc) {
    return new Response(JSON.stringify({ error: "no_location" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=16`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("weather fetch failed");
    const data = await res.json();
    const idx = (data?.daily?.time || []).indexOf(date);
    if (idx === -1) {
      return new Response(JSON.stringify({ error: "no_forecast_for_date" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    const result = {
      code: data.daily.weathercode[idx],
      tempMax: data.daily.temperature_2m_max[idx],
      tempMin: data.daily.temperature_2m_min[idx],
    };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  } catch (e) {
    console.error("get-family-weather: forecast fetch failed", e);
    return new Response(JSON.stringify({ error: "fetch_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
});
