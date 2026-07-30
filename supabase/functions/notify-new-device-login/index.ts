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

  // 🌍 Ville/pays approximatifs de la connexion (2026-07-30, demandé par
  // l'utilisateur) — géolocalisation par IP, forcément approximative
  // (niveau ville, peut être fausse avec un VPN/réseau mobile) : un signal
  // "est-ce que ça te ressemble ?", pas une localisation précise. L'IP vient
  // de cf-connecting-ip (Supabase Edge Functions tourne derrière Cloudflare,
  // en-tête fiable/non falsifiable par le client) avec repli sur
  // x-forwarded-for pour rester robuste si jamais absent.
  //
  // ip-api.com plutôt qu'ipapi.co : testé en direct sur prod, ipapi.co
  // renvoie un 429 (limite de débit gratuite) dès la 2e requête en quelques
  // minutes — bien trop fragile. ip-api.com tient 45 req/min en gratuit,
  // confirmé par les en-têtes X-Rl/X-Ttl de sa réponse. Contrepartie : pas
  // de HTTPS sur le tier gratuit d'ip-api.com — l'IP transite en clair sur
  // ce trajet serveur-à-serveur (jamais exposé au navigateur de
  // l'utilisateur), compromis accepté sciemment.
  //
  // `if (geoRes.ok)` fait toute la robustesse : un 429 (quota dépassé), un
  // timeout ou une IP locale (dev) laissent simplement locationLabel vide —
  // jamais bloquant pour l'envoi de l'email lui-même.
  const clientIp = req.headers.get("cf-connecting-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "";
  let locationLabel = "";
  if (clientIp) {
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${clientIp}?fields=status,city,country`, { signal: AbortSignal.timeout(2500) });
      if (geoRes.ok) {
        const geo = await geoRes.json();
        if (geo?.status === "success" && geo.city && geo.country) {
          locationLabel = `${geo.city}, ${geo.country}`;
        }
      }
    } catch (e) {
      console.warn("notify-new-device-login: geoloc lookup failed", e);
    }
  }

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
      <p style="color:#333;margin:0 0 4px;font-weight:700">${deviceInfo} — ${now}</p>
      ${locationLabel ? `<p style="color:#666;margin:0 0 20px;font-size:13px">📍 Localisation approximative : ${locationLabel}</p>` : `<div style="margin-bottom:20px"></div>`}
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
