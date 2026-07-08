import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { sendPushToUser } from "./_shared/push.ts"

const RESEND_KEY  = Deno.env.get("RESEND_API_KEY")!
const SB_URL      = Deno.env.get("SUPABASE_URL")!
const SB_SERVICE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const HOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!
const APP_URL     = "https://app.duvia.fr"
const FROM        = "Duvia <notifications@duvia.fr>"

serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== HOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 })
  }
  try {
    const { record } = await req.json()
    if (!record?.family_id) return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })

    const supabase = createClient(SB_URL, SB_SERVICE, {
      auth: { autoRefreshToken: false, persistSession: false }
    })

    const familyId   = record.family_id
    const docName    = record.name || "un document"
    const uploaderId = record.uploaded_by || record.user_id || record.created_by || null

    // Membres actifs de la famille
    const { data: members } = await supabase
      .from("family_members")
      .select("user_id")
      .eq("family_id", familyId)
      .eq("status", "active")

    if (!members?.length) return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })

    // Nom de l'expéditeur
    let uploaderName = "Un parent"
    if (uploaderId) {
      try {
        const { data: { user: up } } = await supabase.auth.admin.getUserById(uploaderId)
        const m = up?.user_metadata || {}
        uploaderName = m.name || m.full_name || up?.email?.split("@")[0] || "Un parent"
      } catch {}
    }

    for (const member of members) {
      if (member.user_id === uploaderId) continue
      try {
        const { data: { user } } = await supabase.auth.admin.getUserById(member.user_id)

        // Push : ne dépend pas d'avoir un email, seulement de la préférence
        // et d'un abonnement push_subscriptions existant.
        if (user?.user_metadata?.push_vault !== false) {
          await sendPushToUser(supabase, member.user_id, {
            title: "Duvia",
            body: `🗄️ ${uploaderName} a ajouté "${docName}"`,
            tag: "vault",
            url: "/",
          })
        }

        const email = user?.email
        if (!email || email.includes("@phone.duvia.app")) continue
        if (user?.user_metadata?.email_vault === false) continue

        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM,
            to: [email],
            subject: `🗄️ ${uploaderName} a ajouté un document`,
            html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#F8F2FF;margin:0;padding:20px;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 24px rgba(123,124,245,.1);">
  <div style="text-align:center;margin-bottom:24px;">
    <div style="font-size:40px">🗄️</div>
    <h1 style="color:#7B7CF5;font-size:20px;margin:8px 0 0">Nouveau document</h1>
  </div>
  <p style="color:#17103A;font-size:15px;line-height:1.6;text-align:center">
    <strong>${uploaderName}</strong> a ajouté <strong>${docName}</strong> dans le coffre-fort.
  </p>
  <div style="text-align:center;margin:28px 0">
    <a href="${APP_URL}" style="background:linear-gradient(135deg,#7B7CF5,#7BA8F5);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">
      Voir le document →
    </a>
  </div>
  <p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px;line-height:1.6">
    Duvia · Two homes. One family.<br>
    <a href="${APP_URL}" style="color:#7B7CF5;">Gérer mes préférences dans l'app</a>
  </p>
</div>
</body></html>`,
          }),
        })
      } catch(e) { console.warn("notify-vault member failed:", e) }
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
  } catch (e) {
    console.error(e)
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
