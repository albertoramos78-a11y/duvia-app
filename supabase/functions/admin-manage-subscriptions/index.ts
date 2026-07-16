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
    const userId = String(payload?.user_id || "").trim();
    if (!userId) return jsonResponse({ error: "missing_user_id" }, 400);

    // Passe par l'API admin Supabase (auth.users) — fiable pour n'importe
    // quel compte réel, contrairement à une recherche par email basée sur
    // family_members.email (pas toujours rempli, ex. un parent jamais passé
    // par le flux d'invitation observateur, ou connecté via Google).
    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(userId);
    if (userErr || !userData?.user) return jsonResponse({ error: "user_not_found" }, 404);
    const { data: member } = await admin.from("family_members").select("display_name").eq("user_id", userId).limit(1).maybeSingle();
    const { data: subRow } = await admin.from("subscriptions").select("*").eq("user_id", userId).maybeSingle();
    const meta = userData.user.user_metadata || {};
    const name = member?.display_name || meta.full_name || meta.name || null;
    return jsonResponse({ user_id: userId, name, email: userData.user.email || null, sub: subRow || null });
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

    // 📝 Snapshot AVANT modification — permet un vrai "annuler" plus tard
    // (revert_change ci-dessous), pas juste un historique en lecture seule.
    const { data: previousRow } = await admin.from("subscriptions").select("*").eq("user_id", userId).maybeSingle();

    const { error } = await admin.from("subscriptions").upsert({ user_id: userId, ...update }, { onConflict: "user_id" });
    if (error) return jsonResponse({ error: error.message }, 500);

    await admin.from("admin_subscription_log").insert({
      admin_id: callerData.user.id,
      target_user_id: userId,
      previous_state: previousRow || null,
      new_plan: plan,
    });

    return jsonResponse({ ok: true });
  }

  if (action === "set_global_beta") {
    const enabled = !!payload?.enabled;
    const endDate = payload?.end_date || null;
    const { error } = await admin.from("app_config").update({ beta_enabled: enabled, beta_end: endDate }).eq("id", 1);
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === "list_premium_users") {
    // Ne liste que les comptes déjà modifiés depuis CE panneau admin (voir
    // admin_subscription_log) — jamais les vrais abonnés Stripe/organiques
    // qui n'ont jamais été touchés ici. Couvre les 3 statuts forçables :
    // freemium / trial_premium / premium (la bêta par compte a été retirée
    // de l'UI, voir AccountSubscriptionCard côté client).
    const { data: logRows, error: logErr } = await admin.from("admin_subscription_log").select("target_user_id");
    if (logErr) return jsonResponse({ error: logErr.message }, 500);
    const targetIds = [...new Set((logRows || []).map((r) => r.target_user_id))];
    if (targetIds.length === 0) return jsonResponse({ subscribers: [] });

    const { data: rows, error } = await admin
      .from("subscriptions")
      .select("user_id, plan, premium_since, cycle, trial_start")
      .in("user_id", targetIds)
      .in("plan", ["freemium", "trial_premium", "premium"]);
    if (error) return jsonResponse({ error: error.message }, 500);
    const results = [];
    for (const row of rows || []) {
      const { data: userData } = await admin.auth.admin.getUserById(row.user_id);
      const { data: member } = await admin.from("family_members").select("display_name").eq("user_id", row.user_id).limit(1).maybeSingle();
      const meta = userData?.user?.user_metadata || {};
      results.push({
        user_id: row.user_id,
        name: member?.display_name || meta.full_name || meta.name || null,
        email: userData?.user?.email || null,
        plan: row.plan,
        premium_since: row.premium_since,
        cycle: row.cycle,
        trial_start: row.trial_start,
      });
    }
    return jsonResponse({ subscribers: results });
  }

  if (action === "list_admin_changes") {
    const { data: rows, error } = await admin
      .from("admin_subscription_log")
      .select("id, admin_id, target_user_id, previous_state, new_plan, changed_at")
      .order("changed_at", { ascending: false })
      .limit(50);
    if (error) return jsonResponse({ error: error.message }, 500);
    const results = [];
    for (const row of rows || []) {
      const { data: adminData } = await admin.auth.admin.getUserById(row.admin_id);
      const { data: targetData } = await admin.auth.admin.getUserById(row.target_user_id);
      results.push({
        id: row.id,
        admin_email: adminData?.user?.email || null,
        target_user_id: row.target_user_id,
        target_email: targetData?.user?.email || null,
        previous_plan: row.previous_state?.plan || null,
        new_plan: row.new_plan,
        changed_at: row.changed_at,
        can_revert: !!row.previous_state,
      });
    }
    return jsonResponse({ changes: results });
  }

  if (action === "revert_change") {
    const logId = payload?.log_id;
    if (!logId) return jsonResponse({ error: "missing_log_id" }, 400);
    const { data: logRow, error: logErr } = await admin.from("admin_subscription_log").select("*").eq("id", logId).maybeSingle();
    if (logErr || !logRow) return jsonResponse({ error: "log_not_found" }, 404);

    if (logRow.previous_state) {
      // Restaure exactement la ligne subscriptions telle qu'elle était avant
      // ce changement (tous les champs, pas seulement plan/cycle/dates).
      const { error } = await admin.from("subscriptions").upsert(logRow.previous_state, { onConflict: "user_id" });
      if (error) return jsonResponse({ error: error.message }, 500);
    } else {
      // Le compte n'avait aucune ligne subscriptions avant ce changement —
      // "annuler" veut dire supprimer celle créée depuis.
      const { error } = await admin.from("subscriptions").delete().eq("user_id", logRow.target_user_id);
      if (error) return jsonResponse({ error: error.message }, 500);
    }

    await admin.from("admin_subscription_log").insert({
      admin_id: callerData.user.id,
      target_user_id: logRow.target_user_id,
      previous_state: null, // reverts don't chain further back
      new_plan: `revert_of_${logId}`,
    });

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "unknown_action" }, 400);
});
