// supabase/functions/send-invite-email/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL       = "notifications@duvia.fr";
const APP_URL          = "https://app.duvia.fr";

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

  // ── Anti-abus : vérification ET enregistrement atomiques dans une seule
  // transaction Postgres (RPC check_and_log_invite_email, migration 0043) —
  // corrige une course TOCTOU trouvée en revue où 2 SELECT count() séparés
  // suivis d'un INSERT plus tard permettaient à une rafale de requêtes
  // concurrentes de toutes passer le contrôle avant qu'aucun INSERT n'ait
  // eu lieu. La ligne est déjà insérée à ce stade si status==="ok" — voir
  // la compensation après un échec Resend plus bas.
  const { data: rpcRows, error: rpcErr } = await admin.rpc("check_and_log_invite_email", {
    p_sender_user_id: senderId,
    p_recipient_email: to,
    p_invite_type: type,
  });
  if (rpcErr) return jsonResponse({ error: rpcErr.message }, 500);
  const rpcResult = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  if (rpcResult?.status === "daily_limit_reached") return jsonResponse({ error: "daily_limit_reached" }, 429);
  if (rpcResult?.status === "recipient_limit_reached") return jsonResponse({ error: "recipient_limit_reached" }, 429);
  const logId = rpcResult?.log_id;

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
      // Compense la réservation : un échec Resend ne doit jamais consommer
      // le plafond anti-abus de l'utilisateur.
      if (logId) {
        const { error: cleanupErr } = await admin.from("invite_email_log").delete().eq("id", logId);
        if (cleanupErr) console.error("send-invite-email: failed to release quota reservation", logId, cleanupErr);
      }
      return jsonResponse({ error: "send_failed" }, 500);
    }
  } catch (e) {
    console.error("send-invite-email: Resend send failed", e);
    if (logId) {
      const { error: cleanupErr } = await admin.from("invite_email_log").delete().eq("id", logId);
      if (cleanupErr) console.error("send-invite-email: failed to release quota reservation", logId, cleanupErr);
    }
    return jsonResponse({ error: "send_failed" }, 500);
  }

  return jsonResponse({ ok: true });
});
