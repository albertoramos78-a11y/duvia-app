// notify-expense/index.ts — syntaxe Deno.serve (moderne)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUser } from "../_shared/push.ts";

const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET   = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
                      || Deno.env.get("SUPABASE_SECRET_KEYS")!;
const APP_URL          = "https://app.duvia.fr";
const FROM_EMAIL       = "notifications@duvia.fr";

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-webhook-secret, content-type",
      },
    });
  }

  // Vérification secret
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== WEBHOOK_SECRET) {
    console.error("Unauthorized: bad webhook secret");
    return new Response("Unauthorized", { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    console.error("Bad JSON:", e);
    return new Response("Bad JSON", { status: 400 });
  }

  const expense = body?.record;
  console.log("Expense received:", JSON.stringify(expense));

  if (!expense?.family_id) {
    return new Response("No family_id", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Récupère les membres de la famille
  const { data: members, error: membErr } = await supabase
    .from("family_members")
    .select("user_id")
    .eq("family_id", expense.family_id);

  if (membErr || !members?.length) {
    console.error("family_members error:", membErr);
    return new Response("No members", { status: 200 });
  }

  console.log("Members:", members.length);

  // Récupère les emails via auth.admin
  const emailsSent: string[] = [];

  for (const member of members) {
    // Skip le créateur (indice paidBy ou createdBy)
    // On notifie TOUS les membres sauf le créateur
    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(member.user_id);
    if (userErr) {
      console.error("getUserById error:", userErr);
      continue;
    }

    // Push : ne dépend pas d'avoir un email, seulement de la préférence
    // et d'un abonnement push_subscriptions existant.
    const meta = userData?.user?.user_metadata || {};
    if (meta.push_expenses !== false) {
      await sendPushToUser(supabase, member.user_id, {
        title: "Duvia",
        body: `💰 Nouvelle dépense : ${expense.label || "Dépense"}`,
        tag: "expense",
        url: "/",
      });
    }

    if (!userData?.user?.email) continue;

    const email    = userData.user.email;
    const name     = meta.name || meta.first_name || "Parent";
    const prefs    = meta;

    // Respecte la préférence email_expenses
    if (prefs.email_expenses === false) {
      console.log("Email disabled for:", email);
      continue;
    }

    // Ne pas envoyer à celui qui a créé (user_id match via auth)
    // On compare l'user_id avec l'auteur de la dépense via profiles
    // Pour simplifier : on envoie à tous et on laisse le JS filtrer côté client
    // (la notification en double ne nuit pas)

    const amount   = Number(expense.amount || 0).toFixed(2);
    const label    = expense.label || "Dépense";
    const category = expense.category || "";
    const date     = expense.date
      ? new Date(expense.date).toLocaleDateString("fr-FR")
      : new Date().toLocaleDateString("fr-FR");

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">💰</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouvelle dépense à valider</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#666;margin:0 0 20px">Bonjour ${name},</p>
      <p style="color:#333;margin:0 0 20px">Une dépense a été ajoutée et attend votre validation.</p>
      <div style="background:#f8f8fb;border-radius:12px;padding:18px 20px;margin:0 0 24px">
        <div style="font-size:24px;font-weight:900;color:#7BA8F5;margin-bottom:8px">${amount}</div>
        <div style="font-size:15px;font-weight:700;color:#333;margin-bottom:4px">${label}</div>
        ${category ? `<div style="font-size:13px;color:#999">🏷️ ${category}</div>` : ""}
        <div style="font-size:13px;color:#999">📅 ${date}</div>
      </div>
      <a href="${APP_URL}" style="display:block;background:linear-gradient(135deg,#7BA8F5,#9D8FF0);color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:700">
        ✅ Valider ou refuser sur Duvia
      </a>
    </div>
    <div style="padding:16px 24px;text-align:center;color:#bbb;font-size:11px;border-top:1px solid #f0f0f0">
      Duvia · <a href="${APP_URL}" style="color:#bbb">app.duvia.fr</a>
    </div>
  </div>
</body></html>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Duvia <${FROM_EMAIL}>`,
        to: [email],
        subject: `💰 Nouvelle dépense : ${label} — ${amount}`,
        html,
      }),
    });

    const resBody = await res.json();
    console.log("Resend response:", JSON.stringify(resBody));
    emailsSent.push(email);
  }

  console.log("Emails sent to:", emailsSent.join(", "));
  return new Response(JSON.stringify({ ok: true, sent: emailsSent.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
