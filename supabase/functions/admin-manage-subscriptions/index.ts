// supabase/functions/admin-manage-subscriptions/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
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

  // 🔒 Vérifie que l'appelant est authentifié ET listé dans app_admins.
  // Sans ce 2e check, n'importe quel compte connecté pourrait modifier
  // l'abonnement de n'importe qui en appelant cette fonction directement.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return jsonResponse({ error: "missing_authorization" }, 401);
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user?.id) return jsonResponse({ error: "invalid_token" }, 401);
  const { data: adminRow } = await admin.from("app_admins").select("user_id").eq("user_id", callerData.user.id).maybeSingle();
  if (!adminRow) return jsonResponse({ error: "forbidden" }, 403);

  const action: string | undefined = payload?.action;

  if (action === "lookup_user") {
    const email = String(payload?.email || "").trim().toLowerCase();
    if (!email) return jsonResponse({ error: "missing_email" }, 400);
    const { data: member } = await admin
      .from("family_members")
      .select("user_id, display_name, email")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (!member?.user_id) return jsonResponse({ error: "user_not_found" }, 404);
    const { data: subRow } = await admin.from("subscriptions").select("*").eq("user_id", member.user_id).maybeSingle();
    return jsonResponse({ user_id: member.user_id, name: member.display_name || null, email: member.email, sub: subRow || null });
  }

  if (action === "set_user_plan") {
    const userId = String(payload?.user_id || "");
    const plan = String(payload?.plan || "");
    if (!userId || !["freemium", "beta", "trial_premium", "premium"].includes(plan)) {
      return jsonResponse({ error: "invalid_params" }, 400);
    }
    let update: Record<string, unknown> = { plan };
    if (plan === "beta") {
      const betaEnd = payload?.beta_end;
      if (!betaEnd) return jsonResponse({ error: "missing_beta_end" }, 400);
      update.beta_end = betaEnd;
    } else if (plan === "trial_premium") {
      const now = new Date().toISOString();
      update = { ...update, account_created_at: now, trial_start: now, premium_since: null, trial_extension_days: 0 };
    } else if (plan === "premium") {
      const cycle = payload?.premium_cycle;
      if (!["monthly", "yearly"].includes(cycle)) return jsonResponse({ error: "invalid_cycle" }, 400);
      update = { ...update, premium_since: new Date().toISOString(), cycle };
    }
    const { error } = await admin.from("subscriptions").upsert({ user_id: userId, ...update });
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === "set_global_beta") {
    const enabled = !!payload?.enabled;
    const endDate = payload?.end_date || null;
    const { error } = await admin.from("app_config").update({ beta_enabled: enabled, beta_end: endDate }).eq("id", 1);
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "unknown_action" }, 400);
});
