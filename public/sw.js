// Service worker minimal — ne met rien en cache, sert juste à rendre
// l'application "installable" sur Android/Chrome.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
