// supabase/functions/delete-account/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Suppression réelle du compte (auth.users) + filet de sécurité serveur pour
// quitter TOUTES les familles du user (au cas où le nettoyage côté client,
// fait juste avant cet appel, aurait échoué à cause d'un réseau coupé etc.).
// Utilise la service role key → bypass RLS, donc peut agir même après coup.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const userId: string | undefined = payload?.userId;
  const email: string | undefined  = payload?.email;
  if (!userId) return new Response("Missing userId", { status: 400 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── 1. Quitter toutes les familles restantes (filet de sécurité) ──────────
  try {
    const { data: memberships } = await admin
      .from("family_members")
      .select("family_id")
      .eq("user_id", userId);

    for (const m of memberships || []) {
      const fid = m.family_id;
      try {
        const { data: fam } = await admin
          .from("families").select("data").eq("id", fid).maybeSingle();
        if (fam?.data?.parents) {
          const parents = fam.data.parents.map((p: any) => {
            const mine = p && (p.userId === userId ||
              (email && p.email && p.email.toLowerCase() === email.toLowerCase()));
            return mine ? { ...p, userId: null, email: "", name: "", phone: "" } : p;
          });
          await admin.from("families").update({ data: { ...fam.data, parents } }).eq("id", fid);
        }
      } catch (e) {
        console.warn("delete-account: nettoyage parents famille", fid, e);
      }
      try {
        await admin.from("family_members").delete().eq("family_id", fid).eq("user_id", userId);
      } catch (e) {
        console.warn("delete-account: suppression family_members", fid, e);
      }
    }
  } catch (e) {
    console.warn("delete-account: nettoyage familles", e);
  }

  // ── 2. Nettoyage des données annexes ───────────────────────────────────────
  try { await admin.from("subscriptions").delete().eq("user_id", userId); } catch {}

  // ── 3. Suppression du compte auth (définitif) ──────────────────────────────
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
});
