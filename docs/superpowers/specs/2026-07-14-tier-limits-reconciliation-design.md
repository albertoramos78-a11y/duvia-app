# Réconciliation des paliers Freemium/Trial/Premium — design

**Date :** 2026-07-14
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

L'utilisateur a fourni une grille de référence pour ce que chaque fonctionnalité doit permettre selon le palier (Freemium/Trial/Premium), confirmée comme étant les **nouveaux plafonds** à coder (pas des valeurs d'exemple pour du QA). Comparé au code actuel (`getPerms()`, `App.jsx:318-348`), trois catégories d'écarts :

1. **Plafonds numériques à changer** : `maxObservers` (0/1/∞ → 0/2/5), `maxChildren` (1/2/∞ → 1/2/5), `maxStorageMB` (5/50/500 → 0/50/200).
2. **Fonctionnalités sans aucune restriction de plan aujourd'hui, à gater pour la première fois** : météo (bande météo du calendrier), messagerie, et le toggle observateur "Peut être gardien".
3. **Textes déjà obsolètes** une fois les nouveaux plafonds en place (mentions de "illimité"/"500 Mo" qui deviendraient fausses).

Un item de la grille ("Export planning classe et loisirs") est explicitement marqué "À CONSTRUIRE" par l'utilisateur lui-même — hors scope ici, backlog séparé (règle de palier notée : off/on/on, comme le reste de l'EDT).

## Grille de référence (confirmée par l'utilisateur)

| Fonctionnalité | Freemium | Trial | Premium |
|---|---|---|---|
| Observateurs (nombre max) | 0 | 2 | 5 |
| Observateur "Peut être gardien" | off | on | on |
| Enfants (nombre max) | 1 | 2 | 5 |
| Météo | off | on | on |
| Fête des mères / des pères / Anniversaire enfant / Date personnalisée / Planning classe et loisirs / Dépenses "Qui doit à qui" / Prévisionnel / Répertoire "Ajouter contact" / Coffre-fort (activé) | off | on | on |
| Coffre-fort — stockage (Mo) | 0 | 50 | 200 |

La ligne du milieu (fête des mères, etc.) était déjà correctement câblée (`!isFree` dans `getPerms()`) — confirmé par lecture directe du code, aucun changement nécessaire là-dessus, seulement vérifié.

## Approche retenue

### 1. `getPerms()` — plafonds numériques

```js
maxObservers:  isFree?0:isTrial?2:5,
maxChildren:   isFree?1:isTrial?2:5,
maxStorageMB:  isPremium?200:isTrial?50:0,
maxVaultSizeGB: isPremium?200/1024:isTrial?50/1024:0,
```

Ces valeurs sont déjà consommées de façon générique partout où elles existent (le verrou par index `isLocked = i >= perms.maxX`, déjà utilisé pour enfants ET observateurs ; `VAULT_MAX_MB`/le message de quota coffre-fort) — **aucun nouveau mécanisme d'application n'est nécessaire**, changer la valeur suffit. Ceci inclut la toute nouvelle RPC `get_family_billing_context`/`familyMaxObservers` (livrée aujourd'hui même) : elle appelle déjà `getPerms(bestParentSub).maxObservers` dynamiquement, donc le nouveau plafond de 5 s'applique automatiquement au blocage réel côté observateur sans toucher à ce code.

**Décision produit confirmée par l'utilisateur** : un observateur déjà actif dans une famille Freemium (donc maintenant au-delà du plafond 0) est flouté/bloqué exactement comme le cas Trial déjà livré — pas de "grand-père", même mécanisme déjà en place, rien de nouveau à construire pour ce cas.

**Hors scope explicite** : contrairement aux observateurs, un enfant qui dépasse le plafond ne reçoit PAS de blocage réel côté sa propre session (pas d'équivalent de la RPC `get_family_billing_context` pour les enfants) — seul le verrou existant côté écran de config du parent s'applique, comme aujourd'hui. Ce n'est pas demandé par la grille et serait un chantier à part entière (répliquer toute l'architecture RPC observateur pour les enfants).

### 2. Trois nouveaux gates (fonctionnalités jamais restreintes avant aujourd'hui)

Nouveaux champs dans `getPerms()` :
```js
weatherEnabled:   !isFree,
messagingEnabled: !isFree,
obsCanGuardEnabled: !isFree,
```

- **Météo** : dans `CalTab`, le bloc `ParentCityField` + bande météo (actuellement rendu pour `!isObs && !isChild` sans condition de plan) devient conditionné à `perms.weatherEnabled` en plus. En Freemium : remplacer par le même style de bandeau verrouillé/pointillé "Plan supérieur requis" déjà utilisé ailleurs (ex. `t.lockChildren`/le bouton pointillé de `StepId`), pas un nouveau composant.
- **Messagerie** : `MessagingTab` (actuellement sans aucune vérification de plan) — écran verrouillé Premium en Freemium, réutilisant le même overlay flouté déjà utilisé pour la carte d'invitation observateur (`App.jsx:10756`, `!prem && <div... 🔒 {t.lockSection}...>`).
- **"Peut être gardien"** (observateur) : le checkbox existe à DEUX endroits — dans le formulaire d'invitation (`StepAccess`, ~`App.jsx:10778`) et sur la fiche d'un observateur déjà actif (~`App.jsx:10890`). Les deux doivent être désactivés (`disabled`, style grisé) en Freemium, avec la même puce "🔒 Réservé Premium" déjà utilisée ailleurs dans `StepGarde`/`StepDates` (ex. `App.jsx:9622`).

### 3. Corrections de textes (deviendraient faux sinon)

- `App.jsx:9145` : `"Premium : enfants illimités"` → `"Premium : jusqu'à 5 enfants"`.
- `App.jsx:12665` : `"Passez en Premium pour 500 Mo."` → `"Passez en Premium pour 200 Mo."`.
- `PremiumTab`'s `items` (~`App.jsx:15112-15131`) : la ligne parents/enfants (`"Trial : 2, Premium : illimité"` → `"Trial : 2, Premium : 5"`), la ligne observateurs (déjà `"Observateurs (1 en Trial/Gratuit → illimité en Premium)"`, changée pour la 3e fois aujourd'hui pour refléter 0/2/5), et la ligne coffre-fort (`"Coffre-fort illimité — 1 Go"` — déjà incohérente avec l'ancien plafond de 500 Mo avant même ce changement — corrigée en `"Coffre-fort — 200 Mo"`).

## Non-objectifs

- Pas de blocage réel côté session enfant (architecture RPC) — seulement le verrou existant côté config parent, avec le nouveau chiffre.
- Pas de construction de l'export planning classe et loisirs — juste noté au backlog avec sa règle de palier (off/on/on), à scoper séparément.
- Pas de changement au plafond des dates personnalisées (`maxCustomDates`) — la grille ne donne que on/off pour cette ligne, déjà correct, chiffres actuels (0/2/∞) inchangés.

## Test / vérification

- Pas de nouveau test unitaire pur attendu (aucune nouvelle fonction dans `core.js` — tout ce travail est soit un changement de constante dans `getPerms()`, soit du câblage JSX direct).
- `TZ=Europe/Paris npm test` doit rester vert (136 tests).
- Vérification live nécessaire (hors de cet environnement) : compte Freemium confirmant météo/messagerie/peut-être-gardien verrouillés + 0 observateur/1 enfant max ; compte Trial confirmant 2 enfants/2 observateurs max ; compte Premium confirmant 5/5 puis blocage du 6e.
