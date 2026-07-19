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

// 🔧 auth.users n'est pas exposé via l'API REST (PostgREST), même au service
// role — d'où l'API Admin dédiée (GoTrue) plutôt qu'un simple .from("users").
// Paginée : listUsers() plafonne à perPage résultats par appel.
async function listAllAnonymousUserIds(admin: ReturnType<typeof createClient>): Promise<string[]> {
  const ids: string[] = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    for (const u of users) if ((u as any).is_anonymous) ids.push(u.id);
    if (users.length < perPage) break;
  }
  return ids;
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

  if (action === "reset_user_to_default") {
    // "Retour défaut" — supprime le forçage admin (ligne subscriptions) pour
    // que ce compte redevienne un compte organique normal (repart sur un
    // Trial neuf à sa prochaine connexion, comme un tout nouveau compte).
    // Toujours loggé (previous_state rempli) pour pouvoir "Annuler" ensuite.
    const userId = String(payload?.user_id || "");
    if (!userId) return jsonResponse({ error: "missing_user_id" }, 400);

    const { data: previousRow } = await admin.from("subscriptions").select("*").eq("user_id", userId).maybeSingle();
    const { error } = await admin.from("subscriptions").delete().eq("user_id", userId);
    if (error) return jsonResponse({ error: error.message }, 500);

    await admin.from("admin_subscription_log").insert({
      admin_id: callerData.user.id,
      target_user_id: userId,
      previous_state: previousRow || null,
      new_plan: "reset_to_default",
    });

    return jsonResponse({ ok: true });
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

  if (action === "cleanup_anonymous_accounts") {
    // Version "bouton admin", rejouable, de la même logique que la migration
    // ponctuelle 0033_cleanup_anonymous_families.sql (comptes/familles
    // "anonymes" créés par l'ancien mécanisme de badge invisible, retiré le
    // 2026-07-11) — pour rattraper d'éventuels résidus sans repasser par
    // l'éditeur SQL Supabase. Contrairement au script SQL original (une
    // seule requête atomique via des CTE), ceci enchaîne plusieurs appels —
    // acceptable pour une action admin ponctuelle et à faible fréquence, pas
    // une frontière de sécurité sensible à une petite fenêtre de course.
    try {
      const anonIds = await listAllAnonymousUserIds(admin);
      if (anonIds.length === 0) {
        return jsonResponse({ ok: true, adhesions_supprimees: 0, familles_supprimees: 0, comptes_supprimes: 0 });
      }

      const { data: touchedMemberships, error: memErr } = await admin
        .from("family_members")
        .select("family_id")
        .in("user_id", anonIds);
      if (memErr) return jsonResponse({ error: memErr.message }, 500);
      const touchedFamilyIds = [...new Set((touchedMemberships || []).map((m: any) => m.family_id))];

      // Familles dont TOUS les membres actuels sont anonymes (même critère
      // que la CTE anon_only_families de la migration 0033).
      const anonOnlyFamilyIds: string[] = [];
      for (const familyId of touchedFamilyIds) {
        const { data: allMembers, error: allErr } = await admin
          .from("family_members").select("user_id").eq("family_id", familyId);
        if (allErr) continue;
        if ((allMembers || []).length > 0 && (allMembers || []).every((m: any) => anonIds.includes(m.user_id))) {
          anonOnlyFamilyIds.push(familyId);
        }
      }

      const { error: delMemErr, count: memCount } = await admin
        .from("family_members").delete({ count: "exact" }).in("user_id", anonIds);
      if (delMemErr) return jsonResponse({ error: delMemErr.message }, 500);

      let familyCount = 0;
      if (anonOnlyFamilyIds.length > 0) {
        const { error: delFamErr, count } = await admin
          .from("families").delete({ count: "exact" }).in("id", anonOnlyFamilyIds);
        if (delFamErr) return jsonResponse({ error: delFamErr.message }, 500);
        familyCount = count || 0;
      }

      // Comptes eux-mêmes — via l'API Admin (pas de DELETE SQL direct sur
      // auth.users possible depuis un client, contrairement au script SQL
      // ponctuel d'origine exécuté dans l'éditeur Supabase).
      let deletedUsers = 0;
      for (const uid of anonIds) {
        const { error: delUserErr } = await admin.auth.admin.deleteUser(uid);
        if (!delUserErr) deletedUsers++;
      }

      return jsonResponse({
        ok: true,
        adhesions_supprimees: memCount || 0,
        familles_supprimees: familyCount,
        comptes_supprimes: deletedUsers,
      });
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "cleanup_failed" }, 500);
    }
  }

  if (action === "set_ai_enabled") {
    const userId = String(payload?.user_id || "");
    const enabled = !!payload?.enabled;
    if (!userId) return jsonResponse({ error: "missing_user_id" }, 400);
    const { error } = await admin.from("subscriptions").upsert({ user_id: userId, ai_enabled: enabled }, { onConflict: "user_id" });
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "unknown_action" }, 400);
});
