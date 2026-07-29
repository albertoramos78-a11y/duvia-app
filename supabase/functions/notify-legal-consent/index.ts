import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!
const SB_URL     = Deno.env.get("SUPABASE_URL")!
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const APP_URL    = "https://app.duvia.fr"
const FROM       = "Duvia <notifications@duvia.fr>"

serve(async (req) => {
  // Vérifie que l'utilisateur est bien connecté via son JWT
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "")
  const supabase = createClient(SB_URL, SB_SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return new Response("Unauthorized", { status: 401 })

  const email = user.email
  if (!email || email.includes("@phone.duvia.app")) {
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
  }

  let noticeVersion = "?"
  try {
    const body = await req.json()
    if (body && typeof body.notice_version === "string") noticeVersion = body.notice_version
  } catch {}

  const name = user.user_metadata?.name || user.user_metadata?.full_name || email.split("@")[0]
  const now  = new Date().toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" })

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: "✅ Confirmation de votre consentement Duvia",
      html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#F8F2FF;margin:0;padding:20px;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 24px rgba(123,124,245,.1);">
  <div style="text-align:center;margin-bottom:24px;">
    <div style="font-size:40px">✅</div>
    <h1 style="color:#7B7CF5;font-size:20px;margin:8px 0 0">Consentement enregistré</h1>
  </div>
  <p style="color:#17103A;font-size:15px;line-height:1.6;text-align:center">
    Bonjour <strong>${name}</strong>,<br>
    le ${now}, vous avez accepté la politique de confidentialité et les conditions d'utilisation de Duvia (version ${noticeVersion}).
  </p>
  <p style="color:#17103A;font-size:13px;line-height:1.6;text-align:center;margin-top:16px;">
    Vous pouvez consulter ces documents à tout moment :
  </p>
  <div style="text-align:center;margin:16px 0;line-height:2.2;">
    <a href="${APP_URL}/?legal=cgu" style="color:#7B7CF5;font-weight:700;text-decoration:underline;">Conditions d'utilisation</a><br>
    <a href="${APP_URL}/?legal=cgv" style="color:#7B7CF5;font-weight:700;text-decoration:underline;">Conditions de vente</a><br>
    <a href="${APP_URL}/?legal=privacy" style="color:#7B7CF5;font-weight:700;text-decoration:underline;">Politique de confidentialité</a>
  </div>
  <p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px;">
    Duvia · Two homes. One family.
  </p>
</div>
</body></html>`,
    }),
  })

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
})
