// supabase/functions/notify-vault-document/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Déclenchée par le webhook Supabase sur vault_documents INSERT.
// Envoie un push + un email à tous les membres actifs de la famille sauf
// celui qui a ajouté le document. La préférence "email_vault" existait déjà
// côté UI mais n'était consommée par aucune fonction — ce fichier la rend
// enfin fonctionnelle, en plus d'ajouter le push.
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

  const doc = payload?.record;
  if (!doc?.family_id || !doc?.uploaded_by) {
    return new Response("Missing document data", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: members } = await supabase
    .from("family_members")
    .select("user_id, profiles(email, first_name)")
    .eq("family_id", doc.family_id)
    .eq("status", "active");

  const recipients = (members || []).filter((m: any) => m.user_id !== doc.uploaded_by);
  if (recipients.length === 0) return new Response("No recipients", { status: 200 });

  const uploaderName = doc.added_by_name || "Un membre de la famille";
  const docName = doc.name || "Document";

  for (const member of recipients) {
    const { data: userMeta } = await supabase.auth.admin.getUserById(member.user_id);
    const prefs = userMeta?.user?.user_metadata || {};

    if (prefs.push_vault !== false) {
      await sendPushToUser(supabase, member.user_id, {
        title: "Duvia",
        body: `🗄️ ${uploaderName} a ajouté "${docName}"`,
        tag: "vault",
        url: "/",
      });
    }

    if (prefs.email_vault === false) continue;
    const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
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
      <div style="font-size:36px;margin-bottom:8px">🗄️</div>
      <div style="color:#fff;font-size:18px;font-weight:800">Nouveau document</div>
    </div>
    <div style="padding:28px 24px">
      <p style="color:#666;margin:0 0 20px">Bonjour ${name},</p>
      <p style="color:#333;margin:0 0 24px"><strong>${uploaderName}</strong> a ajouté "${docName}" au coffre-fort.</p>
      <a href="${APP_URL}" style="display:block;background:linear-gradient(135deg,#7BA8F5,#9D8FF0);color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:700">
        🗄️ Voir sur Duvia
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
      body: JSON.stringify({ from: `Duvia <${FROM_EMAIL}>`, to: [email], subject: `🗄️ Nouveau document : ${docName}`, html }),
    });
  }

  return new Response("ok", { status: 200 });
});
