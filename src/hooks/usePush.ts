import { useCallback, useEffect, useState } from "react";
import { saveSubscription, deleteSubscriptionByEndpoint } from "../services/supabase/pushService";

export type PushStatus = "unsupported" | "ios-needs-install" | "denied" | "default" | "subscribed";

function isIosNeedingInstall(): boolean {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as any).standalone === true;
  return isIos && !isStandalone;
}

// Constructeurs Android connus pour tuer agressivement les process en
// arrière-plan (MIUI, EMUI/Magic UI, ColorOS, FuntouchOS...), au point
// d'empêcher le réveil du service worker pour un push — voir
// dontkillmyapp.com. Détection approximative via l'UA (le modèle
// d'appareil y apparaît généralement sur Android), affichée seulement à
// titre indicatif pour guider l'utilisateur vers ses réglages batterie.
function isRestrictiveAndroidOem(): boolean {
  return /xiaomi|redmi|poco|miui|huawei|honor|oppo|cph\d|vivo/i.test(navigator.userAgent);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function usePush(userId: string | null, vapidPublicKey: string) {
  const [status, setStatus] = useState<PushStatus>("default");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (isIosNeedingInstall()) {
      setStatus("ios-needs-install");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    setStatus(sub ? "subscribed" : "default");
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const subscribe = useCallback(async () => {
    if (!userId || !vapidPublicKey || pending) return;
    setPending(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      await saveSubscription(userId, sub);
      await refreshStatus();
    } catch (e: any) {
      setError(e?.message || "subscribe_failed");
    } finally {
      setPending(false);
    }
  }, [userId, vapidPublicKey, pending, refreshStatus]);

  const unsubscribe = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await deleteSubscriptionByEndpoint(sub.endpoint);
        await sub.unsubscribe();
      }
      await refreshStatus();
    } catch (e: any) {
      setError(e?.message || "unsubscribe_failed");
    } finally {
      setPending(false);
    }
  }, [pending, refreshStatus]);

  return { status, subscribe, unsubscribe, pending, error, restrictiveOem: isRestrictiveAndroidOem() };
}
