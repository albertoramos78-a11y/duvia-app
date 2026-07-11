# Double authentification (2FA) optionnelle — Design

**Statut :** approuvé, prêt pour planification.
**Backlog :** item 6, demande de recherche utilisateur ("comment proposer l'activation d'une double vérification de connexion ? et si c'est possible, quand le faire ?").

## Contexte

Recherche préalable au brainstorm : le client Supabase installé (`@supabase/auth-js`, utilisé par `@supabase/supabase-js@2.108.2`) expose déjà une API MFA (TOTP, type Google Authenticator/Authy) complète côté client — `supabase.auth.mfa.enroll/challenge/verify/unenroll/listFactors/challengeAndVerify/getAuthenticatorAssuranceLevel` — confirmé en inspectant directement le package installé (`node_modules/@supabase/auth-js/dist/module/GoTrueClient.js`), pas supposé. `enroll({factorType:"totp"})` renvoie même un QR code prêt à afficher (`data.totp.qr_code`, une image SVG) — pas besoin d'ajouter de librairie de génération de QR code. C'est donc majoritairement du "brancher une capacité déjà existante", pas construire un mécanisme MFA from scratch.

Décisions déjà prises par l'utilisateur :
- **Optionnel** (opt-in), jamais imposé.
- **Tous les rôles** (parent, enfant, observateur, admin) — contrairement à la vérification email (parents uniquement, à cause de l'absence de vraie boîte mail pour les comptes téléphone), le TOTP ne dépend d'aucun email : n'importe qui avec un téléphone peut installer une appli d'authentification.
- **Codes de secours** générés à l'activation, plutôt qu'un contact support manuel en cas de perte d'appareil.

La seule vraie pièce à construire nous-mêmes est la gestion des codes de secours (Supabase ne les gère pas nativement) : une table dédiée + 2 fonctions RPC, suivant exactement le pattern déjà établi cette session (`parent_email_verifications`, `known_devices`) — RLS activée sans policy, accès uniquement via RPC `SECURITY DEFINER`.

## Architecture

### 1. Activation — Préférences (tous les rôles)

Nouvelle section "Sécurité" dans `PrefsTab` et `ObserverPrefsTab` (à côté des sections existantes "Changer mon mot de passe"/"Changer mon adresse email").

**Compte sans 2FA active** :
- Bouton "Activer la double authentification" → `supabase.auth.mfa.enroll({factorType:"totp"})`.
- Affiche `data.totp.qr_code` (image) + `data.totp.secret` (saisie manuelle, fallback si le QR code ne peut pas être scanné) + un champ pour saisir le code à 6 chiffres généré par l'appli d'authentification une fois le compte ajouté.
- Validation : `supabase.auth.mfa.challengeAndVerify({factorId, code})`. En cas d'échec (code invalide/expiré), message d'erreur, on reste sur l'écran de saisie.
- Une fois validé : appel à la RPC `generate_mfa_backup_codes()` (voir section 3), affichage **unique** des 10 codes en clair avec un avertissement explicite ("note-les maintenant, ils ne seront plus jamais affichés") et un bouton pour les copier/télécharger en `.txt`.

**Compte avec 2FA déjà active** :
- Affiche "Double authentification activée".
- Bouton "Désactiver" → `supabase.auth.mfa.unenroll({factorId})` côté client, puis appel à la RPC `clear_mfa_backup_codes()` pour supprimer les codes de secours devenus inutiles.
- Bouton "Régénérer mes codes de secours" → rappelle `generate_mfa_backup_codes()` (invalide silencieusement les anciens codes, en génère 10 nouveaux), même écran d'affichage unique que lors de l'activation.

### 2. Vérification à la connexion (tous les points d'entrée)

S'applique aux 3 points de connexion déjà identifiés dans une fonctionnalité précédente cette session (`doLogin()`, `doLoginAndJoin()`, le handler Google OAuth `SIGNED_IN`) — les 3 vivent soit dans `LoginScreen` soit dans `App()`, donc la logique de vérification MFA doit être dupliquée aux 3 endroits (ou factorisée en une fonction module-level réutilisable, comme la leçon apprise aujourd'hui avec `notifyIfNewDevice` — **cette fois dès la conception**, pas après un bug en prod).

Juste après une connexion réussie (mot de passe ou Google) et AVANT de finaliser la connexion (avant `onLogin(...)`) :
- Appeler `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`. Si `currentLevel !== nextLevel` (un facteur MFA vérifié existe et n'a pas encore été challengé pour CETTE session), afficher un écran intermédiaire "Entre le code de vérification" au lieu de continuer.
- Le champ de saisie (6 chiffres) valide via `supabase.auth.mfa.challengeAndVerify({factorId, code})` — en cas de succès, la fonction de connexion reprend normalement à partir de ce point (construction du profil, `onLogin(...)`).
- Lien "J'ai perdu mon appareil" → bascule vers un champ de saisie d'un code de secours → appel à la RPC `redeem_mfa_backup_code(p_code)`. Si elle renvoie `true` (code valide, jamais utilisé) : le compte n'a plus aucun facteur MFA actif (voir section 3, la RPC les supprime), donc la connexion peut se terminer normalement sans nouveau challenge ; afficher un message clair : "La double authentification a été désactivée sur ce compte car un code de secours a été utilisé — réactive-la depuis les Préférences si tu veux." Si elle renvoie `false`, message d'erreur, on reste sur l'écran.

### 3. Nouvelle table + RPCs

Aucune Edge Function nécessaire. Une seule nouvelle table :

```sql
CREATE TABLE public.mfa_backup_codes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

RLS activée, aucune policy (même pattern deny-all que `parent_email_verifications`/`known_devices` — accès uniquement via les RPC ci-dessous). Hachage via l'extension `pgcrypto` (`crypt()`/`gen_salt('bf')`, le même mécanisme standard que le hachage de mot de passe).

- `generate_mfa_backup_codes() RETURNS TEXT[]` (`SECURITY DEFINER`, `auth.uid()`) : supprime les codes non utilisés existants de l'utilisateur, génère 10 codes aléatoires (10 caractères hexadécimaux chacun), les stocke hachés, renvoie le tableau de codes **en clair** — la seule fois où ils existent en clair, côté RPC, avant d'être immédiatement affichés puis jamais re-servis.
- `redeem_mfa_backup_code(p_code TEXT) RETURNS BOOLEAN` (`SECURITY DEFINER`, `auth.uid()`) : cherche parmi les codes non utilisés de l'utilisateur celui dont le hash correspond à `p_code` (boucle sur les ~10 lignes, `crypt(p_code, code_hash) = code_hash`). Si trouvé : marque ce code `used_at = NOW()`, supprime TOUTES les lignes `auth.mfa_factors` de cet utilisateur (désactive complètement la 2FA), renvoie `TRUE`. Sinon `FALSE`.
- `clear_mfa_backup_codes() RETURNS VOID` (`SECURITY DEFINER`, `auth.uid()`) : supprime toutes les lignes de `mfa_backup_codes` pour l'utilisateur courant — appelée après une désactivation volontaire (section 1) pour ne pas laisser traîner des codes désormais inutiles.

## Erreurs et cas limites

- Code TOTP invalide/expiré à l'activation ou à la connexion : message d'erreur, aucun état modifié, l'utilisateur peut réessayer.
- Code de secours invalide ou déjà utilisé : `redeem_mfa_backup_code` renvoie `false`, aucun effet de bord.
- Perte de connexion réseau pendant l'activation après le scan du QR code mais avant la validation du code à 6 chiffres : le facteur reste en attente côté Supabase (non vérifié) — `listFactors()` permettra de le retrouver/réessayer sans recommencer l'enrôlement depuis zéro (comportement natif Supabase, rien à construire).
- Un utilisateur qui active la 2FA sur un appareil partagé (rappelé par CLAUDE.md comme un cas fréquent dans cette app familiale) : hors de portée de ce design de décider si c'est une bonne idée produit — la fonctionnalité reste disponible pour tous, c'est un choix utilisateur assumé, pas un gate spécifique par device.

## Tests

Pas de nouvelle fonction pure à extraire vers `core.js` pour l'essentiel du flux (appels directs à l'API Supabase + UI). La génération/validation de codes de secours pourrait en théorie être testée unitairement côté SQL, mais ce repo n'a pas d'infrastructure de test SQL existante — vérification manuelle uniquement, comme pour les fonctionnalités Supabase précédentes de cette session.

Vérification manuelle obligatoire (pas d'outil navigateur dans cet environnement) : activer la 2FA sur un compte de test, scanner le QR code avec une vraie appli d'authentification, confirmer que la connexion suivante demande bien le code ; noter un code de secours, se déconnecter, l'utiliser à la place du code TOTP, confirmer que la connexion réussit ET que la 2FA est désormais désactivée sur ce compte ; confirmer qu'un enfant/observateur peut aussi activer la 2FA sur son propre compte.
