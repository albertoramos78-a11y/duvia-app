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

// ── Dates spéciales (Fête des Mères/Pères, Pâques) — porté depuis
// src/utils/core.js, dupliqué ici (et dans ai-chatbot/index.ts) car les Edge
// Functions sont déployées par copier-coller dashboard (pas de build/import
// partagé) — même convention que parisMidnightISO() et _shared/push.ts.
// Toute correction faite ici doit être répercutée dans core.js ET dans
// ai-chatbot/index.ts.
function easterDateX(y: number): Date {
  const a = y % 19, b = ~~(y / 100), c = y % 100, d = ~~(b / 4), e = b % 4,
    f = ~~((b + 8) / 25), g = ~~((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = ~~(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m2 = ~~((a + 11 * h + 22 * l) / 451),
    mo = ~~((h + l - 7 * m2 + 114) / 31), dy = ((h + l - 7 * m2 + 114) % 31) + 1;
  return new Date(y, mo - 1, dy);
}
function pentecostDateX(y: number): Date {
  const e = easterDateX(y);
  const p = new Date(e); p.setDate(e.getDate() + 49);
  return p;
}
function nthWeekdayX(y: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    let d = new Date(y, month, 1), count = 0;
    while (count < n) { if (d.getDay() === weekday) count++; if (count < n) d.setDate(d.getDate() + 1); }
    return d;
  } else {
    let d = new Date(y, month + 1, 0);
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d;
  }
}
function sameDayX(d1: Date | null, d2: Date | null): boolean {
  return !!(d1 && d2 && d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate());
}
function getEventDateX(y: number, rule: any): Date | null {
  if (!rule) return null;
  if (rule.fixed) return new Date(y, rule.fixed[0], rule.fixed[1]);
  const [month, weekday, nth] = rule;
  return nthWeekdayX(y, month, weekday, nth);
}
const MOTHERS_DAY_X: Record<string, any> = {
  FR: [4, 0, -1], BE: [4, 0, -1], LU: [4, 0, -1], CH: [4, 0, 2], AT: [4, 0, 2],
  DE: [4, 0, 2], NL: [4, 0, 2], IT: [4, 0, 2], ES: [4, 0, 1], PT: [4, 0, 1],
  GB: [2, 0, 4], IE: [2, 0, 4], CA: [4, 0, 2], PL: { fixed: [4, 26] },
  CZ: [4, 0, 2], SK: [4, 0, 2], HR: { fixed: [4, 22] },
};
const FATHERS_DAY_X: Record<string, any> = {
  FR: [5, 0, 3], BE: [5, 0, 2], LU: [5, 0, 3], CH: [5, 0, 3], AT: [5, 0, 2],
  DE: null, NL: [5, 0, 3], IT: { fixed: [2, 19] }, ES: { fixed: [2, 19] }, PT: { fixed: [2, 19] },
  GB: [5, 0, 3], IE: [5, 0, 3], CA: [5, 0, 3], PL: { fixed: [5, 23] },
  CZ: [5, 0, 3], SK: [5, 0, 3], HR: [5, 0, 3],
};
function getMothersDayDateX(y: number, country: string): Date | null {
  const base = getEventDateX(y, MOTHERS_DAY_X[country] || MOTHERS_DAY_X["FR"]);
  if (country === "FR" && base && sameDayX(base, pentecostDateX(y))) return nthWeekdayX(y, 5, 0, 1);
  return base;
}
function getFathersDayDateX(y: number, country: string): Date | null {
  if (country === "DE") {
    const easter = easterDateX(y);
    const asc = new Date(easter); asc.setDate(easter.getDate() + 39);
    return asc;
  }
  return getEventDateX(y, FATHERS_DAY_X[country]);
}
function wkNumX(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil((((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1) / 7);
}

interface CustodyDayResult { parentIdx: number | null; source: string | null; }
interface CustodyTablesCtx {
  ruleRows: any[];
  patternDaysByRuleId: Record<string, any[]>;
  overridesByDate: Map<string, number | null>;
  globalSD: any;
  perChildSDByChild: Record<string, any>;
  annex: {
    country: string; sameGuardAll: boolean;
    parents: Array<{ gender: string; birthDay: string; birthMonth: string }>;
    children: Array<{ id: number; birthDay: string; birthMonth: string }>;
    schoolHolDetails: Record<string, Record<string, any>>;
    schoolHolDetailsPerChild: Record<string, Record<string, Record<string, any>>>;
  };
}

// ── resolveCustodyDayFromTables : lecture hybride (5 tables dédiées + petite
// tranche de families.data) — même algorithme que resolveGuard (core.js),
// sourcé depuis les tables Phase 3 plutôt que le JSON. Utilisée par le
// chatbot (ai-chatbot/index.ts) ET l'action admin verify_custody_parity
// ci-dessous. Voir docs/superpowers/specs/2026-07-21-custody-days-server-
// read-design.md. ──
function resolveCustodyDayFromTables(ds: string, childId: number | null, ctx: CustodyTablesCtx): CustodyDayResult {
  const usePerChild = !ctx.annex.sameGuardAll && childId != null
    && ctx.ruleRows.some((r: any) => r.child_id === childId && r.confirmed);
  const rule = usePerChild
    ? ctx.ruleRows.find((r: any) => r.child_id === childId)
    : ctx.ruleRows.find((r: any) => r.child_id === null);

  // 2. Override manuel (global uniquement — cfg.overrides n'a pas de
  // dimension par enfant dans le modèle JSON actuel, voir design doc).
  if (ctx.overridesByDate.has(ds)) return { parentIdx: ctx.overridesByDate.get(ds) ?? null, source: "override" };

  // 3. Fête des Mères / Fête des Pères
  const dsDate = new Date(ds + "T12:00:00");
  const y = dsDate.getFullYear();
  const country = ctx.annex.country || "FR";
  if (ctx.globalSD.mother_day_enabled) {
    const mdDate = getMothersDayDateX(y, country);
    if (mdDate && sameDayX(mdDate, dsDate)) {
      const motherIdx = ctx.annex.parents.findIndex((p) => p.gender === "F");
      if (motherIdx !== -1) return { parentIdx: motherIdx, source: "motherDay" };
    }
  }
  if (ctx.globalSD.father_day_enabled) {
    const fdDate = getFathersDayDateX(y, country);
    if (fdDate && sameDayX(fdDate, dsDate)) {
      const fatherIdx = ctx.annex.parents.findIndex((p) => p.gender === "M");
      if (fatherIdx !== -1) return { parentIdx: fatherIdx, source: "fatherDay" };
    }
  }

  // 4. Anniversaires des parents
  const parentBirths = ctx.globalSD.parent_births || [];
  const dsM = dsDate.getMonth() + 1, dsD = dsDate.getDate();
  for (let pi = 0; pi < ctx.annex.parents.length; pi++) {
    const pb = parentBirths[pi];
    if (!pb?.enabled) continue;
    const p = ctx.annex.parents[pi];
    if (!p?.birthDay || !p?.birthMonth) continue;
    if (+p.birthDay === dsD && +p.birthMonth === dsM) return { parentIdx: pi, source: "parentBirthday" };
  }

  // 4b. Anniversaires des enfants
  for (let ci = 0; ci < ctx.annex.children.length; ci++) {
    const ch = ctx.annex.children[ci];
    if (!ch?.birthDay || !ch?.birthMonth) continue;
    if (+ch.birthDay !== dsD || +ch.birthMonth !== dsM) continue;
    const chSdLocal = childId != null ? ctx.perChildSDByChild[String(ch.id)] : null;
    const evenIdx = chSdLocal?.even_parent_idx ?? ctx.globalSD.even_parent_idx ?? 0;
    const oddIdx = chSdLocal?.odd_parent_idx ?? ctx.globalSD.odd_parent_idx ?? 1;
    const parentIdx = y % 2 === 0 ? evenIdx : oddIdx;
    if (parentIdx === -1) return { parentIdx: null, source: "childBirthday" };
    return { parentIdx, source: "childBirthday" };
  }

  // 5. Vacances scolaires — SEUL champ qui n'existe pas dans les 5 tables,
  // reste lu depuis l'annexe JSON (voir design doc, custody_overrides ne
  // stocke que les overrides manuels).
  const holDetails = (childId != null && ctx.annex.schoolHolDetailsPerChild?.[String(childId)])
    || ctx.annex.schoolHolDetails || {};
  for (const holName of Object.keys(holDetails)) {
    const det = holDetails[holName];
    if (det[ds] !== undefined) {
      const v = det[ds];
      if (typeof v === "string" && v.startsWith("obs:")) return { parentIdx: null, source: "schoolHol" };
      return { parentIdx: v, source: "schoolHol" };
    }
  }

  // 6. Motif par défaut
  if (!rule?.confirmed) return { parentIdx: null, source: null };
  const start = new Date(+rule.start_year, +rule.start_month - 1, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const target = new Date(ds + "T12:00:00");
  const diff = Math.floor((target.getTime() - start.getTime()) / 864e5);
  if (diff < 0) return { parentIdx: null, source: null };

  if (rule.type === "weekAlt") {
    const wn = wkNumX(target);
    return { parentIdx: wn % 2 === 0 ? rule.week_alt_even_idx : 1 - rule.week_alt_even_idx, source: "pattern" };
  }
  if (rule.type === "exclusive") {
    const dw = (target.getDay() + 6) % 7;
    if (dw < 5) return { parentIdx: rule.exclusive_main_idx, source: "pattern" };
    const wn = wkNumX(target);
    const parity = rule.exclusive_parity === "even" ? 0 : 1;
    return { parentIdx: wn % 2 === parity ? rule.exclusive_we_idx : rule.exclusive_main_idx, source: "pattern" };
  }
  if (rule.type === "custom") {
    const days = ctx.patternDaysByRuleId[rule.id] || [];
    if (!days.length) return { parentIdx: null, source: null };
    const day = days[diff % days.length];
    return { parentIdx: day?.parent_idx ?? null, source: day ? "pattern" : null };
  }
  return { parentIdx: null, source: null };
}

// ── resolveCustodyDayFromJson : portage fidèle de resolveGuard (core.js,
// Task 1 du plan) — utilisé UNIQUEMENT comme référence pour la vérification
// de parité ci-dessous, jamais par le chatbot. ──
function resolveCustodyDayFromJson(ds: string, cfg: any, childId: number | null): CustodyDayResult {
  const usePerChild = !cfg.sameGuardAll && childId != null && cfg.custodyPerChild?.[childId]?.confirmed;
  const custody = usePerChild ? cfg.custodyPerChild[childId] : cfg.custody;

  if (cfg.overrides?.[ds]) return { parentIdx: cfg.overrides[ds].parentIdx ?? null, source: "override" };

  const sd = cfg.specialDates || {};
  const country = cfg.country || "FR";
  const dsDate = new Date(ds + "T12:00:00");
  const y = dsDate.getFullYear();
  if (sd.motherDay?.enabled) {
    const mdDate = getMothersDayDateX(y, country);
    if (mdDate && sameDayX(mdDate, dsDate)) {
      const motherIdx = (cfg.parents || []).findIndex((p: any) => p.gender === "F");
      if (motherIdx !== -1) return { parentIdx: motherIdx, source: "motherDay" };
    }
  }
  if (sd.fatherDay?.enabled) {
    const fdDate = getFathersDayDateX(y, country);
    if (fdDate && sameDayX(fdDate, dsDate)) {
      const fatherIdx = (cfg.parents || []).findIndex((p: any) => p.gender === "M");
      if (fatherIdx !== -1) return { parentIdx: fatherIdx, source: "fatherDay" };
    }
  }

  const parentBirths = sd.parentBirths || [];
  const dsM = dsDate.getMonth() + 1, dsD = dsDate.getDate();
  for (let pi = 0; pi < (cfg.parents || []).length; pi++) {
    const pb = parentBirths[pi];
    if (!pb?.enabled) continue;
    const p = cfg.parents[pi];
    if (!p?.birthDay || !p?.birthMonth) continue;
    if (+p.birthDay === dsD && +p.birthMonth === dsM) return { parentIdx: pi, source: "parentBirthday" };
  }

  const perChildSD = cfg.specialDates?.perChild || {};
  for (let ci = 0; ci < (cfg.children || []).length; ci++) {
    const ch = cfg.children[ci];
    if (!ch?.birthDay || !ch?.birthMonth) continue;
    if (+ch.birthDay !== dsD || +ch.birthMonth !== dsM) continue;
    const chSdLocal = childId != null && perChildSD[ch.id] ? perChildSD[ch.id] : null;
    const evenIdx = chSdLocal?.evenParentIdx ?? sd.evenParentIdx ?? 0;
    const oddIdx = chSdLocal?.oddParentIdx ?? sd.oddParentIdx ?? 1;
    const parentIdx = y % 2 === 0 ? evenIdx : oddIdx;
    if (parentIdx === -1) return { parentIdx: null, source: "childBirthday" };
    return { parentIdx, source: "childBirthday" };
  }

  const holDetails = (childId != null && cfg.specialDates?.schoolHolDetailsPerChild?.[childId])
    || cfg.specialDates?.schoolHolDetails || {};
  for (const holName of Object.keys(holDetails)) {
    const det = holDetails[holName];
    if (det[ds] !== undefined) {
      const v = det[ds];
      if (typeof v === "string" && v.startsWith("obs:")) return { parentIdx: null, source: "schoolHol" };
      return { parentIdx: v, source: "schoolHol" };
    }
  }

  if (!custody?.confirmed) return { parentIdx: null, source: null };
  const { type, weekAlt, exclusive, pattern } = custody;
  const startYear = custody.startYear || cfg.custody.startYear;
  const startMonth = custody.startMonth || cfg.custody.startMonth;
  const start = new Date(+startYear, +startMonth - 1, 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const target = new Date(ds + "T12:00:00");
  const diff = Math.floor((target.getTime() - start.getTime()) / 864e5);
  if (diff < 0) return { parentIdx: null, source: null };
  if (type === "weekAlt") {
    const wn = wkNumX(target);
    return { parentIdx: wn % 2 === 0 ? weekAlt.evenIdx : 1 - weekAlt.evenIdx, source: "pattern" };
  }
  if (type === "exclusive") {
    const dw = (target.getDay() + 6) % 7;
    if (dw < 5) return { parentIdx: exclusive.mainIdx, source: "pattern" };
    const wn = wkNumX(target);
    return { parentIdx: wn % 2 === (exclusive.parity === "even" ? 0 : 1) ? exclusive.weIdx : exclusive.mainIdx, source: "pattern" };
  }
  if (type === "custom" && pattern?.length) {
    const day = pattern[diff % pattern.length];
    return { parentIdx: day?.parentIdx ?? null, source: day ? "pattern" : null };
  }
  return { parentIdx: null, source: null };
}

function familyHasConfirmedCustody(cfgData: any): boolean {
  if (cfgData?.custody?.confirmed) return true;
  const perChild = cfgData?.custodyPerChild || {};
  return Object.values(perChild).some((c: any) => c?.confirmed);
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
    const rawPlan = String(payload?.plan || "");
    // 🔧 "premium_ai" n'est PAS une valeur de colonne `plan` distincte (revu
    // 2026-07-20 : Premium+IA = Premium + accès IA, le palier le plus élevé,
    // pas un statut indépendant à limites Freemium comme d'abord conçu) —
    // c'est un raccourci d'admin qui pose plan="premium" + ai_enabled=true en
    // un clic. Voir aussi subStatus()/getPerms() côté client, qui n'ont plus
    // aucune notion de "premium_ai" : un compte ainsi forcé est un compte
    // Premium normal aux yeux de tout le reste de l'app.
    const isPremiumAiShortcut = rawPlan === "premium_ai";
    const plan = isPremiumAiShortcut ? "premium" : rawPlan;
    if (!userId || !["freemium", "beta", "trial_premium", "premium"].includes(plan)) {
      return jsonResponse({ error: "invalid_params" }, 400);
    }
    // ai_enabled : activé uniquement via le raccourci Premium+IA ; tout autre
    // choix (y compris "premium" seul) le désactive explicitement, sinon un
    // compte déjà passé par Premium+IA garderait l'IA active après un
    // changement de statut qui ne le redemande pas.
    let update: Record<string, unknown> = { plan, ai_enabled: isPremiumAiShortcut };
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
      new_plan: rawPlan, // garde "premium_ai" lisible dans l'historique admin même si la colonne plan stocke "premium"
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
    // qui n'ont jamais été touchés ici. Couvre les statuts forçables :
    // freemium / trial_premium / premium (Premium+IA est un compte "premium"
    // avec ai_enabled=true, pas une valeur de plan à part — voir set_user_plan
    // ci-dessus). "premium_ai" reste dans le filtre uniquement pour les lignes
    // historiques écrites avant ce changement (2026-07-20) qui l'ont encore
    // littéralement en colonne plan.
    const { data: logRows, error: logErr } = await admin.from("admin_subscription_log").select("target_user_id");
    if (logErr) return jsonResponse({ error: logErr.message }, 500);
    const targetIds = [...new Set((logRows || []).map((r) => r.target_user_id))];
    if (targetIds.length === 0) return jsonResponse({ subscribers: [] });

    const { data: rows, error } = await admin
      .from("subscriptions")
      .select("user_id, plan, premium_since, cycle, trial_start, ai_enabled")
      .in("user_id", targetIds)
      .in("plan", ["freemium", "trial_premium", "premium", "premium_ai"]);
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
        ai_enabled: !!row.ai_enabled,
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

  if (action === "verify_custody_parity") {
    // Compare le calcul JSON actuel (resolveCustodyDayFromJson) au nouveau
    // calcul par tables dédiées (resolveCustodyDayFromTables), sur 2 ans
    // passés + 1 an à venir, pour toutes les familles ayant une configuration
    // de garde confirmée. Action à la demande uniquement (pas de cron) — voir
    // Non-objectifs du design doc. Client service-role : lecture cross-
    // famille, bloquée par RLS pour un JWT normal.
    const today = new Date();
    const fromDate = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate()).toISOString().slice(0, 10);
    const toDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate()).toISOString().slice(0, 10);
    const fromMs = new Date(fromDate + "T00:00:00").getTime();
    const toMs = new Date(toDate + "T00:00:00").getTime();

    const { data: families, error: famErr } = await admin.from("families").select("id, data");
    if (famErr) return jsonResponse({ error: famErr.message }, 500);

    const MAX_MISMATCHES_RETURNED = 200;
    let familiesChecked = 0;
    let daysCompared = 0;
    let mismatchCount = 0;
    const mismatches: any[] = [];

    for (const fam of families || []) {
      const cfgData = fam.data || {};
      if (!familyHasConfirmedCustody(cfgData)) continue;
      familiesChecked++;

      const childIds: Array<number | null> = cfgData.sameGuardAll === false
        ? (cfgData.children || []).map((c: any) => c.id)
        : [null];

      const { data: ruleRows } = await admin
        .from("custody_rules")
        .select("id, child_id, type, start_month, start_year, week_alt_even_idx, exclusive_main_idx, exclusive_we_idx, exclusive_parity, confirmed")
        .eq("family_id", fam.id);
      const customRuleIds = (ruleRows || []).filter((r: any) => r.type === "custom").map((r: any) => r.id);
      const patternDaysByRuleId: Record<string, any[]> = {};
      if (customRuleIds.length) {
        const { data: pdRows } = await admin
          .from("custody_pattern_days").select("rule_id, day_index, parent_idx").in("rule_id", customRuleIds).order("day_index");
        for (const row of pdRows || []) (patternDaysByRuleId[row.rule_id] ||= []).push(row);
      }
      const { data: overrideRows } = await admin
        .from("custody_overrides").select("override_date, parent_idx")
        .eq("family_id", fam.id).eq("source", "manual").is("child_id", null)
        .gte("override_date", fromDate).lte("override_date", toDate);
      const overridesByDate = new Map((overrideRows || []).map((r: any) => [r.override_date, r.parent_idx]));
      const { data: sdRows } = await admin
        .from("custody_special_dates").select("child_id, mother_day_enabled, father_day_enabled, parent_births, even_parent_idx, odd_parent_idx")
        .eq("family_id", fam.id);
      const globalSD = (sdRows || []).find((r: any) => r.child_id === null) || {};
      const perChildSDByChild: Record<string, any> = {};
      for (const r of sdRows || []) if (r.child_id !== null) perChildSDByChild[String(r.child_id)] = r;

      const annex = {
        country: cfgData.country || "FR",
        sameGuardAll: cfgData.sameGuardAll !== false,
        parents: (cfgData.parents || []).map((p: any) => ({ gender: p.gender || "M", birthDay: p.birthDay || "", birthMonth: p.birthMonth || "" })),
        children: (cfgData.children || []).map((c: any) => ({ id: c.id, birthDay: c.birthDay || "", birthMonth: c.birthMonth || "" })),
        schoolHolDetails: cfgData.specialDates?.schoolHolDetails || {},
        schoolHolDetailsPerChild: cfgData.specialDates?.schoolHolDetailsPerChild || {},
      };
      const tablesCtx: CustodyTablesCtx = { ruleRows: ruleRows || [], patternDaysByRuleId, overridesByDate, globalSD, perChildSDByChild, annex };

      for (const childId of childIds) {
        for (let ms = fromMs; ms <= toMs; ms += 86400000) {
          const ds = new Date(ms).toISOString().slice(0, 10);
          const fromJson = resolveCustodyDayFromJson(ds, cfgData, childId);
          const fromTables = resolveCustodyDayFromTables(ds, childId, tablesCtx);
          daysCompared++;
          if (fromJson.parentIdx !== fromTables.parentIdx) {
            mismatchCount++;
            if (mismatches.length < MAX_MISMATCHES_RETURNED) {
              mismatches.push({ family_id: fam.id, date: ds, child_id: childId, old_result: fromJson.parentIdx, new_result: fromTables.parentIdx });
            }
          }
        }
      }
    }

    return jsonResponse({
      ok: true,
      familles_verifiees: familiesChecked,
      jours_compares: daysCompared,
      total_desaccords: mismatchCount,
      desaccords: mismatches,
      desaccords_tronques: mismatchCount > MAX_MISMATCHES_RETURNED,
    });
  }

  return jsonResponse({ error: "unknown_action" }, 400);
});
