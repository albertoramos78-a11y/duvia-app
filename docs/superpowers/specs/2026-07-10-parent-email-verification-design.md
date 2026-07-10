# Vérification email des parents — Design

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

### 1. Confirmation email : mécanisme natif Supabase, pas de nouvelle table

`linkAccount()` (`App.jsx:2048-2073`), qui fait le `supabase.auth.signUp()` pour tout nouveau compte, est le point d'entrée commun aux deux cas (parent 1 créateur, parent 2 rejoignant) — les deux passent par cette même fonction. On y ajoute, uniquement quand `metadata?.role === "parent"` :
- `emailRedirectTo` dans les options du `signUp()`, pointant vers `APP_URL`.
- Un appel explicite à `supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: APP_URL } })` juste après le `signUp()` réussi, pour garantir l'envoi de l'email de confirmation quel que soit le réglage "Confirm email" du projet (qu'on laisse désactivé globalement, pour ne rien casser côté enfants/observateurs par téléphone).
- Le bloc `if (!data?.session)` existant (lignes 2059-2063, qui force actuellement une connexion immédiate) reste inchangé — on continue à accorder une session tout de suite, on ne bloque QUE l'accès applicatif (section suivante), pas la création du compte Auth lui-même.

**Cas du parent 2 qui a déjà un compte existant** (créé seul ou avec une autre famille, per la description de l'utilisateur) : aucune nouvelle vérification n'est nécessaire — son email a déjà été confirmé lors de la création initiale de son compte, `email_confirmed_at` est déjà rempli, il passe directement.

### 2. Écran bloquant : nouveau early-return dans `App()`, sur le modèle de `pendingApproval`

`App()` (`App.jsx:2908`) a déjà une chaîne de `if(...) return (...)` pour des états plein-écran bloquants (`familySync.removedObserver` à la ligne 4182, `familySync.pendingApproval` à la ligne 4198). On y ajoute un nouveau bloc, **avant** le check `pendingApproval`, gated sur `user?.role === "parent" && emailConfirmedAt === null` — `null` signifiant explicitement "vérifié, pas confirmé" et non "pas encore vérifié" (voir ci-dessous), pour ne jamais afficher l'écran bloquant en flash pendant le chargement initial.

- Nouvel état `emailConfirmedAt`, initialisé à `undefined` (état "pas encore su" — ne déclenche jamais le blocage), peuplé par un `useEffect` sur `user` qui appelle `supabase.auth.getUser()` et fixe la valeur à `data.user.email_confirmed_at` (une chaîne de date si confirmé, `null` sinon).
- Détection automatique du clic sur le lien : `supabase.auth.onAuthStateChange` écoute l'évènement `USER_UPDATED` et relit `email_confirmed_at` — fonctionne si le lien est cliqué dans le même onglet/session.
- Bouton "J'ai vérifié, actualiser" en repli manuel (relit `getUser()`), pour le cas où le lien est cliqué sur un autre appareil/onglet.
- Bouton "Renvoyer l'email" (rappelle `resend()`) — les limites de fréquence sont déjà gérées côté serveur par Supabase, pas besoin de throttling maison.
- Même gabarit visuel que les écrans voisins (`minHeight:"100vh"`, carte centrée, icône, titre, texte, boutons).

Priorité d'affichage : la vérification email passe AVANT l'écran "en attente d'approbation" — un parent doit prouver son email avant même que sa demande d'adhésion soit examinée par le créateur.

### 3. Restreindre `ParentInviteShareBtns` à l'email uniquement

`ParentInviteShareBtns` (`App.jsx:8259-8322`) retire les boutons/fonctions SMS (`handleSMS`, 8271-8274) et WhatsApp (`handleWhatsApp`, 8276-8279) ainsi que leurs boutons (8297-8304) — seul `handleEmail`/le bouton Email reste. Le message d'aide sur le numéro de téléphone manquant (8310-8319, dupliqué deux fois dans le code actuel — nettoyé au passage puisqu'on y touche) est retiré aussi, puisqu'il n'est plus pertinent sans les canaux SMS/WhatsApp.

### 4. Fermer la faille du parcours legacy

Le bloc `else if(isParentInvite && obsInviteCode.family)` (`App.jsx:5603-5624`) est supprimé — il appelait `familySync.joinFamily()` (partagée avec le parcours "code de partage", qu'on ne touche pas) et activait le 2e parent immédiatement (`inviteStatus:"accepted"`), sans passage par la validation du créateur. Toutes les invitations parent utilisent déjà le format moderne à token (`newStyle`) ; ce chemin ne sert plus qu'à d'éventuels très anciens liens. À la place, si `isParentInvite` est vrai mais qu'il ne s'agit pas d'un lien `newStyle`, afficher un message d'erreur invitant à demander un nouveau lien (nouvelle clé i18n) plutôt que de laisser le compte Auth créé sans famille associée.

## Portée

Inclus : les 4 points ci-dessus, nouvelles clés i18n (écran de vérification, bouton renvoyer, message de lien obsolète) dans les 5 langues.

Hors périmètre : vérification par téléphone/SMS (nécessiterait un fournisseur SMS payant, non intégré aujourd'hui) ; toute modification du parcours "code de partage" (`joinFamily()`/`FamilySyncCard`) ou de son modèle de statut ; enfants et observateurs (aucun changement, email et téléphone restent tous deux valables, tous canaux d'invitation conservés) ; personnalisation du template d'email Supabase (utilise le template natif tel quel, personnalisation graphique dans le dashboard Supabase possible plus tard mais pas dans ce chantier).
