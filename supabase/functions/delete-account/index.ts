// supabase/functions/delete-account/index.ts
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

// Supprime tous les fichiers d'un dossier dans un bucket
async function deleteFolder(admin: any, bucket: string, folder: string) {
  try {
    const { data: files } = await admin.storage.from(bucket).list(folder, { limit: 1000 });
    if (files?.length) {
      const paths = files.map((f: any) => `${folder}/${f.name}`);
      await admin.storage.from(bucket).remove(paths);
    }
  } catch (e) {
    console.warn(`delete-account: cleanup ${bucket}/${folder}`, e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: CORS });
  }

  const userId: string | undefined = payload?.userId;
  const email: string | undefined  = payload?.email;
  if (!userId) return new Response("Missing userId", { status: 400, headers: CORS });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 🔒 Vérifie que l'appelant authentifié est bien le titulaire du compte visé.
  // Sans ce check, n'importe quel utilisateur connecté pourrait supprimer le
  // compte de n'importe qui d'autre en passant son userId dans le body.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("Missing authorization", { status: 401, headers: CORS });
  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || callerData?.user?.id !== userId) {
    return new Response("Forbidden", { status: 403, headers: CORS });
  }

  // ── 1. Quitter toutes les familles + nettoyage fichiers si dernier membre ──
  const familyIds: string[] = [];
  try {
    const { data: memberships } = await admin
      .from("family_members")
      .select("family_id")
      .eq("user_id", userId);

    for (const m of memberships || []) {
      const fid = m.family_id;
      familyIds.push(fid);

      // Vérifier si dernier membre actif AVANT de supprimer la ligne
      const { data: otherMembers } = await admin
        .from("family_members")
        .select("user_id")
        .eq("family_id", fid)
        .eq("status", "active")
        .neq("user_id", userId);
      const isLast = !otherMembers || otherMembers.length === 0;

      // Nettoyer le JSONB parents
      try {
        const { data: fam } = await admin
          .from("families").select("data").eq("id", fid).maybeSingle();
        if (fam?.data?.parents) {
          const parents = fam.data.parents.map((p: any) => {
            const mine = p && (p.userId === userId ||
              (email && p.email && p.email.toLowerCase() === email.toLowerCase()));
            return mine
              ? { ...p, userId: null, email: "", phone: "", left: true, leftAt: new Date().toISOString() }
              : p;
          });
          await admin.from("families").update({ data: { ...fam.data, parents } }).eq("id", fid);
        }
      } catch (e) {
        console.warn("delete-account: nettoyage parents famille", fid, e);
      }

      // Supprimer la ligne family_members
      try {
        await admin.from("family_members").delete().eq("family_id", fid).eq("user_id", userId);
      } catch (e) {
        console.warn("delete-account: suppression family_members", fid, e);
      }

      // Si dernier parent : supprimer tous les fichiers de la famille
      if (isLast) {
        for (const bucket of ["vault", "chat-attachments", "expense-attachments"]) {
          await deleteFolder(admin, bucket, fid);
        }
      }
    }
  } catch (e) {
    console.warn("delete-account: nettoyage familles", e);
  }

  // ── 2. Supprimer l'avatar (toujours — fichier personnel) ───────────────────
  await deleteFolder(admin, "avatars", userId);

  // ── 3. Supprimer les backups cloud de toutes les familles ──────────────────
  for (const fid of familyIds) {
    await deleteFolder(admin, "family-backups", fid);
  }

  // ── 4. Nettoyage données annexes ───────────────────────────────────────────
  try { await admin.from("subscriptions").delete().eq("user_id", userId); } catch {}

  // ── 5. Suppression du compte auth (définitif) ──────────────────────────────
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
