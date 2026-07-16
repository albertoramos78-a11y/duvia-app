import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // 🔧 Revérifie s'il y a une nouvelle version SANS attendre d'action de
      // l'utilisateur (ex: un refresh manuel). Avant ce fix, la seule
      // vérification était un setInterval toutes les heures, dont le tout
      // premier passage n'avait lieu qu'une heure APRÈS le chargement — un
      // onglet resté ouvert ne voyait donc "Nouvelle version disponible"
      // qu'après un rechargement manuel (qui refait l'enregistrement du SW
      // depuis zéro), jamais tout seul dans les minutes suivant un déploiement.
      // Revérifier au retour de visibilité de l'onglet couvre le cas réel le
      // plus courant (l'appli reste ouverte, l'utilisateur y revient plus
      // tard) ; l'intervalle réduit à 15 min reste en secours pour un onglet
      // qui resterait au premier plan sans jamais être quitté/repris.
      const checkForUpdate = () => reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdate();
      });
      setInterval(checkForUpdate, 15 * 60 * 1000);
    }).catch(() => {});

    // 🔧 "Nouvelle version disponible" : on ignore le tout premier
    // contrôleur (1ère visite, rien à mettre à jour), et on prévient
    // l'appli uniquement quand un VRAI changement de version se produit.
    let hadControllerBefore = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadControllerBefore) { hadControllerBefore = true; return; }
      window.dispatchEvent(new CustomEvent("duvia-update-ready"));
    });
  });
}
