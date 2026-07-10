# Emails transactionnels de sécurité — Design

**Statut :** approuvé, prêt pour planification.
**Backlog :** item 3 ("Set up automated transactional emails").

## Contexte

Le backlog demandait 4 notifications : mot de passe changé, nouvel appareil,
email changé, nouvelle dépense/message/document coffre-fort. Les
notifications de dépense/message/document existent déjà (feature push
notifications shippée plus tôt cette session, `notify-expense`/
`notify-message`/`notify-vault`/`notify-join-request`) — hors scope ici.

Investigation préalable au brainstorm (2026-07-10) :
- **Mot de passe changé** : déjà câblé côté client (`changePassword()`
  appelle `supabase.functions.invoke("notify-password-change", ...)`,
  App.jsx, dans les deux copies de l'écran Préférences), et la fonction
  existe déjà en prod — mais son code n'a **jamais été commité** dans ce
  repo (dette documentée dans CLAUDE.md, section "Not yet done").
- **Email changé** : `changeEmail()` utilise
  `supabase.auth.updateUser({email})`, qui déclenche déjà l'email de
  confirmation natif de Supabase.
- **Nouvel appareil** : rien n'existe. C'est le seul vrai trou
  fonctionnel — l'app ne trace aucune notion d'"appareil connu" nulle
  part.

## Portée

Les 3 volets, mais de tailles très différentes :
1. Nouvel appareil — vraie fonctionnalité à construire.
2. Mot de passe changé — rapatriement de code existant, pas de nouvelle
   fonctionnalité.
3. Email changé — vérification/activation d'un réglage Supabase, pas de
   nouveau code attendu.

## 1. Nouvelle connexion — nouvel appareil

### Détection

Un identifiant d'appareil persistant, généré une fois par navigateur/
appareil et stocké en `localStorage` (clé `duvia_device_id`,
`crypto.randomUUID()`). **Jamais effacé à la déconnexion** — il identifie
l'appareil physique, pas la session du compte. Mêmes limites assumées que
tout mécanisme de ce type dans l'industrie : navigation privée ou cache
vidé réapparaît comme "nouvel appareil" (acceptable).

Alternative écartée : empreinte user-agent + IP — rejetée en amont du
design (IP mobile changeante, foyers partageant une IP, faux
positifs/négatifs fréquents pour une app familiale).

Alternative écartée : stocker la liste des appareils connus dans
`auth.users.raw_user_meta_data` (`user_metadata`) — rejetée explicitement.
C'est exactement la classe de bug qui a cassé la vérification email
parent deux fois le jour même (collision avec des clés auto-gérées par
Supabase, et `user_metadata` mal adapté à des écritures concurrentes
comme un upsert de liste d'appareils). Une vraie table dédiée, comme
`parent_email_verifications`, est le pattern déjà validé dans ce repo.

### Schéma serveur

Nouvelle table `known_devices` :

```sql
CREATE TABLE public.known_devices (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id   TEXT        NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, device_id)
);
```

RLS activée, **aucune policy** (deny-all à `anon`/`authenticated` — accès
uniquement via la RPC ci-dessous), même pattern que
`parent_email_verifications`.

RPC `record_device_login(p_device_id TEXT) RETURNS BOOLEAN` :
- `SECURITY DEFINER`, utilise `auth.uid()` (pas de paramètre user_id à
  faire confiance, comme `is_parent_email_verified()`).
- Upsert manuel (SELECT puis UPDATE ou INSERT, avec un `EXCEPTION WHEN
  unique_violation` en filet de sécurité contre une course entre deux
  connexions simultanées du même tout-nouvel appareil).
- Renvoie `TRUE` uniquement si c'était la première fois pour ce
  `(user_id, device_id)` — c'est ce booléen qui décide si on notifie.

### Déclenchement côté client

Après une connexion réussie dans :
- `doLogin()` (connexion classique) — App.jsx
- `doLoginAndJoin()` (compte existant qui rejoint une famille via lien
  d'invitation) — App.jsx
- le handler `onAuthStateChange` pour Google OAuth — App.jsx

**Pas** dans `doReg()` (inscription) : un compte tout juste créé a
trivialement un appareil "nouveau", alerter juste après l'inscription
serait du bruit, pas un signal de sécurité utile.

Pour chacun de ces 3 points : récupérer/créer le `device_id` local,
appeler `record_device_login(device_id)`. Si la RPC renvoie `true` **et**
que l'email du compte n'est pas synthétique
(`!email.includes("@phone.duvia.app")`, motif déjà utilisé ailleurs dans
App.jsx pour détecter les comptes créés par téléphone), invoquer la
nouvelle Edge Function `notify-new-device-login`. Portée : tout compte
avec un vrai email — parents (toujours email) et enfants/observateurs
s'ils se sont inscrits par email plutôt que par téléphone.

### Edge Function `notify-new-device-login`

Nouvelle fonction, même schéma d'authentification que
`send-parent-verification-email` : extrait le JWT `Authorization: Bearer`,
`admin.auth.getUser(token)`, 403 si `user.id !== payload.user_id` (pas de
confiance aveugle dans le corps de la requête). Corps attendu :
`{ user_id, email, device_info }` où `device_info` est une chaîne courte
dérivée du `navigator.userAgent` côté client (ex. "Chrome sur Windows"),
best-effort, pas de parsing user-agent robuste requis.

Envoie un email via Resend : connexion détectée depuis `device_info`, à
la date/heure du jour, avec un rappel "si ce n'était pas vous, changez
votre mot de passe immédiatement" (lien vers l'écran de changement de mot
de passe si simple à construire, sinon texte seul).

## 2. Mot de passe changé — rapatriement

Pas de nouveau code. Étapes :
1. Demander à l'utilisateur de coller le contenu actuel du dashboard pour
   `notify-password-change` (obligatoire avant toute édition d'Edge
   Function existante, CLAUDE.md).
2. Committer tel quel dans `supabase/functions/notify-password-change/`
   — c'est la première fois que ce code entre dans le repo.
3. Relecture rapide : vérifier qu'il n'y a rien d'évidemment cassé ou
   incohérent avec les patterns établis (auth JWT, Resend). Ne pas
   modifier le comportement sans un signal explicite que quelque chose ne
   va pas — l'objectif ici est de combler la dette de version, pas de
   refactorer une fonction qui marche déjà en prod.

## 3. Email changé — vérification de configuration

Pas de nouveau code attendu. Demander à l'utilisateur de vérifier le
réglage "Secure email change" dans Supabase Dashboard → Authentication →
Settings :
- S'il est désactivé : l'activer (envoie une confirmation à l'ancienne
  **et** la nouvelle adresse — protection standard contre un changement
  d'email par un attaquant qui aurait déjà le mot de passe, empêchant la
  victime de voir l'alerte puisque l'ancienne adresse est aussi notifiée).
- S'il est déjà activé : rien à faire, le comportement actuel de
  `changeEmail()` est déjà correct.

## Erreurs et cas limites

- `notify-new-device-login` échoue (réseau, Resend down) : ne doit
  jamais bloquer la connexion elle-même — appel `.catch(()=>{})` côté
  client, comme le pattern déjà utilisé pour `notify-password-change`.
- `record_device_login` échoue (RPC indisponible) : même chose, ne
  bloque pas la connexion ; on ne notifie simplement pas cette fois.
- Compte avec email synthétique (`@phone.duvia.app`) : jamais notifié,
  géré en amont côté client (pas d'appel à l'Edge Function).
- Utilisateur qui vide son cache/localStorage régulièrement : recevra des
  alertes "nouvel appareil" à répétition pour le même appareil physique.
  Limite assumée, cohérente avec l'approche standard du secteur.

## Tests

- Logique pure testable en Node : aucune ici (tout le nouveau code est
  soit du SQL, soit une Edge Function Deno, soit du câblage client direct
  — pas de nouvelle fonction pure à ajouter à `core.js`).
- Vérification manuelle obligatoire (pas d'outil navigateur/email dans
  cet environnement) : connexion depuis un navigateur jamais vu par ce
  compte → email reçu ; reconnexion depuis le même navigateur → pas de
  second email ; connexion depuis un compte à email synthétique → jamais
  d'email.
