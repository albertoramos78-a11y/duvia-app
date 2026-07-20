// send-pension-reminders/index.ts
//
// Invoquée quotidiennement par pg_cron (via pg_net, voir Task 6 pour le SQL
// de configuration côté dashboard) — jamais appelée par un client. Vérifie un
// secret partagé (CRON_SECRET) plutôt que le JWT d'un utilisateur.
//
// Deux choses par exécution :
// 1. Rappel au parent payeur, 2-3 jours avant l'échéance d'un versement
//    "pending" (une seule fois, voir payer_reminder_sent_at).
// 2. Alerte au parent bénéficiaire si l'échéance est dépassée et toujours
//    "pending" (une seule fois, voir overdue_alert_sent_at) — jamais si déjà
//    marqué "marked_paid" (le payeur a déjà agi, ce n'est plus "en retard"
//    dans ce sens).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUser } from "./_shared/push.ts";

const CRON_SECRET      = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
                      || Deno.env.get("SUPABASE_SECRET_KEYS")!;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const today = isoDate(new Date());

  const winStart = new Date(); winStart.setDate(winStart.getDate() + 2);
  const winEnd   = new Date(); winEnd.setDate(winEnd.getDate() + 3);

  let reminded = 0;
  let alerted  = 0;

  // ── Rappel au payeur ───────────────────────────────────────────────────
  const { data: dueSoon, error: dueSoonErr } = await supabase
    .from("pension_payments")
    .select("id, due_date, amount, pension_configs!inner(from_user_id)")
    .eq("status", "pending")
    .is("payer_reminder_sent_at", null)
    .gte("due_date", isoDate(winStart))
    .lte("due_date", isoDate(winEnd));

  if (dueSoonErr) {
    console.error("dueSoon query error:", dueSoonErr);
  } else {
    for (const payment of dueSoon ?? []) {
      const fromUserId = (payment as any).pension_configs?.from_user_id;
      if (!fromUserId) continue;
      await sendPushToUser(supabase, fromUserId, {
        title: "Duvia",
        body: `📅 Rappel : versement de pension de ${payment.amount}€ à faire le ${payment.due_date}`,
        tag: "pension-reminder",
        url: "/",
      });
      const { error: payerUpdateErr } = await supabase
        .from("pension_payments")
        .update({ payer_reminder_sent_at: new Date().toISOString() })
        .eq("id", payment.id);
      if (payerUpdateErr) {
        console.error("payer_reminder_sent_at update error:", payerUpdateErr);
      }
      reminded++;
    }
  }

  // ── Alerte au bénéficiaire (échéance dépassée, toujours "pending") ────────
  const { data: overdue, error: overdueErr } = await supabase
    .from("pension_payments")
    .select("id, due_date, amount, pension_configs!inner(to_user_id)")
    .eq("status", "pending")
    .is("overdue_alert_sent_at", null)
    .lt("due_date", today);

  if (overdueErr) {
    console.error("overdue query error:", overdueErr);
  } else {
    for (const payment of overdue ?? []) {
      const toUserId = (payment as any).pension_configs?.to_user_id;
      if (!toUserId) continue;
      await sendPushToUser(supabase, toUserId, {
        title: "Duvia",
        body: `⚠️ Le versement de pension de ${payment.amount}€ du ${payment.due_date} n'a pas encore été marqué payé`,
        tag: "pension-overdue",
        url: "/",
      });
      const { error: overdueUpdateErr } = await supabase
        .from("pension_payments")
        .update({ overdue_alert_sent_at: new Date().toISOString() })
        .eq("id", payment.id);
      if (overdueUpdateErr) {
        console.error("overdue_alert_sent_at update error:", overdueUpdateErr);
      }
      alerted++;
    }
  }

  return new Response(JSON.stringify({ ok: true, reminded, alerted }), {
    headers: { "content-type": "application/json" },
  });
});
