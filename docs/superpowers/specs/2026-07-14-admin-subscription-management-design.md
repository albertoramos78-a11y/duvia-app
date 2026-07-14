# Gestion admin des abonnements (bascule bêta globale + override par compte) — design

**Date :** 2026-07-14
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Backlog item 10 ("refonte AdminTab, bloqué : demander ce qui motive ça") trouve enfin sa motivation concrète. Deux besoins distincts, confirmés par l'utilisateur :

1. **La bascule bêta actuelle est un mur en dur.** `isBeta()` (`App.jsx:419`) compare `Date.now()` à `BETA_END`, une constante codée en dur à `2030-01-01` (`App.jsx:404`) — en pratique la bêta est "active" en permanence tant que personne ne modifie et redéploie le code. L'utilisateur veut une case à cocher + une date de fin, pilotable depuis l'app.
2. **Aucun outil ne permet de changer l'abonnement d'un VRAI compte.** L'outil existant ("🎁 Offrir Premium à un compte", `App.jsx:14997-15022`) ne touche que la liste locale `users` (non synchronisée avec Supabase — l'écran le dit lui-même) : il ne fonctionne pas sur un vrai utilisateur en prod. Il faut un vrai outil serveur.

## Modèle confirmé par l'utilisateur

**Deux mécanismes indépendants, avec une règle de priorité entre eux :**

### 1. Bascule bêta globale
Case à cocher + date de fin, stockée en base (pas dans le code), s'applique à **tous les comptes, nouveaux et existants**. Si activée et date non dépassée : tout le monde passe en Trial Premium — **sauf** les comptes ayant un vrai Premium payé (déjà le comportement actuel, priorité au Premium réel inchangée).

### 2. Override par compte (via l'outil admin, recherche par email)
Remplace la bascule globale **pour ce compte précis** si un override est défini. Quatre choix :
- **Freemium** → `plan: "freemium"`.
- **Bêta** → nouvelle valeur `plan: "beta"`, avec sa **propre** date de fin (différente de la bascule globale). Tant que non dépassée : accès complet. **Une fois dépassée, bascule automatiquement vers Trial Premium avec un nouvel essai de 15 jours démarrant à cette date de fin** — calculé à la volée par `subStatus()`, sans job planifié ni écriture différée en base.
- **Trial Premium** → `plan: "trial_premium"`, essai de 15 jours démarrant immédiatement (pas de date à saisir).
- **Premium** → `plan: "premium"`, choix mensuel/annuel, repasse en Freemium à l'échéance (comportement déjà existant, inchangé).

### Priorité
Un compte avec un override (`plan` ∈ {freemium, beta, trial_premium, premium} défini explicitement par l'admin) applique cet override **avant** de considérer la bascule globale — exactement symétrique à la règle déjà en place pour le vrai Premium (vérifié en premier, prioritaire sur tout le reste).

## Architecture

### 1. Nouvelle table `app_config` (bascule globale)

Table à une seule ligne (singleton), lisible par tout client authentifié (chaque page load a besoin de savoir si la bêta globale est active, sans latence d'appel à une Edge Function) :
```sql
create table public.app_config (
  id           int primary key default 1,
  beta_enabled boolean not null default false,
  beta_end     timestamptz,
  constraint app_config_singleton check (id = 1)
);
insert into public.app_config (id) values (1) on conflict do nothing;

alter table public.app_config enable row level security;
create policy "app_config_select_authenticated" on public.app_config
  for select to authenticated using (true);
-- Aucune policy INSERT/UPDATE/DELETE : seule la Edge Function (service role) peut écrire.
```

### 2. Nouvelle colonne `subscriptions.beta_end`

```sql
alter table public.subscriptions add column if not exists beta_end timestamptz;
```
Nullable, uniquement pertinente quand `plan = 'beta'`.

### 3. `subStatus()` réécrit — nouvelle signature `subStatus(sub, globalBeta)`

`globalBeta` est `{enabled: boolean, endMs: number|null}`, lu une fois par client depuis `app_config` (voir section 5). Nouvel arbre de décision (`App.jsx:292-313`), dans l'ordre :

1. `sub._admin` → `"premium"` (inchangé).
2. `sub.plan === "premium"` → vérifie l'expiration réelle ; si expiré, `return "freemium"` immédiatement, **exactement comme aujourd'hui** (pas de changement de comportement ici — un abonnement Premium expiré ne redevient pas éligible à la bêta, ni globale ni par override, ce n'est pas demandé et ça ajouterait un cas particulier non sollicité).
3. **Nouveau** — `sub.plan === "beta"` :
   - Si `Date.now() < sub.betaEnd` → `"trial_premium"` (accès identique à un trial, mais traçable côté admin comme override bêta — voir note ci-dessous sur la valeur de retour).
   - Sinon (date dépassée) → calcule comme un `trial_premium` dont le point de départ est `sub.betaEnd` (pas `sub.accountCreatedAt`) : `créé = sub.betaEnd`, applique la même fenêtre de 15 jours (`TRIAL_BASE_DAYS`) qu'un trial normal. Expire ensuite normalement vers `"freemium"`.
4. **Nouveau** — `globalBeta.enabled && Date.now() < globalBeta.endMs` → `"trial_premium"` (remplace l'actuel `if(isBeta()) return "trial_premium"`).
5. Le reste est inchangé : `sub.plan==="freemium"` → `"freemium"` ; sinon calcul du trial/earned_premium normal basé sur `accountCreatedAt`/`trialStart`.

**Note sur la valeur de retour pour l'étape 3 (bêta active) :** `subStatus()` retourne `"trial_premium"`, pas une valeur `"beta"` distincte — l'accès fonctionnel est strictement identique à un trial (mêmes `getPerms()`), et cela évite de propager une 5ᵉ valeur de statut dans tout le code qui fait déjà `st==="trial_premium"`. L'écran admin affiche le `plan` BRUT (`sub.plan==="beta"`), pas `subStatus()`, pour rester traçable — voir section 6.

### 4. `isBeta()` garde sa signature actuelle (zéro paramètre) — cache module + un seul re-render forcé

`BETA_END` était déjà une simple constante module-level lue directement par `isBeta()`, sans transiter par le contexte React ni par aucun paramètre — exactement comme `TRIAL_BASE_DAYS`/`TRIAL_MAX_DAYS`/`REF_TRIAL_PALIERS`. `globalBeta` (la version "chargée depuis la base" de cette même constante) garde ce même rôle architectural : **pas la peine de la faire transiter en paramètre explicite à travers `subStatus()`/`getPerms()`/`isPrem()`/`isPremFull()`/`isFreemiumPlan()`/`planRankFor()`/`familyMaxObservers()` et leurs ~25 points d'appel** (9 pour `subStatus()`, 13 pour `isBeta()` directement, 3 pour `getPerms()`) — un simple cache module-level suffit et ne change la signature d'aucune de ces fonctions :

```js
// Rempli une seule fois par un effet dans App() (section 5) ; lu directement
// par isBeta(), exactement comme BETA_END l'était avant — même rôle
// architectural (une constante partagée), juste chargée depuis la base au
// lieu d'être codée en dur.
let _globalBetaCache = { enabled: false, endMs: null };
function isBeta() { return _globalBetaCache.enabled && Date.now() < (_globalBetaCache.endMs ?? 0); }
```

**Aucun changement nécessaire** sur `subStatus(sub)`, `getPerms(sub)`, `isPrem(sub)`, `isPremFull(sub)`, `isFreemiumPlan(sub)`, `planRankFor(sub)`, `familyMaxObservers(parentRows)`, ni sur leurs ~25 points d'appel existants dans `App.jsx` — ils continuent d'appeler `isBeta()` exactement comme avant, et lisent transparemment la valeur à jour dès qu'elle est chargée.

### 5. Câblage client — un seul fetch, un seul re-render forcé au chargement

Dans `App()`, un effet au montage récupère `app_config` une fois et met à jour le cache module-level ci-dessus, puis force UN SEUL re-render (via un état trivial) pour que tous les composants déjà montés qui appellent `isBeta()`/`subStatus()` pendant leur rendu (donc `App()` lui-même et tout ce qui est sous son contexte) relisent la valeur fraîche :

```js
const [, forceBetaRerender] = useReducer(x => x + 1, 0);
useEffect(() => {
  supabase.from("app_config").select("beta_enabled, beta_end").eq("id", 1).maybeSingle()
    .then(({ data }) => {
      if (!data) return;
      _globalBetaCache = { enabled: !!data.beta_enabled, endMs: data.beta_end ? new Date(data.beta_end).getTime() : null };
      forceBetaRerender();
    });
}, []);
```
Ce fetch se fait via une simple lecture RLS (`app_config` est lisible par tout compte authentifié, section 1) — pas besoin d'appeler la Edge Function pour LIRE la config globale, seulement pour l'ÉCRIRE (réservé aux admins).

### 6. Edge Function `admin-manage-subscriptions`

Même famille que `admin-backup-manager` (déjà existant, non commité dans ce repo — pattern d'action multiplexée `{action, ...extra}` déjà établi côté client, `App.jsx:14714-14729`). Vérifie l'appelant contre `app_admins` (même mécanisme que la vérification client existante, `App.jsx:3376-3388`) avant toute action.

Actions :
- `lookup_user` `{email}` → résout via l'API Admin Supabase (`auth.admin.listUsers` filtré, ou équivalent), renvoie `{user_id, name, email, sub}` (la ligne `subscriptions` actuelle du compte trouvé) ou une erreur si introuvable.
- `set_user_plan` `{user_id, plan, beta_end?, premium_cycle?}` :
  - `plan==="freemium"` → `update subscriptions set plan='freemium' where user_id=$1`.
  - `plan==="beta"` → `update ... set plan='beta', beta_end=$beta_end where user_id=$1` (`beta_end` requis, fourni par le client).
  - `plan==="trial_premium"` → `update ... set plan='trial_premium', account_created_at=now(), trial_start=now(), premium_since=null, trial_extension_days=0 where user_id=$1`.
  - `plan==="premium"` → `update ... set plan='premium', premium_since=now(), cycle=$premium_cycle where user_id=$1` (`premium_cycle` ∈ {monthly, yearly}, requis).
- `set_global_beta` `{enabled, end_date}` → `update app_config set beta_enabled=$enabled, beta_end=$end_date where id=1`.

### 7. UI `AdminTab`

Remplace la carte "🎁 Offrir Premium à un compte" (`App.jsx:14997-15022`, qui n'agissait que sur `users` local) par deux nouvelles cartes :

- **"🌍 Bêta globale"** : case à cocher (activé/désactivé) + champ date, bouton "Enregistrer" → appelle `set_global_beta`. Affiche l'état actuellement enregistré (pas seulement ce qui est en cours de saisie).
- **"👤 Gérer l'abonnement d'un compte"** : champ email + "Chercher" (même pattern que Backup Manager, `App.jsx:14832-14845`) → `lookup_user`. Une fois trouvé, affiche nom/email/plan actuel, puis 4 boutons : Freemium · Bêta (+ champ date, requis pour ce bouton uniquement) · Trial Premium (aucun champ) · Premium (+ choix mensuel/annuel). Chaque bouton appelle `set_user_plan` avec les bons paramètres.

## Non-objectifs

- Pas de job planifié / cron pour faire expirer la bêta par-compte — tout est calculé à la volée dans `subStatus()`, comme le reste de la logique d'abonnement dans cette app.
- Pas de historique des changements d'abonnement (qui a changé quoi, quand) — hors scope, pourrait être un futur ajout à `history`/`family_backup_log`-style logging si demandé plus tard.
- Ne touche pas au système de parrainage (`earned_premium`, `trialExtension`) — ces mécaniques restent inchangées, `earned_premium` reste distinct de `beta`.
- L'outil "🎁 Offrir Premium" local existant est remplacé, pas conservé en parallèle (il n'a plus de raison d'être une fois le vrai outil serveur en place).

## Test / vérification

- Nouveaux tests unitaires : aucune nouvelle fonction pure dans `core.js` (toute cette logique vit dans `App.jsx`, câblée à Supabase) — vérification par lecture de code + test live, comme le reste du code d'abonnement existant (`subStatus`/`getPerms` n'ont jamais eu de tests dédiés dans `core.test.js`).
- `TZ=Europe/Paris npm test` doit rester vert (136 tests, aucun ne couvre cette zone).
- Vérification live nécessaire : (a) activer la bascule globale avec une date future → confirmer qu'un compte Freemium sans override voit son statut passer en Trial Premium ; (b) mettre un compte spécifique en Bêta avec une date de fin proche, attendre qu'elle passe → confirmer le passage automatique en Trial Premium (15j) sans action manuelle ; (c) confirmer qu'un compte avec un vrai Premium payé n'est jamais affecté ni par la bascule globale ni par un override accidentel absent.
