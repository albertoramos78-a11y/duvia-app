// Service worker minimal — ne met rien en cache, sert juste à rendre
// l'application "installable" sur Android/Chrome.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  // Ne jamais intercepter les requêtes cross-origin (photos Supabase Storage,
  // etc.) : les rejouer via fetch(event.request) casse les réponses opaques
  // cross-origin sur certains navigateurs mobiles (image cassée sur téléphone,
  // fonctionne sur PC) — on laisse le navigateur les traiter nativement.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});

// ── Web Push ──────────────────────────────────────────────────────────────
// Si l'app a déjà un onglet ouvert (peu importe le focus), le code JS
// in-app (App.jsx) affiche déjà sa propre notification OS pour les mêmes
// événements — on n'affiche donc la notification du push QUE si aucun
// onglet n'est ouvert, pour ne jamais doubler.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  event.waitUntil((async () => {
    const openClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (openClients.length > 0) return;

    await self.registration.showNotification(data.title || "Duvia", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon-192.png",
      data: { url: data.url || "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil((async () => {
    const openClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of openClients) {
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
