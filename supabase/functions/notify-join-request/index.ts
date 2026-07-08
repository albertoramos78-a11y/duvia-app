// supabase/functions/notify-join-request/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Déclenchée par le webhook Supabase sur family_members INSERT.
// Prévient les parents actifs qu'un observateur ou un enfant a rejoint (ou
// demande à rejoindre) la famille. Ignore les insertions de parents.
// Aucune préférence "email_join_requests"/"push_join_requests" n'existait
// avant ce chantier — les deux sont nouvelles.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUser } from "../_shared/push.ts";

const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_SECRET   = Deno.env.get("WEBHOOK_SECRET")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM_EMAIL       = "notifications@duvia.fr";
const APP_URL          = "https://app.duvia.fr";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-webhook-secret, content-type",
      },
    });
  }

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

  const joiner = payload?.record;
  if (!joiner?.family_id || !joiner?.user_id) {
    return new Response("Missing member data", { status: 400 });
  }
  if (joiner.role === "parent") {
    return new Response("Parent join, ignored", { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: parents } = await supabase
    .from("family_members")
    .select("user_id, profiles(email, first_name)")
    .eq("family_id", joiner.family_id)
    .eq("role", "parent")
    .eq("status", "active");

  if (!parents?.length) return new Response("No parents to notify", { status: 200 });

  const joinerName = joiner.display_name || "Un nouveau membre";
  const isPending = joiner.status === "pending";
  const body = isPending
    ? `👥 ${joinerName} demande à rejoindre la famille`
    : `🧒 ${joinerName} a rejoint la famille`;

  for (const parent of parents) {
    const { data: userMeta } = await supabase.auth.admin.getUserById(parent.user_id);
    const prefs = userMeta?.user?.user_metadata || {};

    if (prefs.push_join_requests !== false) {
      await sendPushToUser(supabase, parent.user_id, {
        title: "Duvia",
        body,
        tag: "join-request",
        url: "/",
      });
    }

    if (prefs.email_join_requests === false) continue;
    const profile = Array.isArray(parent.profiles) ? parent.profiles[0] : parent.profiles;
    const email = profile?.email;
    const name  = profile?.first_name || "Parent";
    if (!email) continue;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#7BA8F5,#9D8FF0);padding:28px 24px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">👥</div>
      <div style="color:#fff;font-size:18px;font-weight:800">${isPending ? "Demande à valider" : "Nouveau membre"}</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#666;margin:0 0 20px">Bonjour ${name},</p>
      <p style="color:#333;margin:0 0 24px">${body}.</p>
      <a href="${APP_URL}" style="display:block;background:linear-gradient(135deg,#7BA8F5,#9D8FF0);color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:700">
        👥 Voir sur Duvia
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
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Duvia <${FROM_EMAIL}>`,
        to: [email],
        subject: `👥 ${joinerName} — ${isPending ? "demande à rejoindre" : "a rejoint"} Duvia`,
        html,
      }),
    });
  }

  return new Response("ok", { status: 200 });
});
