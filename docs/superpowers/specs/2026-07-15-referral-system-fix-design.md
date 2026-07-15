# Rendre le parrainage réellement fonctionnel (multi-appareils) — design

**Date :** 2026-07-15
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Le système de parrainage (`ParrainageSection`, backlog item 12 — "actuellement non-fonctionnel pour de vrais utilisateurs") a une UI/des règles entièrement construites, mais l'implémentation ne fonctionne jamais pour deux vraies personnes sur deux appareils différents, pour 3 raisons indépendantes, toutes confirmées en lisant le code :

1. **Vérification du code parrain à l'inscription cassée.** `doReg()` (`App.jsx:~6128`) cherche le parrain via `users.find(u=>u.refCode===code)`, où `users` est `useLocalStorage("duvia_users", DEMO_USERS)` — un tableau **propre à l'appareil**, jamais synchronisé avec Supabase. Un vrai code d'un vrai parrain, entré sur un autre appareil, est toujours rejeté (`"Code parrain invalide"`).
2. **Crédit du bonus au parrain cassé de la même façon.** `_onFilleulValidated()` (`App.jsx:~3976`) cherche le parrain dans ce même tableau local pour lui créditer son bonus — même si l'inscription passait, le crédit n'atteindrait jamais le vrai parrain sur son appareil.
3. **Seuil de validation mathématiquement impossible à atteindre.** Sur les 10 actions définies dans `REF_ACTION_WEIGHTS` (`App.jsx:14404`), seules 3 sont réellement déclenchées quelque part dans le code (`ADD_EXPENSE`, `SEND_MESSAGE`, `ADD_CONTACT` — confirmé par recherche exhaustive des appels à `addRefAction(...)` et des 7 autres identifiants de type d'action, jamais référencés ailleurs que dans leur propre définition). Score maximum réel : 3 points. Seuil requis (`REF_SCORE_TARGET`) : 5. Aucun filleul ne peut jamais être validé, indépendamment des points 1 et 2.

**Trouvé en creusant, indépendant des 3 points ci-dessus** : le bouton "🧪 Simuler un filleul validé" (`simulateReferral()`, `App.jsx:~14547`) est visible pour n'importe quel compte réel, sans limite d'usage — chaque clic crédite un vrai `trialExtension`/`pendingSpins`/`validatedRefCount` sans qu'aucun filleul réel n'existe. C'est un exploit self-service pour obtenir du Premium gratuit à volonté, déjà exploitable en production aujourd'hui.

## Ce qui existe déjà et sur quoi on s'appuie

La table `subscriptions` a déjà, en production, toutes les colonnes nécessaires (confirmé par `information_schema.columns`, jamais capturées dans une migration de ce dépôt — même situation que la table elle-même, créée hors dépôt) :
`ref_code text`, `ref_used text`, `ref_count int`, `validated_ref_count int`, `ref_months int`, `pending_spins int`, `monthly_ref_month text`, `monthly_ref_count int`.

Le client synchronise déjà ces champs vers Supabase via l'effet "Sync sub → table subscriptions" existant (`App.jsx:~4210`) — cet effet n'est PAS modifié par ce plan, il continue de faire remonter l'état local `sub` (y compris après les nouvelles RPC) vers la table.

Aucune nouvelle table n'est nécessaire. Une seule colonne manque : un flag anti-rejeu pour empêcher un filleul de déclencher plusieurs fois le crédit de son parrain.

## Approche retenue

### 1. Migration : `subscriptions.ref_validated`

```sql
alter table public.subscriptions add column if not exists ref_validated boolean not null default false;
```

Empêche `credit_referral_validation()` (voir plus bas) d'être appelée plusieurs fois par le même filleul pour créditer son parrain en boucle.

### 2. Nouvelle RPC `consume_referral_code(p_code text)`

`SECURITY DEFINER`, appelée à l'inscription (`doReg()`) à la place du lookup local `users.find(...)`.

- Normalise `p_code` (trim + upper, comme le fait déjà le client).
- Cherche une ligne `subscriptions` où `ref_code = p_code` ET dont le `user_id` correspond à un compte actif (`auth.users` — un compte supprimé ne doit pas rester un parrain valide).
- Si trouvé : incrémente `ref_count` de CETTE ligne (le parrain) de manière atomique (`update ... set ref_count = ref_count + 1`), renvoie `{ valid: true, referrer_id }`.
- Si non trouvé : renvoie `{ valid: false }` (le client affiche `t.refInvalid` comme aujourd'hui — pas d'exception, un code invalide n'est pas une erreur serveur).

Le reste de l'inscription (création du compte, `refUsed` stocké sur la ligne du NOUVEAU compte) ne change pas — c'est déjà la propre ligne du nouvel utilisateur, remontée par l'effet de sync existant, aucun problème d'accès cross-compte là-dessus.

### 3. Nouvelle RPC `credit_referral_validation()`

`SECURITY DEFINER`, appelée par le CLIENT DU FILLEUL dès que son score local (`refActions`, logique inchangée côté client) atteint le seuil — remplace le crédit local actuel dans `_onFilleulValidated()`.

- Utilise `auth.uid()` pour identifier l'appelant (le filleul) — jamais un paramètre.
- Vérifie que la ligne `subscriptions` de l'appelant a `ref_used is not null` et `ref_validated = false` — sinon lève une exception (`already_validated` ou `no_referrer`), le client n'affiche alors simplement rien de plus (idempotent : si l'appel arrive deux fois, la 2e échoue silencieusement côté client).
- Retrouve le parrain via `ref_used` (même requête que `consume_referral_code`).
- **Recalcule le bonus côté serveur** (ne fait JAMAIS confiance à un montant envoyé par le client — un filleul pourrait sinon s'auto-attribuer n'importe quel bonus pour son parrain, ou pire, pour lui-même) :
  - Si le parrain est Premium payant (`plan = 'premium'` et non expiré, même logique de fenêtre que `subStatus()` client — dupliquée ici en SQL car c'est un calcul de sécurité, pas un affichage : le compromis DRY habituel de ce projet ne s'applique pas quand le calcul protège contre un abus) : `+1j` par filleul validé, plafond `5/mois`, reset mensuel (`monthly_ref_month`/`monthly_ref_count`).
  - Sinon (Trial/Freemium) : paliers dégressifs `{1: +5j, 2: +10j, 3+: +0j}`, plafonnés à 30j cumulés depuis la création du compte (mêmes constantes que `REF_TRIAL_PALIERS`/`TRIAL_MAX_DAYS` côté client, dupliquées ici).
- Met à jour EN UNE TRANSACTION : la ligne du filleul (`ref_validated = true`, `plan = 'earned_premium'` si pas déjà mieux), et la ligne du parrain (`trial_extension_days` ou `monthly_ref_month`/`monthly_ref_count`, `validated_ref_count += 1`, `pending_spins += 1`).
- Renvoie `{ ok: true }`.

Le client, après un appel réussi, relit son propre statut (déjà fait par l'effet de vérification de plan existant) — pas besoin d'une notification temps réel vers le parrain pour cette V1 (le parrain verra son bonus la prochaine fois qu'il ouvre l'app, exactement comme le reste des mises à jour de plan aujourd'hui).

### 4. Seuil de validation : abaissé à 3 (Option A retenue)

`REF_SCORE_TARGET: 5 → 3` (`App.jsx:14422`). Correspond exactement aux 3 actions déjà réellement câblées (`ADD_EXPENSE`, `SEND_MESSAGE`, `ADD_CONTACT`, chacune 1pt et "forte"). `REF_STRONG_MIN` reste à 2 (déjà satisfait par n'importe quelles 2 de ces 3 actions). Aucun nouveau point de déclenchement à câbler ailleurs dans l'app pour cette version — les 7 autres types d'action restent définis mais jamais déclenchés (non-objectif explicite, voir plus bas).

### 5. Bouton "Simuler un filleul validé" réservé aux admins

`ParrainageSection` reçoit `isAdm` via `useApp()` (déjà disponible dans le contexte). Le bloc "🧪 Mode démo" (bouton + logique `simulateReferral()`) n'est rendu que si `isAdm` est vrai — plus aucun compte normal ne peut s'auto-créditer.

### 6. Client : remplacer les 2 lookups locaux

- `doReg()` : remplacer le bloc `users.find(u=>u.refCode===code)` / `setUsers(...)` par un appel à `consume_referral_code(code)`. Si `valid:false`, afficher `t.refInvalid` comme aujourd'hui. Si `valid:true`, continuer l'inscription normalement (`refUsed=code` local, remonté par la sync existante).
- `_onFilleulValidated()` : remplacer tout le corps (recherche locale du parrain + `setUsers`) par un appel à `credit_referral_validation()`. Le popup `showReferreePopup`/mise à jour locale du filleul (`setSub(s=>({...s, plan:"earned_premium"}))`) reste déclenché côté client immédiatement pour la réactivité UI — la RPC est la source de vérité qui persiste réellement l'état, l'effet de sync existant réconciliera si besoin.

## Non-objectifs

- Ne câble pas les 7 types d'action jamais utilisés (`UPLOAD_DOC`, `ADD_EVENT`, `PARENT_ACCEPTED`, `OBSERVER_ACCEPTED`, `ADD_CHILD`, `CHANGE_ZONE`, `ACTIVATE_EVENT`) — Option B explicitement écartée pour cette version.
- Ne rend pas `refActions` (le score d'engagement du filleul) synchronisé multi-appareils — reste `useLocalStorage`, propre à l'appareil, comme aujourd'hui. Si un filleul change d'appareil avant d'avoir complété ses 3 actions, sa progression recommence à zéro sur le nouvel appareil.
- Ne touche pas l'outil admin de gestion des abonnements (`AccountSubscriptionCard` etc.) ni la table `admin_subscription_log`.
- Ne notifie pas le parrain en temps réel quand son bonus est crédité — il le verra à sa prochaine connexion/rafraîchissement, comme le reste des changements de plan aujourd'hui.

## Test / vérification

- `TZ=Europe/Paris npm test` doit rester vert.
- Aucun test automatisé possible pour les 2 nouvelles fonctions SQL (pas d'accès CLI Supabase dans cet environnement) — vérification par relecture du SQL uniquement, déploiement/test réel fait par l'utilisateur.
- Vérification live obligatoire avec 2 VRAIS comptes parents sur 2 appareils/navigateurs différents (le bug principal n'est reproductible qu'ainsi — jamais testable sur un seul appareil) :
  1. Compte A partage son code. Compte B s'inscrit avec ce code sur un AUTRE navigateur/appareil — l'inscription doit être acceptée (pas "Code parrain invalide").
  2. B démarre en Trial Premium, fait les 3 actions (dépense, message, contact).
  3. B passe en "Premium – 15j restants", popup filleul affiché.
  4. A reçoit son bonus (+5j la 1ère fois) + 1 tour de roue — visible à sa prochaine connexion.
  5. Le bouton "Simuler un filleul validé" n'apparaît plus pour B (compte normal), reste visible pour un compte admin.
