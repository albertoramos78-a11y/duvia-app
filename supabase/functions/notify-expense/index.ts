// supabase/functions/notify-expense/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Déclenchée par le webhook Supabase sur expenses INSERT.
// Envoie un email à l'autre parent pour l'informer d'une nouvelle dépense.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY      = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET      = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM_EMAIL          = "notifications@duvia.fr";
const APP_URL             = "https://app.duvia.fr";

serve(async (req) => {
  // ── CORS ──────────────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-webhook-secret, content-type",
      },
    });
  }

  // ── Vérification du secret webhook ───────────────────────────────────────
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const expense = payload?.record;
  if (!expense?.family_id || !expense?.label) {
    return new Response("Missing expense data", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Récupère les membres de la famille ────────────────────────────────────
  const { data: members } = await supabase
    .from("family_members")
    .select("user_id, profiles(email, first_name)")
    .eq("family_id", expense.family_id);

  if (!members || members.length < 2) {
    return new Response("Not enough members", { status: 200 });
  }

  // ── Récupère les préférences email ────────────────────────────────────────
  const createdByUserId = expense.created_by !== undefined
    ? members.find((_: any, i: number) => i === expense.created_by)?.user_id
    : null;

  // Envoie à TOUS les membres SAUF celui qui a créé la dépense
  const recipients = members.filter((m: any) => m.user_id !== createdByUserId);

  for (const member of recipients) {
    const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
    const email   = profile?.email;
    const name    = profile?.first_name || "Parent";
    if (!email) continue;

    // Vérifie la préférence email_expenses
    const { data: userMeta } = await supabase.auth.admin.getUserById(member.user_id);
    const prefs = userMeta?.user?.user_metadata || {};
    if (prefs.email_expenses === false) continue;

    const amount   = Number(expense.amount || 0).toFixed(2);
    const currency = ""; // La devise est dans cfg, pas dans la table expenses
    const category = expense.category || "";
    const date     = expense.date ? new Date(expense.date).toLocaleDateString("fr-FR") : "";
    const creatorName = members.find((m: any) => m.user_id === createdByUserId)
      ? (Array.isArray(members.find((m: any) => m.user_id === createdByUserId)?.profiles)
          ? members.find((m: any) => m.user_id === createdByUserId)?.profiles[0]?.first_name
          : members.find((m: any) => m.user_id === createdByUserId)?.profiles?.first_name)
      : "Un parent";

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">💰</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouvelle dépense à valider</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#666;margin:0 0 20px">Bonjour ${name},</p>
      <p style="color:#333;margin:0 0 20px">
        <strong>${creatorName || "Un parent"}</strong> a ajouté une dépense qui attend votre validation.
      </p>
      <div style="background:#f8f8fb;border-radius:12px;padding:18px 20px;margin:0 0 24px">
        <div style="font-size:22px;font-weight:900;color:#7BA8F5;margin-bottom:8px">${amount} ${currency}</div>
        <div style="font-size:15px;font-weight:700;color:#333;margin-bottom:4px">${expense.label}</div>
        ${category ? `<div style="font-size:13px;color:#999">🏷️ ${category}</div>` : ""}
        ${date ? `<div style="font-size:13px;color:#999">📅 ${date}</div>` : ""}
      </div>
      <a href="${APP_URL}" style="display:block;background:linear-gradient(135deg,#7BA8F5,#9D8FF0);color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:700">
        ✅ Valider ou refuser sur Duvia
      </a>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · Two homes, One family · <a href="${APP_URL}" style="color:#bbb">app.duvia.fr</a>
    </div>
  </div>
</body>
</html>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Duvia <${FROM_EMAIL}>`,
        to: [email],
        subject: `💰 Nouvelle dépense : ${expense.label} — ${amount}`,
        html,
      }),
    });
  }

  return new Response("ok", { status: 200 });
});
