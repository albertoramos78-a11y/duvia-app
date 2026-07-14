# Vrai blocage d'accès pour l'observateur hors quota — design

**Date :** 2026-07-14
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Le ship précédent (backlog 17d, v1.79-1.80) limite `perms.maxObservers` à 1 pendant le Trial/Freemium, mais l'enforcement est **uniquement côté écran de config du parent** : le formulaire d'invitation et les fiches observateurs au-delà du quota sont floutées/bloquées dans l'UI du parent, mais si l'observateur en trop est déjà connecté sur son propre appareil, il garde un accès complet et normal à l'application — la limite n'existe que dans l'œil du parent qui regarde sa fiche.

Décidé explicitement par l'utilisateur : il faut un vrai blocage côté observateur, pas seulement un rappel visuel côté parent.

## Le vrai obstacle : le plan est stocké par compte, pas par famille

`subscriptions` a `user_id` comme clé, pas `family_id`. Chaque utilisateur (parent, observateur, enfant) a potentiellement sa propre ligne `subscriptions`, initialisée indépendamment (`makeSub()` par défaut). Un observateur n'a aujourd'hui aucun moyen de lire l'abonnement d'un parent de sa famille — comme toutes les autres tables, `subscriptions` est probablement restreint à `user_id = auth.uid()` en RLS.

Décidé explicitement par l'utilisateur : le plan effectif de la famille = **le meilleur des deux plans parents** (si un des deux parents est Premium, toute la famille est traitée comme Premium — peu importe lequel des deux paie en pratique).

## Approche retenue

### 1. Nouvelle RPC `SECURITY DEFINER` : `get_family_billing_context()`

Pas de paramètre — utilise `auth.uid()` pour identifier l'appelant. Logique :
1. Trouve la ligne `family_members` active de l'appelant (`user_id = auth.uid()`, `status='active'`) → en déduit `family_id`.
2. Si l'appelant n'est pas `role='observer'`, retourne une erreur (cette RPC n'a de sens que pour un observateur qui vérifie son propre statut — pas un usage général).
3. Récupère les lignes `subscriptions` (plan, premium_since, cycle, trial_start, trial_extension_days, account_created_at) des membres `role='parent'` et `status='active'` de CE `family_id` uniquement.
4. Calcule le rang de l'appelant parmi les observateurs actifs de la même famille, ordonné par `family_members.created_at` (le même ordre chronologique que `cfg.observers[]` côté client — les observateurs ne sont jamais réordonnés, seulement ajoutés en fin de tableau).
5. Retourne `{ parentSubs: [...], myObserverRank: N }` (rang 0-based, cohérent avec l'indexation déjà utilisée côté parent pour le flou/verrou).

Aucune ligne `subscriptions` autre que celles des parents de SA PROPRE famille n'est jamais exposée — la fonction ne prend aucun paramètre qui pourrait être manipulé pour cibler une autre famille.

**Pourquoi ne pas calculer le plan effectif en SQL** : `subStatus()`/`getPerms()` (App.jsx:292-348) encapsulent déjà toute la logique (fenêtre de trial, bêta, extension de trial par parrainage...), testée et éprouvée côté client. La dupliquer en PL/pgSQL serait une deuxième source de vérité à maintenir en synchronisation permanente — source classique de bugs de désynchronisation. La RPC ne fait que lever la restriction RLS pour livrer les données brutes nécessaires ; le calcul du "meilleur plan" reste 100% côté client, en réutilisant `subStatus()`/`getPerms()` tels quels sur chacun des `parentSubs` reçus, puis en prenant le résultat le plus favorable (ordre : `freemium` < `trial_premium`/`earned_premium` < `premium`).

### 2. Nouveau gate dans `App()` : écran dédié si observateur hors quota

Après le login, pour tout `user?.role==="observer"` : appelle `get_family_billing_context()`, calcule `maxObservers` à partir du meilleur plan parent (même formule que `getPerms()` : `isPremium?Infinity:1`), compare à `myObserverRank`. Si `myObserverRank >= maxObservers` → nouvel état `observerOverQuota`, rendu comme gate à côté des gates existants (`removedObserver`, `EmailVerifyGate`, `pendingApproval`, App.jsx:4464-4499) — même position dans l'arbre de rendu (après tous les hooks, pour éviter de reproduire le bug de comptage de hooks déjà rencontré et corrigé sur ces mêmes gates, commit `db4e532`).

**Nouvel écran dédié** (pas de réutilisation de la page "Accès retiré") :
- Titre : "Accès en pause — limite du plan" (ou équivalent), icône distincte de 🚫 (ex. ⏳ ou 🔒) pour ne pas laisser croire à un retrait définitif.
- Texte expliquant que le plan actuel de la famille ne permet qu'un nombre limité d'observateurs, que ce n'est pas un retrait, et qu'un parent doit passer Premium pour lui redonner accès.
- Bouton "🔄 Réessayer" (recalcul immédiat, sans reload complet — utile si le parent vient de passer Premium pendant que l'observateur attend).
- Bouton "Se déconnecter" (`handleSetUser(null)`), même pattern que les autres gates.

### 3. Pas de changement RLS supplémentaire ailleurs

Ce blocage reste un gate applicatif (comme toutes les autres limites freemium/trial existantes : `maxChildren`, `maxCustomDates`, `maxVaultDocs` — aucune n'a de RLS dédiée, toutes sont des limites college côté client). Ce n'est pas une frontière de sécurité contre un accès non autorisé à des données personnelles (contrairement au cas de la localisation météo, où la fuite concernait la vie privée d'un tiers) — c'est un mur applicatif d'incitation commerciale, cohérent avec l'architecture déjà en place pour toutes les autres limites de plan. La seule nouveauté RLS est la RPC elle-même, strictement scoped à la propre famille de l'appelant.

## Non-objectifs

- Ne change rien à l'enforcement déjà en place côté parent (v1.79-1.80) — reste tel quel.
- Ne couvre pas le cas d'un observateur qui a plusieurs familles (item 14 du backlog, séparé, non traité ici).
- Ne modifie pas `subscriptions` ni son modèle par-compte — contourne le problème via la RPC plutôt que de le résoudre à la racine (un vrai passage à un modèle "abonnement par famille" serait un chantier bien plus large, hors scope ici).

## Test / vérification

- Aucun nouveau test unitaire pur attendu (la logique `subStatus()`/`getPerms()` réutilisée est déjà couverte indirectement ; le nouveau code est principalement de l'orchestration réseau + gate de rendu).
- `TZ=Europe/Paris npm test` doit rester vert (136 tests).
- Vérification live nécessaire (2 comptes parents + observateurs) : un 2e observateur ajouté pendant le Trial doit voir l'écran de blocage à la connexion ; passer un des deux parents en Premium (via le panneau admin/dev déjà existant, App.jsx:14806-14825) doit permettre à cet observateur de retrouver l'accès après clic sur "Réessayer", sans avoir à se déconnecter/reconnecter.
