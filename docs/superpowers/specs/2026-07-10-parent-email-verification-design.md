# Vérification email des parents — Design

## Révision (2026-07-10, en cours d'implémentation)

La première version de ce design (section 1 ci-dessous, mécanisme natif Supabase) s'est révélée invalide, confirmé par un test réel : quand le réglage global "Confirm email" du projet Supabase est désactivé (nécessaire pour ne pas casser les comptes enfants/observateurs par téléphone, aucune adresse `@phone.duvia.app` réelle derrière), Supabase remplit `email_confirmed_at` **automatiquement dès l'inscription**, avant même l'envoi d'un quelconque lien — le champ ne peut donc pas servir de signal "a cliqué le lien". La section 1 est remplacée par un mécanisme maison, indépendant de ce champ natif (voir section 1 révisée plus bas). Sections 2, 3, 4 restent valables, section 2 est mise à jour pour refléter la nouvelle source de vérité.

## Contexte

Aujourd'hui, un parent (créateur de famille ou 2e parent rejoignant) crée son compte avec un email + mot de passe, et accède immédiatement à l'application — rien ne prouve que l'email saisi lui appartient réellement. Demande de l'utilisateur (2026-07-10) : garantir que l'email d'un parent est réel et lui appartient, avant qu'il puisse utiliser l'application.

Points déjà vrais dans le code, vérifiés avant de concevoir (pas besoin d'y toucher) :
- L'email est déjà obligatoire pour les parents — aucun chemin d'inscription parent par téléphone n'existe (`App.jsx:5511-5514`, commentaire : *"Les parents restent en email obligatoire"*).
- Le parcours d'invitation moderne (par token) place déjà le 2e parent en statut `pending`, avec un écran d'attente et une validation obligatoire par le créateur via `validateMember()` (`App.jsx:2264-2333`, RPC `validate_family_member`).
- Enfants et observateurs ne sont pas concernés par cette demande — ils continuent à rejoindre par email OU téléphone, tous canaux (email/SMS/WhatsApp), avec validation par un parent déjà en place. Aucun changement pour eux.

Ce qui manque et doit être construit :
1. Une vraie confirmation que l'email saisi est valide et accessible (clic sur un lien reçu par email), bloquante tant qu'elle n'est pas faite.
2. Restreindre l'invitation d'un parent au canal email uniquement (retirer SMS/WhatsApp du composant d'invitation parent).
3. Fermer une faille trouvée en cours de route : un ancien parcours d'invitation parent (pré-token) contourne complètement la validation du créateur.

## Décisions de conception

### 1. Confirmation email — RÉVISÉ : mécanisme maison (token + Resend), indépendant de `email_confirmed_at`

Nouvelle table `parent_email_verifications` (migration), jamais lue/écrite directement par le client (RLS activé, aucune policy — accès uniquement via la RPC et l'Edge Function ci-dessous, qui utilisent la clé de service) :

```sql
CREATE TABLE IF NOT EXISTS public.parent_email_verifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,
  token       TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ
);
```

- **Envoi** : nouvelle Edge Function `send-parent-verification-email` (reçoit `{user_id, email}`, appelée par le client juste après un `signUp()` réussi pour un rôle parent — remplace l'appel à `resend()` de la v1). Génère un token aléatoire, l'insère dans la table (expiration 24h, cohérent avec `family_invitations`), envoie l'email via Resend (même pattern que `notify-expense`/etc.) avec un lien `${APP_URL}/?verify_email=<token>`.
- **Validation** : nouvelle RPC `verify_parent_email(p_token TEXT)` (SECURITY DEFINER, migration — pas une Edge Function, pour éviter le risque de dérive dashboard déjà rencontré deux fois sur ce projet ; cohérent avec le pattern déjà en place pour `accept_family_invitation`). Vérifie que le token existe, n'est pas expiré, n'est pas déjà utilisé ; si valide, marque `verified_at` et met à jour `raw_user_meta_data` du compte (`email_verified: true`) directement en SQL. Le client appelle cette RPC quand il détecte `?verify_email=` dans l'URL au chargement.
- `linkAccount()` (`App.jsx:2048-2073`) : `emailRedirectTo` n'est plus nécessaire (ce n'est plus le flux natif Supabase) ; à la place, après un `signUp()` réussi pour `metadata?.role === "parent"`, appeler `supabase.functions.invoke("send-parent-verification-email", {body:{user_id, email}})`.

**Cas du parent 2 qui a déjà un compte existant** (créé seul ou avec une autre famille) : `raw_user_meta_data.email_verified` est déjà `true` depuis sa première vérification, il passe directement — inchangé par rapport à la v1 du design, juste la source de vérité change.

### 2. Écran bloquant — mis à jour : source de vérité = `user_metadata.email_verified`, pas `email_confirmed_at`

`App()` (`App.jsx:2908`) a déjà une chaîne de `if(...) return (...)` pour des états plein-écran bloquants (`familySync.removedObserver` à la ligne 4182, `familySync.pendingApproval` à la ligne 4198). On y ajoute un nouveau bloc, **avant** le check `pendingApproval`, gated sur `user?.role === "parent" && emailVerified === false` — `false` signifiant explicitement "vérifié, pas confirmé" et non "pas encore vérifié" (voir ci-dessous), pour ne jamais afficher l'écran bloquant en flash pendant le chargement initial.

- Nouvel état `emailVerified`, initialisé à `undefined` (état "pas encore su" — ne déclenche jamais le blocage), peuplé par un `useEffect` sur `user` qui appelle `supabase.auth.getUser()` et fixe la valeur à `!!data.user.user_metadata?.email_verified` (booléen).
- Détection du clic sur le lien : au chargement de l'app, si l'URL contient `?verify_email=<token>`, appeler la RPC `verify_parent_email(token)` ; en cas de succès, refaire `getUser()` pour rafraîchir `emailVerified` à `true` et nettoyer le paramètre d'URL.
- Bouton "J'ai vérifié, actualiser" en repli manuel (relit `getUser()`), pour le cas où le lien est cliqué sur un autre appareil/onglet (où le paramètre d'URL n'est pas présent sur CET onglet).
- Bouton "Renvoyer l'email" (rappelle l'Edge Function `send-parent-verification-email`) — pas de limite de fréquence native ici (contrairement à `resend()` de Supabase) : ajouter un cooldown client simple (griser le bouton 30s après un clic) pour éviter le spam, la table elle-même n'a pas besoin de logique anti-abus plus poussée pour une V1.
- Même gabarit visuel que les écrans voisins (`minHeight:"100vh"`, carte centrée, icône, titre, texte, boutons).

Priorité d'affichage : la vérification email passe AVANT l'écran "en attente d'approbation" — un parent doit prouver son email avant même que sa demande d'adhésion soit examinée par le créateur.

### 3. Restreindre `ParentInviteShareBtns` à l'email uniquement

`ParentInviteShareBtns` (`App.jsx:8259-8322`) retire les boutons/fonctions SMS (`handleSMS`, 8271-8274) et WhatsApp (`handleWhatsApp`, 8276-8279) ainsi que leurs boutons (8297-8304) — seul `handleEmail`/le bouton Email reste. Le message d'aide sur le numéro de téléphone manquant (8310-8319, dupliqué deux fois dans le code actuel — nettoyé au passage puisqu'on y touche) est retiré aussi, puisqu'il n'est plus pertinent sans les canaux SMS/WhatsApp.

### 4. Fermer la faille du parcours legacy

Le bloc `else if(isParentInvite && obsInviteCode.family)` (`App.jsx:5603-5624`) est supprimé — il appelait `familySync.joinFamily()` (partagée avec le parcours "code de partage", qu'on ne touche pas) et activait le 2e parent immédiatement (`inviteStatus:"accepted"`), sans passage par la validation du créateur. Toutes les invitations parent utilisent déjà le format moderne à token (`newStyle`) ; ce chemin ne sert plus qu'à d'éventuels très anciens liens. À la place, si `isParentInvite` est vrai mais qu'il ne s'agit pas d'un lien `newStyle`, afficher un message d'erreur invitant à demander un nouveau lien (nouvelle clé i18n) plutôt que de laisser le compte Auth créé sans famille associée.

## Portée

Inclus : les 4 points ci-dessus, la nouvelle table + RPC (migration SQL), la nouvelle Edge Function d'envoi, nouvelles clés i18n (écran de vérification, bouton renvoyer, message de lien obsolète) dans les 5 langues.

Hors périmètre : vérification par téléphone/SMS (nécessiterait un fournisseur SMS payant, non intégré aujourd'hui) ; toute modification du parcours "code de partage" (`joinFamily()`/`FamilySyncCard`) ou de son modèle de statut ; enfants et observateurs (aucun changement, email et téléphone restent tous deux valables, tous canaux d'invitation conservés) ; template d'email personnalisé au-delà du strict nécessaire (HTML simple façon `notify-expense`, pas de travail graphique poussé) ; job de nettoyage périodique des tokens expirés dans `parent_email_verifications` (la table reste petite, un nettoyage manuel ou différé suffit pour une V1).
