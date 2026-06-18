import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // Revérifie périodiquement s'il y a une nouvelle version, utile pour
      // une appli installée restée ouverte longtemps sans être rechargée.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); // toutes les heures
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
