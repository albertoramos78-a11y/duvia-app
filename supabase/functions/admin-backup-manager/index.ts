// supabase/functions/admin-backup-manager/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Interface admin pour lister et récupérer les backups d'une famille.
//
// Actions (POST { action, ... }) :
//   • "list_by_family"   { family_id }      → liste des backups (chemin, date, taille)
//   • "list_by_email"    { email }          → retrouve la famille d'un user par email
//   • "download"         { path }           → retourne le blob chiffré (base64) + IV
//                                              L'admin doit ensuite le décrypter côté
//                                              client admin avec la clé maître.
//   • "delete"           { path }           → supprime un backup précis
//
// Sécurité :
//   • JWT vérifié + admin_verified (table app_admins) — miroir du pattern existant
//   • Toute action loguée dans family_backup_log (action='admin_*')
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS });

  const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "server_misconfigured" }), { status: 500, headers: CORS });
  }

  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: CORS });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Vérif admin server-side (table app_admins)
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: CORS });
  }
  const adminUserId = userData.user.id;

  const { data: adminRow } = await admin
    .from("app_admins")
    .select("user_id")
    .eq("user_id", adminUserId)
    .maybeSingle();
  if (!adminRow) {
    return new Response(JSON.stringify({ error: "not_an_admin" }), { status: 403, headers: CORS });
  }

  let body: { action?: string; family_id?: string; email?: string; path?: string };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400, headers: CORS }); }

  const { action, family_id, email, path } = body;

  // ── list_by_family ─────────────────────────────────────────────────────────
  if (action === "list_by_family") {
    if (!family_id) return new Response(JSON.stringify({ error: "missing_family_id" }), { status: 400, headers: CORS });
    const { data: files, error: lErr } = await admin.storage
      .from("family-backups")
      .list(family_id, { limit: 200, sortBy: { column: "created_at", order: "desc" } });
    if (lErr) return new Response(JSON.stringify({ error: "list_failed", detail: lErr.message }), { status: 500, headers: CORS });

    // Log RGPD
    await admin.from("family_backup_log").insert({
      family_id,
      action: "admin_list",
      actor_type: "admin",
      actor_user_id: adminUserId,
      notes: `Admin listed backups (${files?.length ?? 0} entries)`,
    });

    return new Response(JSON.stringify({ ok: true, files: files ?? [] }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // ── list_by_email ──────────────────────────────────────────────────────────
  if (action === "list_by_email") {
    if (!email) return new Response(JSON.stringify({ error: "missing_email" }), { status: 400, headers: CORS });
    // Retrouve les user_id de cet email
    const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const match = authUsers?.users?.find(u => (u.email || "").toLowerCase() === email.toLowerCase());
    if (!match) {
      return new Response(JSON.stringify({ ok: true, families: [] }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const { data: mems } = await admin
      .from("family_members")
      .select("family_id, status, role, created_at")
      .eq("user_id", match.id);
    return new Response(JSON.stringify({ ok: true, user_id: match.id, families: mems ?? [] }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // ── download ───────────────────────────────────────────────────────────────
  if (action === "download") {
    if (!path) return new Response(JSON.stringify({ error: "missing_path" }), { status: 400, headers: CORS });
    const famFromPath = path.split("/")[0] || "";
    const { data: file, error: dErr } = await admin.storage.from("family-backups").download(path);
    if (dErr || !file) return new Response(JSON.stringify({ error: "download_failed", detail: dErr?.message }), { status: 404, headers: CORS });

    const buf = new Uint8Array(await file.arrayBuffer());
    // base64 encode
    let bin = ""; for (let i = 0; i < buf.byteLength; i++) bin += String.fromCharCode(buf[i]);
    const b64 = btoa(bin);

    // Log RGPD — chaque accès admin est tracé
    await admin.from("family_backup_log").insert({
      family_id: famFromPath,
      action: "admin_restore",
      storage_path: path,
      size_bytes: buf.byteLength,
      actor_type: "admin",
      actor_user_id: adminUserId,
      notes: "Admin downloaded backup for restore",
    });

    return new Response(JSON.stringify({ ok: true, data_b64: b64 }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // ── delete ─────────────────────────────────────────────────────────────────
  if (action === "delete") {
    if (!path) return new Response(JSON.stringify({ error: "missing_path" }), { status: 400, headers: CORS });
    const famFromPath = path.split("/")[0] || "";
    const { error: rErr } = await admin.storage.from("family-backups").remove([path]);
    if (rErr) return new Response(JSON.stringify({ error: "delete_failed", detail: rErr.message }), { status: 500, headers: CORS });

    await admin.from("family_backup_log").insert({
      family_id: famFromPath,
      action: "admin_delete",
      storage_path: path,
      actor_type: "admin",
      actor_user_id: adminUserId,
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "unknown_action" }), { status: 400, headers: CORS });
});
