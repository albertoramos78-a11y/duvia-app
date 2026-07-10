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

  const name = user.user_metadata?.name || user.user_metadata?.full_name || email.split("@")[0]
  const now  = new Date().toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" })

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: "🔒 Votre mot de passe Duvia a été modifié",
      html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#F8F2FF;margin:0;padding:20px;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 24px rgba(123,124,245,.1);">
  <div style="text-align:center;margin-bottom:24px;">
    <div style="font-size:40px">🔒</div>
    <h1 style="color:#7B7CF5;font-size:20px;margin:8px 0 0">Mot de passe modifié</h1>
  </div>
  <p style="color:#17103A;font-size:15px;line-height:1.6;text-align:center">
    Bonjour <strong>${name}</strong>,<br>
    votre mot de passe Duvia a été modifié le <strong>${now}</strong>.
  </p>
  <p style="color:#17103A;font-size:13px;line-height:1.6;text-align:center;margin-top:16px;padding:14px;background:#FEF2F2;border-radius:10px;border:1px solid #FECACA;">
    ⚠️ Si vous n'êtes pas à l'origine de cette modification,<br>
    <strong>contactez-nous immédiatement</strong> à support@duvia.fr
  </p>
  <div style="text-align:center;margin:28px 0">
    <a href="${APP_URL}" style="background:linear-gradient(135deg,#7B7CF5,#7BA8F5);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">
      Accéder à mon compte →
    </a>
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
