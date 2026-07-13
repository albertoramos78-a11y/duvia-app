# Protection serveur de la localisation météo — design

**Date :** 2026-07-13
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Le spec précédent ([2026-07-13-calendar-weather-design.md](2026-07-13-calendar-weather-design.md)) stockait `city`/`lat`/`lon` directement sur `cfg.parents[i]`, dans le même bloc JSONB partagé (`families.data`) synchronisé en temps réel à **tous** les membres de la famille. Conséquence, repérée par l'utilisateur après livraison des 3 tâches initiales : n'importe quel parent (ou observateur) pouvait voir la ville configurée par les autres, et les coordonnées GPS brutes transitaient vers tous les appareils de la famille, qu'elles soient affichées ou non dans l'interface — une simple console navigateur suffisait à les retrouver même si l'UI les cachait.

Décidé explicitement par l'utilisateur : il faut une **vraie protection côté serveur**, pas juste un masquage dans l'interface.

## Approche retenue

### 1. Nouvelle table dédiée, jamais partagée

`supabase/migrations/0035_parent_locations.sql` — table `parent_locations` (`family_id`, `user_id`, `city`, `lat`, `lon`, `updated_at`), **RLS restreint à la ligne du propriétaire uniquement** :
- `SELECT`/`INSERT`/`UPDATE`/`DELETE` : `user_id = auth.uid()` — contrairement à **toutes** les autres tables de cette app (`history`, `ratings`, `family_members`...), il n'existe **aucune** policy de lecture "tout membre de la famille". C'est la différence structurelle clé qui garantit la confidentialité même en cas de bug côté client.

### 2. Edge Function `get-family-weather` — le seul chemin pour connaître la météo de quelqu'un d'autre

Le client ne reçoit jamais les coordonnées d'un tiers. Il envoie `{family_id, target_user_id, date}` (jamais de lat/lon) à une nouvelle Edge Function :
1. Vérifie que l'appelant est membre actif de `family_id` (requête `family_members` avec le JWT de l'appelant — la RLS existante sur cette table s'applique naturellement, pas besoin de service role pour cette vérification).
2. Va chercher la ligne `parent_locations` de `target_user_id` **avec le client service-role** (contourne volontairement le RLS, uniquement pour cette lecture précise et strictement interne à la fonction — jamais renvoyée telle quelle).
3. Appelle Open-Meteo avec ces coordonnées.
4. Renvoie **uniquement** `{code, tempMax, tempMin}` au client — jamais `lat`/`lon`, jamais `city`.

**Pourquoi le client détermine quand même qui a la garde** : la logique de résolution de garde (`resolveGuard()`, motifs, dérogations, jours fériés, dates spéciales) est complexe et déjà entièrement côté client — la dupliquer côté serveur serait un chantier à part entière et une source de désynchronisation. Cette information (qui garde l'enfant tel jour) n'est pas la donnée sensible ici — seule la **localisation précise** l'est. Le client calcule donc `parentIdx` comme avant, résout son `userId` (`cfg.parents[parentIdx].userId`, déjà présent dans le modèle existant), et transmet cet identifiant à la fonction — jamais de coordonnées.

### 3. Reprise des tâches déjà livrées

- **`ParentCityField`** (Task 2) : n'écrit/ne lit plus via `setParent`/`cfg.parents[i].city` — passe par un nouveau service `src/services/supabase/locationService.ts` (`getMyLocation()`, `setMyLocation(city, lat, lon)`), suivant le pattern service → hook déjà établi dans ce projet. Le champ "Ville" **ne s'affiche plus du tout** sur la fiche d'un parent qui n'est pas soi-même — pas de placeholder, pas d'indicateur "configuré/non configuré", la ligne entière disparaît pour l'autre parent.
- **Résumé météo sous la grille** (Task 3) : remplace l'appel direct `fetchWeatherForecast(lat, lon)` par un appel à `get-family-weather` via `supabase.functions.invoke(...)`, avec `target_user_id = cfg.parents[pIdx]?.userId`. Le cache client passe d'une clé `lat|lon` à une clé `target_user_id|date` (plus de coordonnées à mettre en cache côté client).

## Sécurité

- Le seul moyen d'obtenir la météo d'un tiers passe par une fonction qui vérifie l'appartenance à la famille avant de répondre — un utilisateur hors de la famille ne peut rien obtenir.
- Aucune coordonnée n'est jamais renvoyée au client, sous aucune forme — même pas indirectement via un identifiant de cache régénérable.
- La propre position de l'utilisateur reste lisible par lui-même normalement (RLS `user_id = auth.uid()`), aucune restriction sur sa propre donnée.

## Non-objectifs

- Pas de historique de localisation, pas de suivi — une seule position fixe par personne, comme dans le spec initial.
- Ne couvre pas les observateurs (toujours hors scope, comme dans le spec initial — seuls les parents ont une garde réelle à documenter pour la météo).
- Ne change rien à la logique de résolution de garde elle-même.

## Test / vérification

- Nouveaux tests unitaires : aucun (la logique pure de Task 1 est inchangée) — vérification par lecture de code + test live.
- Vérification live par l'utilisateur : avec 2 comptes parents liés à la même famille, chacun configure sa ville → confirmer que le champ "Ville" de l'AUTRE parent n'apparaît nulle part sur son écran de configuration ; confirmer que le résumé météo du jour s'affiche correctement pour le parent gardien sans jamais exposer de coordonnées dans le réseau/la console du navigateur de l'autre parent (vérification via les DevTools → onglet Réseau, inspecter la réponse de `get-family-weather`).
- `TZ=Europe/Paris npm test` doit rester vert.
