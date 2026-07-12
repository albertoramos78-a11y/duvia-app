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

  // 🔒 record.comment est du texte libre saisi par l'utilisateur — jamais
  // interpolé tel quel dans le HTML de l'email, sinon un commentaire de bug
  // pourrait injecter des balises (faux lien, mise en page cassée, etc.)
  // dans le mail reçu par duvia.services@gmail.com.
  function escapeHtml(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const comment    = escapeHtml(record.comment || "(aucun commentaire)");
  const appVersion = escapeHtml(record.app_version || "?");
  const platform   = escapeHtml(record.system?.platform || "?");
  const userAgent  = escapeHtml(record.system?.userAgent || "?");
  const userId     = escapeHtml(record.user_id || "non connecté");
  const familyId   = escapeHtml(record.family_id || "aucune famille");
  const reportId   = escapeHtml(record.id || "?");

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
