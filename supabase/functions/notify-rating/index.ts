// supabase/functions/notify-rating/index.ts — syntaxe Deno.serve (moderne)
// ─────────────────────────────────────────────────────────────────────────────
// Déclenchée par un Database Webhook Supabase (Database → Webhooks, configuré
// dans le tableau de bord, PAS dans ce dépôt) sur INSERT dans `ratings`.
// INSERT-only par design : un upsert sur une ligne existante (modification
// d'un avis déjà laissé) déclenche un évènement UPDATE, jamais INSERT — donc
// cette fonction ne notifie jamais les modifications, seulement les nouveaux
// avis, sans code de filtrage supplémentaire. Voir docs/superpowers/specs/
// 2026-07-13-rating-email-notification-design.md.
// ─────────────────────────────────────────────────────────────────────────────

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET  = Deno.env.get("RATING_WEBHOOK_SECRET")!;
const APP_URL         = "https://app.duvia.fr";
const FROM_EMAIL      = "notifications@duvia.fr";
const ADMIN_EMAIL     = "duvia.services@gmail.com";

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

  // 🔒 comment et user_name sont du texte libre saisi par l'utilisateur —
  // jamais interpolés tels quels dans le HTML de l'email (même précaution
  // que notify-bug-report).
  function escapeHtml(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const stars     = Math.max(0, Math.min(5, Number(record.stars) || 0));
  const comment   = escapeHtml(record.comment || "(aucun commentaire)");
  const userName  = escapeHtml(record.user_name || "Anonyme");
  const plan      = escapeHtml(record.plan || "unknown");
  const userId    = escapeHtml(record.user_id || "?");
  const familyId  = escapeHtml(record.family_id || "aucune famille");

  const starsDisplay = "★".repeat(stars) + "☆".repeat(5 - stars);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:28px;letter-spacing:4px;color:#FFD700;margin-bottom:8px">${starsDisplay}</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouvel avis sur Duvia (${stars}/5)</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#333;margin:0 0 16px;white-space:pre-wrap">${comment}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#555">
        <tr><td style="padding:4px 0;font-weight:700">Utilisateur</td><td style="padding:4px 0">${userName}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Plan</td><td style="padding:4px 0">${plan}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">User ID</td><td style="padding:4px 0">${userId}</td></tr>
        <tr><td style="padding:4px 0;font-weight:700">Famille</td><td style="padding:4px 0">${familyId}</td></tr>
      </table>
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
        subject: `⭐ Nouvel avis sur Duvia (${stars}/5)`,
        html,
      }),
    });
    const resBody = await res.json();
    console.log("notify-rating: Resend response:", JSON.stringify(resBody));
  } catch (e) {
    console.error("notify-rating: Resend send failed", e);
    return new Response(JSON.stringify({ error: "send_failed" }), { status: 500, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
});
