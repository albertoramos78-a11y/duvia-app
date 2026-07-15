# Partage familial du meilleur plan (parents + enfants + observateurs) — design

**Date :** 2026-07-15
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Découvert en testant l'outil admin de gestion d'abonnement (voir `docs/superpowers/plans/2026-07-14-admin-subscription-management.md`) : un parent a acheté Premium (`subscriptions.plan="premium"` sur son propre compte). Son co-parent, dans la même famille, reste affiché "Essai expiré" (Freemium effectif) puisque *son propre* compte n'a personnellement rien souscrit.

Décidé explicitement par l'utilisateur : le statut effectif d'un compte = **le meilleur des deux plans parents de sa famille active** — pas seulement son propre plan individuel — et ceci doit s'appliquer à **toute la famille** (parents, enfants, observateurs), pas seulement au calcul du quota d'observateurs déjà en place depuis le 2026-07-14 (`familyMaxObservers()`/`get_family_billing_context()`, `docs/superpowers/specs/2026-07-14-observer-quota-enforcement-design.md`). Raison donnée : les enfants et observateurs utilisent déjà la messagerie, qui reste une fonctionnalité verrouillée en Freemium — ils doivent eux aussi bénéficier du meilleur plan de la famille, pas seulement les 2 parents entre eux.

## Ce qui existe déjà et sur quoi on s'appuie

- `subStatus(sub)`/`getPerms(sub)`/`planRankFor(sub)` (`App.jsx:292-370`) : logique pure, testée, qui NE DOIT PAS être dupliquée ailleurs (même principe déjà posé dans le design du 2026-07-14 — voir sa section "Pourquoi ne pas calculer le plan effectif en SQL").
- `get_family_billing_context(p_family_id uuid default null)` (migration `0036`) : RPC `SECURITY DEFINER` qui renvoie déjà les lignes `subscriptions` brutes des 2 parents actifs d'une famille — mais **refuse tout appelant dont le rôle n'est pas `observer`** (`raise exception 'not_an_observer'`), et ne renvoie que les champs de plan bruts (aucun identifiant de parent).
- `familyMaxObservers(parentRows)` (`App.jsx:390-408`) : réduit déjà les lignes brutes au "meilleur des deux plans parents" via `planRankFor()`, mais seulement pour en tirer `getPerms(best).maxObservers`.

## Approche retenue

### 1. Étendre `get_family_billing_context` (migration éditée en place — jamais encore utilisée par un appelant non-observateur, donc pas de rupture pour l'existant)

- Retirer la restriction `if v_role <> 'observer' then raise exception 'not_an_observer'` : tout membre actif (`parent`/`child`/`observer`) de la famille peut appeler cette fonction pour connaître le statut effectif de SA PROPRE famille active. La vérification de périmètre reste inchangée et suffisante : `v_family_id` n'est résolu que via la propre ligne `family_members` de l'appelant (`user_id = auth.uid()`), donc impossible de cibler une autre famille que la sienne.
- Ajouter une colonne `parent_user_id uuid` aux lignes retournées — **mais seulement remplie si l'appelant lui-même a `v_role = 'parent'`** (sinon `NULL`). Un enfant ou un observateur qui interroge cette fonction pour connaître son propre statut effectif ne reçoit donc jamais l'identité d'un parent — il n'en a pas besoin (il n'y a pas de bannière "via votre famille" en dehors de `PremiumTab`, qui n'est de toute façon affiché qu'aux parents, voir plus bas).
- **Pas de champ email dans cette fonction.** Voir section 3 pour comment `PremiumTab` obtient l'email du co-parent payeur.
- Le reste de la fonction (calcul de `my_observer_rank`, jointure sur `subscriptions` des membres `role='parent'`) reste inchangé.

**Sécurité — pourquoi ce découpage plutôt qu'un simple retrait de la restriction de rôle** : élargir l'accès à cette RPC sans réduire les données exposées aurait permis à n'importe quel compte enfant (potentiellement mineur, cette app est déjà attentive au RGPD ailleurs) de récupérer, via l'onglet Réseau du navigateur, l'identité et à terme l'email d'un de ses parents — une exposition que rien dans la fonctionnalité ne justifie. Le filtrage se fait côté serveur sur le rôle de l'appelant (`v_role`, lu depuis `family_members`, non falsifiable par le client), pas côté client.

### 2. Client — un seul point de calcul, réutilisé par toute l'app

L'effet existant qui appelle `get_family_billing_context` (`App.jsx:~3320-3339`, aujourd'hui gardé par `user?.role !== "observer"`) est élargi à tous les rôles et fusionné avec le nouveau calcul (un seul appel réseau/famille, pas deux) :

- Extraire de `familyMaxObservers()` la logique de réduction "meilleur des 2 parents" (actuellement le `subs.reduce(...)`, `App.jsx:406`) dans une fonction partagée, réutilisée à la fois par `familyMaxObservers()` (inchangé dans son résultat) et par le nouveau calcul ci-dessous.
- Nouvel état `familyBestSub` (objet au même format que `sub`, ou `null` tant que non résolu / pas de famille / erreur réseau).
- `effectiveSub = familyBestSub && planRankFor(familyBestSub) > planRankFor(sub) ? familyBestSub : sub` — ne jamais dégrader : si l'appel échoue, n'a pas encore répondu, ou si le plan individuel est déjà meilleur (le payeur lui-même), on retombe sur `sub` exactement comme aujourd'hui.
- `st`, `prem`, `perms`, `days` (`App.jsx:4048-4051`, aujourd'hui dérivés de `sub`) sont recalculés à partir de `effectiveSub` — c'est le seul endroit qui change ; tout le reste de l'app (messagerie, coffre-fort, dates perso, météo, quotas enfants/observateurs, bandeaux Trial/Freemium déjà gérés par `!isObs && !isChild && st===...`) en bénéficie automatiquement pour parents, enfants ET observateurs.
- **Exception explicite** : `perms.spinWinSub` (gain de mois Premium à la roue de la fortune) reste calculé sur le `sub` **individuel**, jamais sur `effectiveSub` — un compte qui bénéficie du plan familial sans payer lui-même peut tourner la roue (`canSpin` suit `effectiveSub` comme le reste) mais ne doit pas pouvoir gagner un lot Premium tant qu'il n'est pas lui-même payeur.
- `sub`/`setSub` (état individuel, synchronisation vers la table `subscriptions`) restent strictement inchangés — uniquement la lecture pour l'affichage/les permissions change, jamais l'écriture ni le stockage.

### 3. `PremiumTab` — bandeau "Premium via votre famille"

`PremiumTab` (`App.jsx:15402`) n'est aujourd'hui accessible qu'aux parents (l'entrée de menu correspondante n'existe pas pour `isObs`/`isChild`, confirmé dans le code) — donc seul un parent peut voir ce bandeau, et uniquement dans un contexte où il a déjà, par ailleurs, une relation directe avec son co-parent (calendrier partagé, dépenses, messagerie).

- Détecter `familyPremiumFromCoParent = familyBestSub && familyBestSub.parent_user_id && familyBestSub.parent_user_id !== myUid && planRankFor(familyBestSub) > planRankFor(sub)`.
- Si vrai : bandeau "⭐ Premium via votre famille : {email} y a souscrit" à la place de l'écran normal — pas de bouton "Annuler l'abonnement" (rien à annuler), pas de proposition d'achat en double. Le reste de l'écran (roue, parrainage) reste normal.
- **Résolution de l'email** : puisque la RPC ne renvoie jamais d'email (section 1), `PremiumTab` résout l'email du payeur via un appel dédié, uniquement quand `familyPremiumFromCoParent` est vrai et seulement pour ce seul `parent_user_id` (pas une liste) — implémentation : étendre la fonction Edge `admin-manage-subscriptions` n'est PAS adapté ici (réservée aux admins) ; utiliser à la place une nouvelle RPC minimale `get_coparent_email(p_user_id uuid)` `SECURITY DEFINER`, qui vérifie que l'appelant (`auth.uid()`) et `p_user_id` sont bien tous deux `role='parent'` actifs de la MÊME famille avant de renvoyer `(select email from auth.users where id = p_user_id)` — sinon lève une erreur. Même pattern de vérification que `set_member_identity` (`0020_member_email.sql`).

## Non-objectifs

- Ne modifie pas `subscriptions` (aucune ligne individuelle n'est réécrite) — le partage est purement une résolution en lecture, à la volée, jamais persistée.
- Ne touche pas à l'outil admin (`AccountSubscriptionCard`/`PremiumSubscribersCard`/`AdminChangeLogCard`) : ces écrans listent les abonnements individuels réels (qui paie quoi) — c'est le comportement correct pour un outil de facturation, indépendant du statut effectif affiché dans l'app.
- Ne couvre pas le cas d'un observateur/enfant appartenant à plusieurs familles (item 14 du backlog, séparé) — la résolution utilise la famille active (`familySync.familyId`), comme le fait déjà le calcul de quota d'observateurs.
- Ne change rien à `familyMaxObservers()`/`observerOverQuota` dans leur résultat, seulement leur code interne (réduction extraite en fonction partagée).

## Test / vérification

- `TZ=Europe/Paris npm test` doit rester vert (136 tests) — la logique `subStatus()`/`getPerms()`/`planRankFor()` réutilisée est déjà couverte indirectement ; le nouveau code est principalement de l'orchestration réseau + un point de branchement.
- Vérification live avec des comptes de test réels fournis en direct par l'utilisateur (un parent Premium réel + son co-parent, dans la même famille) :
  - Le co-parent doit voir : messagerie/coffre-fort/dates perso débloqués, plus de bandeau "Essai expiré", et dans `PremiumTab` le bandeau "Premium via votre famille : {email du parent payeur} y a souscrit" sans bouton annuler.
  - Le parent payeur ne doit voir aucun changement (déjà Premium via son propre abonnement — `effectiveSub` reste égal à son `sub` individuel).
  - Un enfant/observateur de cette famille doit aussi voir l'accès messagerie/coffre-fort élargi.
  - Vérifier dans l'onglet Réseau qu'aucun email de parent ne transite jamais vers une session enfant/observateur, et que `parent_user_id` y est bien `null`.
  - Faire expirer/repasser le parent payeur en Freemium via l'outil admin et vérifier que le co-parent repasse correctement à son propre statut individuel (pas de sur-blocage ni de sur-octroi résiduel).

> **Note sécurité (ajoutée après coup)** : les identifiants réels de comptes/famille utilisés lors des tests live de cette fonctionnalité (UUID de comptes, code d'invitation famille) ne doivent JAMAIS être écrits dans ce dépôt (code, docs, commits) — seulement échangés en conversation directe si besoin de diagnostic ponctuel. Ce document a été réécrit pour retirer les identifiants réels qui y avaient été committés par erreur.
