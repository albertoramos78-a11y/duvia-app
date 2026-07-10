// supabase/functions/send-parent-verification-email/index.ts — syntaxe Deno.serve (moderne)
// ─────────────────────────────────────────────────────────────────────────────
// Appelée directement par le client (supabase.functions.invoke), juste après
// un signUp() réussi pour un rôle parent. Génère un jeton de vérification,
// l'enregistre dans parent_email_verifications (migration 0029), envoie
// l'email via Resend avec un lien ${APP_URL}/?verify_email=<token>.
//
// Ne s'appuie pas sur le mécanisme natif Supabase (email_confirmed_at) — voir
// docs/superpowers/specs/2026-07-10-parent-email-verification-design.md pour
// le pourquoi.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL           = "https://app.duvia.fr";
const FROM_EMAIL        = "notifications@duvia.fr";
const TOKEN_TTL_MS      = 24 * 60 * 60 * 1000; // 24h, cohérent avec family_invitations

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
  if (!userId || !email) {
    return new Response("Missing user_id or email", { status: 400, headers: CORS });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 🔒 Vérifie que l'appelant authentifié est bien le titulaire du compte visé
  // — sans ça, n'importe quel utilisateur connecté pourrait déclencher l'envoi
  // d'un email de vérification vers n'importe quel user_id de son choix.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("Missing authorization", { status: 401, headers: CORS });
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || callerData?.user?.id !== userId) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }

  const verifyToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const { error: insertErr } = await admin.from("parent_email_verifications").insert({
    user_id: userId,
    email,
    token: verifyToken,
    expires_at: expiresAt,
  });
  if (insertErr) {
    console.error("send-parent-verification-email: insert failed", insertErr);
    return new Response(JSON.stringify({ error: "insert_failed" }), { status: 500, headers: CORS });
  }

  const verifyUrl = `${APP_URL}/?verify_email=${verifyToken}`;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">✉️</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Confirme ton email</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#333;margin:0 0 20px">Clique sur le lien ci-dessous pour confirmer ton adresse email et accéder à Duvia.</p>
      <a href="${verifyUrl}" style="display:block;background:linear-gradient(135deg,#7BA8F5,#9D8FF0);color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:700">
        ✅ Confirmer mon email
      </a>
      <p style="color:#999;font-size:12px;margin-top:20px">Ce lien expire dans 24 heures.</p>
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
        subject: "✉️ Confirme ton email Duvia",
        html,
      }),
    });
    const resBody = await res.json();
    console.log("send-parent-verification-email: Resend response:", JSON.stringify(resBody));
  } catch (e) {
    console.error("send-parent-verification-email: Resend send failed", e);
    return new Response(JSON.stringify({ error: "send_failed" }), { status: 500, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
