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
