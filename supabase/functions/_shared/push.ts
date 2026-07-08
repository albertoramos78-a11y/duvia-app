// supabase/functions/_shared/push.ts
// ─────────────────────────────────────────────────────────────────────────────
// Envoi de notifications Web Push, partagé par toutes les fonctions
// déclenchées par un Database Webhook (notify-expense, notify-message,
// notify-vault-document, notify-join-request).
// ─────────────────────────────────────────────────────────────────────────────

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY  = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT     = Deno.env.get("VAPID_SUBJECT")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url?: string;
}

/**
 * Envoie `payload` à tous les abonnements push d'un utilisateur (un par
 * appareil). Supprime automatiquement les abonnements qui répondent 404/410
 * (désinstallés côté navigateur) — pas de job de nettoyage séparé nécessaire.
 * Un échec sur un appareil n'empêche jamais l'envoi aux autres.
 */
export async function sendPushToUser(admin: any, userId: string, payload: PushPayload): Promise<void> {
  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .eq("user_id", userId);

  if (error) {
    console.warn(`push: échec lecture des abonnements de ${userId}`, error);
    return;
  }
  if (!subs?.length) return;

  await Promise.all(subs.map(async (sub: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        JSON.stringify(payload)
      );
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        try {
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
        } catch (deleteErr) {
          console.warn(`push: échec suppression abonnement mort ${sub.id}`, deleteErr);
        }
      } else {
        console.warn(`push: échec envoi vers ${userId} (sub ${sub.id})`, e?.statusCode ?? e);
      }
    }
  }));
}
