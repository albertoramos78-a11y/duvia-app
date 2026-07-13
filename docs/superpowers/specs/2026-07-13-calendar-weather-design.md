# Météo dans le calendrier — design

**Date :** 2026-07-13
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Backlog item 18a. But clarifié pendant le brainstorm : savoir quel temps il fera pour bien habiller l'enfant — la météo affichée pour un jour donné du calendrier doit donc correspondre au domicile du **parent qui a la garde ce jour-là**, pas à la position de la personne qui consulte l'appli.

## Contraintes découvertes

- L'app ne stocke aujourd'hui **aucune localisation précise** — seulement `cfg.country` (2 lettres) et `cfg.subdivisionCode`/`cfg.zone` (académie française, pour les vacances scolaires). Rien d'assez précis pour une météo.
- Aucune API météo gratuite ne couvre plus de ~16 jours de prévision — le calendrier de garde, lui, s'affiche sur des mois. La météo ne pourra donc apparaître que sur une fenêtre glissante de 16 jours à partir d'aujourd'hui, rien au-delà.

## API retenue : Open-Meteo

Gratuite, sans clé, sans compte (aucune donnée personnelle transmise à un tiers au-delà des coordonnées GPS) — cohérent avec la sensibilité RGPD déjà affichée ailleurs dans ce projet. Deux endpoints utilisés :
- **Forecast** (`api.open-meteo.com/v1/forecast`) : prévision 16 jours par coordonnées, code météo WMO + températures min/max.
- **Geocoding** (`geocoding-api.open-meteo.com/v1/search`) : recherche d'une ville par nom → coordonnées.

**⚠️ Limite de licence à surveiller** : l'usage gratuit d'Open-Meteo est réservé au **non-commercial**. Duvia a une offre Premium payante, mais aucun paiement réel n'est encore actif (Stripe bloqué sur le SIRET, backlog item 22) — acceptable pour l'instant, à réévaluer si la facturation réelle démarre.

**Géolocalisation → nom de ville** : confirmé qu'Open-Meteo n'a **pas** d'endpoint de géocodage inverse (coordonnées → nom de ville) — demandé plusieurs fois par la communauté mais jamais construit. Le bouton « Utiliser ma position » enregistrera donc directement les coordonnées avec un libellé générique (« 📍 Ma position ») plutôt que d'ajouter un second fournisseur tiers (ex. Nominatim) pour ce seul usage cosmétique.

## Localisation : un champ par parent

Nouveau champ `city` (nom affiché) + `lat`/`lon` (coordonnées, utilisées pour l'appel API) sur chaque `cfg.parents[i]`, à côté des champs téléphone/email déjà existants (`App.jsx:~8701`, même pattern `setParent(i,"city",...)`, gated par `isMine` comme les autres champs personnels). Deux façons de le remplir :
1. **Bouton « 📍 Utiliser ma position »** — géolocalisation navigateur (`navigator.geolocation.getCurrentPosition`), une fois, pas de suivi continu ni de rafraîchissement automatique.
2. **Recherche manuelle** — champ texte avec autocomplétion via l'endpoint de géocodage Open-Meteo (saisie du nom de ville).

## Récupération et cache de la météo

Même architecture que le cache jours fériés déjà en place (`OH_CACHE`, `ohCacheKey()`, `App.jsx:~587-588`) :
- Un cache en mémoire clé par coordonnées arrondies + date du jour (`weatherCacheKey(lat, lon, dateStr)`).
- Un `useEffect` dans `App()` (miroir de celui des jours fériés, `App.jsx:~3854-3875`) qui déclenche un fetch quand les coordonnées d'un des deux parents changent, stocke le résultat dans un state `weatherData`/`weatherLoading`.
- Un seul appel par (parent, jour) — pas de rafraîchissement à chaque ouverture du calendrier dans la même session.

## Affichage (révisé pendant le plan — v1 volontairement restreinte)

Les cases de la vue grille mensuelle (`MonthGridCalendar`) sont déjà petites et chargées (numéro, icône anniversaire, icône spéciale, pastille, badge de changement de garde, triangle vacances) — y ajouter une icône météo par case serait illisible. **Décision** : pas d'icône par case. À la place, une seule ligne résumé sous la grille : *"Aujourd'hui : ☀️ 18°C chez [nom du parent gardien]"*, calculée à partir de `resolveGuard()` pour la date du jour. Affichée seulement si le parent gardien du jour a une localisation enregistrée (silence sinon, comme le reste du calendrier gère déjà l'absence de données).

La vue liste ("détaillée") n'est pas touchée dans cette v1 — reste un point de suivi séparé si le besoin se confirme à l'usage.

## Table de correspondance WMO → emoji

Les codes météo WMO (0=ciel clair, 1-3=partiellement nuageux, 45/48=brouillard, 51-67=pluie, 71-77=neige, 80-99=averses/orage) sont mappés à un petit jeu d'emoji (☀️🌤️⛅🌥️☁️🌫️🌦️🌧️⛈️🌨️), cohérent avec le langage d'icônes déjà dominant dans l'app (confirmé par l'audit de cohérence frontend du 2026-07-13 : quasiment aucun SVG, tout en emoji).

## Non-objectifs

- Pas de localisation pour les observateurs/enfants — seuls les parents (garde réelle) ont un champ ville.
- Pas de bascule automatique de la localisation d'un parent (ex. voyage) — une seule position fixe par parent, modifiable manuellement à tout moment.
- Pas de météo au-delà de 16 jours, pas de tentative d'estimation/moyenne climatique pour combler ce vide.

## Test / vérification

- Nouvelle logique pure (mapping WMO→emoji, calcul de fenêtre 16 jours, résolution du parent gardien du jour) : couverte par des tests dans `core.test.js`.
- `TZ=Europe/Paris npm test` doit rester vert.
- Bump `APP_VERSION`/`SW_VERSION` (changement `App.jsx`).
- Vérification live par l'utilisateur (aucun navigateur dans cet environnement) : renseigner une ville pour chaque parent (une via géolocalisation, une via recherche manuelle), confirmer que les jours des 16 prochains jours affichent bien une icône+température cohérente selon le parent gardien, et qu'au-delà rien ne s'affiche.
