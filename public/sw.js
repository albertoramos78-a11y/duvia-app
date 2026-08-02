// Service worker minimal — ne met rien en cache, sert juste à rendre
// l'application "installable" sur Android/Chrome.
//
// 🔧 SW_VERSION doit être incrémentée à CHAQUE déploiement (garder en phase
// avec APP_VERSION dans src/config.js — ce fichier ne peut pas l'importer,
// c'est un script de service worker indépendant, d'où la duplication
// manuelle). Le navigateur ne réinstalle un service worker QUE si ses
// octets ont changé ; sans ce marqueur qui bouge, un déploiement qui ne
// touche pas sw.js lui-même passe totalement inaperçu du mécanisme de
// mise à jour (voir main.jsx, "duvia-update-ready") — l'app peut alors
// rester visuellement bloquée sur une ancienne version tant que
// l'utilisateur ne ferme/rouvre pas complètement l'appli.
const SW_VERSION = "4.14";

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
// Si l'app est ouverte ET au premier plan (onglet visible/focus), le code JS
// in-app (App.jsx) affiche déjà sa propre notification OS pour les mêmes
// événements — on n'affiche donc la notification du push QUE si aucun
// onglet n'est actuellement au premier plan, pour ne jamais doubler.
// 🔧 Un onglet simplement "ouvert" mais en arrière-plan (app minimisée,
// écran éteint, autre onglet actif) ne suffit PAS à supprimer le push :
// sur mobile, le JS d'un onglet en arrière-plan ne tourne souvent plus,
// donc ni le SW ni le code in-app n'affichaient alors quoi que ce soit —
// d'où des notifications qui semblaient arriver "au hasard".
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const isForeground = clients.some((c) => c.focused || c.visibilityState === "visible");
    if (isForeground) return;

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
