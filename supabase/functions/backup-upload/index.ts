// supabase/functions/backup-upload/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reçoit un backup .duvia chiffré (AES-GCM côté client) et le stocke dans
// le bucket privé 'family-backups'. Trace l'opération.
//
// Sécurité :
//   • JWT utilisateur vérifié (user doit être authentifié)
//   • Le user_id du JWT est utilisé comme actor — impossible de forger
//   • family_id vérifié : l'utilisateur doit être membre actif de la famille
//   • Le fichier est déjà chiffré côté client → cette fonction ne lit jamais
//     le contenu, elle ne fait que router vers Storage
//   • Rate limiting : 1 upload / user / 20 min (les hooks côté client
//     appellent au max 1×/jour, mais on protège contre les abus)
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BYTES = 25 * 1024 * 1024; // 25 Mo — miroir de la limite bucket
const RATE_LIMIT_MIN = 20;          // 1 upload par 20 min max

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: CORS });

  const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "server_misconfigured" }), { status: 500, headers: CORS });
  }

  // 1) Auth : récupère l'utilisateur depuis le JWT
  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: CORS });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: CORS });
  }
  const userId = userData.user.id;

  // 2) Body
  let body: { family_id?: string; ciphertext_b64?: string; iv_b64?: string; version?: number };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400, headers: CORS }); }

  const { family_id, ciphertext_b64, iv_b64, version } = body;
  if (!family_id || !ciphertext_b64 || !iv_b64) {
    return new Response(JSON.stringify({ error: "missing_fields" }), { status: 400, headers: CORS });
  }
  if (typeof version !== "number") {
    return new Response(JSON.stringify({ error: "invalid_version" }), { status: 400, headers: CORS });
  }

  // Vérif taille avant décodage
  const approxSize = Math.ceil(ciphertext_b64.length * 3 / 4);
  if (approxSize > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413, headers: CORS });
  }

  // 3) L'utilisateur est-il bien membre actif de cette famille ?
  const { data: member, error: memErr } = await admin
    .from("family_members")
    .select("user_id, status")
    .eq("family_id", family_id)
    .eq("user_id",   userId)
    .eq("status",    "active")
    .maybeSingle();
  if (memErr || !member) {
    return new Response(JSON.stringify({ error: "not_a_member" }), { status: 403, headers: CORS });
  }

  // 4) Rate limit : refus si un upload par ce user dans les RATE_LIMIT_MIN dernières minutes
  const since = new Date(Date.now() - RATE_LIMIT_MIN * 60_000).toISOString();
  const { count: recentCount } = await admin
    .from("family_backup_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("action",  "upload")
    .gte("created_at", since);
  if ((recentCount || 0) > 0) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after_min: RATE_LIMIT_MIN }), { status: 429, headers: CORS });
  }

  // 5) Construit le blob chiffré final : header JSON + '\n' + ciphertext base64
  //    Le header contient {v, iv, alg, exportedAt} pour permettre le déchiffrement.
  const header = { v: version, alg: "AES-GCM-256", iv: iv_b64, exportedAt: new Date().toISOString() };
  const payload = JSON.stringify(header) + "\n" + ciphertext_b64;
  const bytes = new TextEncoder().encode(payload);

  // 6) Chemin unique
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.duvia.enc`;
  const path = `${family_id}/${userId}/${filename}`;

  // 7) Upload dans le bucket privé
  const { error: upErr } = await admin.storage
    .from("family-backups")
    .upload(path, bytes, {
      contentType: "application/octet-stream",
      upsert: false,
    });
  if (upErr) {
    console.error("[backup-upload] storage error:", upErr);
    return new Response(JSON.stringify({ error: "storage_failed", detail: upErr.message }), { status: 500, headers: CORS });
  }

  // 8) Log RGPD
  await admin.from("family_backup_log").insert({
    family_id,
    user_id: userId,
    action: "upload",
    storage_path: path,
    size_bytes: bytes.byteLength,
    actor_type: "user",
    actor_user_id: userId,
  });

  return new Response(JSON.stringify({ ok: true, path }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
});
