# Envoi automatique réel d'emails d'invitation — design

**Date :** 2026-07-19
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Backlog (item 9 de la liste réordonnée du 2026-07-18). Aujourd'hui, "envoyer" une invitation (famille : parent/observateur/enfant, ou parrainage) ouvre le client mail (`mailto:`) ou l'app SMS (`sms:`) de l'utilisateur avec le message pré-rempli — il doit ensuite cliquer lui-même sur "Envoyer" dans son propre client. Sur mobile sans client mail configuré (cas fréquent), ce bouton ne fait littéralement rien de visible. L'utilisateur veut un vrai envoi serveur, pour les invitations famille **et** le parrainage (portée élargie décidée par l'utilisateur dans une session précédente, confirmée à nouveau pendant ce brainstorm).

## Contexte technique

- **Invitations parent/observateur/enfant** : le champ email destinataire existe déjà dans chaque formulaire (`inviteEmail` pour parent, `email` dans `StepAccess` pour observateur, `childEmail` pour enfant) — seul le bouton "Email" doit changer de comportement.
- **Parrainage** (`ParrainageSection`, `App.jsx:~15085`) : aucun champ email destinataire n'existe aujourd'hui — le lien est générique (`shareViaEmail()` ouvre un `mailto:` vide, l'utilisateur tape l'adresse lui-même). Il faut ajouter ce champ.
- Les messages actuels sont soit codés en dur en français (parent/observateur/enfant — jamais passés par `t.xxx`, contrairement à la convention habituelle de ce projet), soit déjà traduits en 5 langues pour le parrainage (`t.refShareEmailSubject`/`t.refShareEmailBody`, placeholder `{link}`).
- Deux Edge Functions existantes envoient déjà des emails via Resend (`notify-bug-report`, `notify-rating`) — mais toutes deux sont déclenchées **passivement** par un Database Webhook Supabase sur INSERT, jamais par un appel direct du client. Ici, le déclencheur est un clic utilisateur authentifié — la garantie anti-abus doit donc être différente (pas juste un secret partagé, un vrai comptage de fréquence côté serveur).
- `RESEND_API_KEY` est déjà un secret partagé au niveau du projet Supabase (utilisé par les 2 fonctions ci-dessus) — réutilisable directement, pas de nouveau compte/fournisseur à configurer.

## Approche retenue

### Une seule nouvelle Edge Function : `send-invite-email`

Contrairement à `notify-bug-report`/`notify-rating` (tout le contenu de l'email est fixe, écrit en dur côté serveur, jamais localisé car destiné à l'admin), le destinataire ici est un vrai utilisateur/invité potentiellement non-francophone. Plutôt que de dupliquer les 5 langues à l'intérieur de la fonction Deno (qui ne peut pas importer `src/i18n/*.js`, un module React côté client), **le client construit le sujet et le corps du message exactement comme il le fait déjà aujourd'hui pour le `mailto:`** (avec `t.xxx`, dans la langue actuelle de l'expéditeur), et les transmet tels quels à la fonction. Celle-ci se contente de :

1. Authentifier l'appelant (vérifie le JWT via l'en-tête `Authorization`, comme `admin-manage-subscriptions`) — pas de vérification de rôle admin ici, n'importe quel compte connecté peut envoyer SES PROPRES invitations.
2. Valider le format de l'email destinataire (re-vérifié côté serveur, pas seulement côté client).
3. Vérifier les limites anti-abus (voir ci-dessous) via une nouvelle table `invite_email_log`.
4. Échapper le texte libre (`subject`/`body`, déjà du texte généré par l'app mais qui peut contenir un prénom d'enfant/parent saisi librement) puis l'envelopper dans le même habillage visuel que les 2 emails existants (dégradé violet→bleu, carte blanche, pied de page).
5. Envoyer via Resend, puis enregistrer la ligne dans `invite_email_log`.

Ce choix évite de dupliquer la logique de traduction et garde la fonction Edge "bête" (un simple wrapper HTML + anti-abus + envoi), tout en gardant l'app comme unique source de vérité pour les textes.

### Nouvelle table `invite_email_log` (migration `0042`, committée proprement cette fois)

```sql
create table invite_email_log (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null,
  invite_type text not null check (invite_type in ('parent','observer','child','referral')),
  sent_at timestamptz not null default now()
);
create index idx_invite_email_log_sender_sent on invite_email_log(sender_user_id, sent_at);
create index idx_invite_email_log_recipient_sent on invite_email_log(lower(recipient_email), sent_at);
alter table invite_email_log enable row level security;
-- Aucune policy créée : ni lecture ni écriture pour un client normal (authenticated/anon).
-- Seule la Edge Function (service role, qui bypass RLS) lit/écrit cette table.
```

### Anti-abus (décidé pendant le brainstorm)

- **Plafond global** : 10 envois par compte (`sender_user_id`) par 24h glissantes, tous types confondus.
- **Plafond par destinataire** : 3 envois vers la même adresse (insensible à la casse) par 7 jours glissants, tous types confondus — empêche le harcèlement d'une même personne même si l'expéditeur change de type d'invitation entre chaque essai.
- Les deux vérifiés par une requête `count` sur `invite_email_log` avant l'envoi ; dépassement → réponse `429` avec un code d'erreur explicite (`daily_limit_reached` / `recipient_limit_reached`), affiché à l'utilisateur avec un message clair plutôt qu'une erreur générique.

## Contenu des emails

Même charte visuelle que les 2 emails existants (voir `notify-rating` pour référence). Sujet et corps fournis par le client, donc déjà dans la langue de l'expéditeur. Nouvelles clés i18n à ajouter (les 5 langues), remplaçant les chaînes actuellement codées en dur :

- `parentInviteEmailSubject` / `parentInviteEmailBody` (placeholder `{link}`)
- `childInviteEmailSubject` / `childInviteEmailBody` (placeholders `{childName}`, `{link}`)
- `observerInviteEmailSubject` / `observerInviteEmailBody` (placeholders `{parentName}`, `{link}`)
- `t.refShareEmailSubject` / `t.refShareEmailBody` déjà existantes, réutilisées telles quelles pour le parrainage.

Plus des clés génériques d'état pour les 4 boutons (envoi en cours / succès / erreurs) : `inviteEmailSending`, `inviteEmailSent`, `inviteEmailErrorGeneric`, `inviteEmailErrorDailyLimit`, `inviteEmailErrorRecipientLimit`.

## Changements client

- **`ParentInviteShareBtns`** (`App.jsx:~9733`) : `handleEmail()` devient asynchrone, appelle `send-invite-email` (`type:"parent"`) au lieu d'ouvrir `mailto:`. États de chargement/succès/erreur ajoutés (comme le pattern `genLoading`/`genErr` déjà utilisé ailleurs dans ce fichier pour la génération de lien).
- **`ChildInviteBtn`** (`App.jsx:~9835`) : `handleEmail()` idem (`type:"child"`).
- **`StepAccess`** (observateur, `App.jsx:~11289`) : `handleSendEmail()` idem (`type:"observer"`).
- **`ParrainageSection`** (`App.jsx:~15085`) : nouveau champ email + bouton "Envoyer" sous le lien de parrainage existant (qui reste copiable/partageable comme avant, inchangé). Nouveau state local (email destinataire, sending/sent/err).
- **Boutons SMS/WhatsApp/copier** : inchangés partout — un vrai envoi de SMS nécessiterait un fournisseur dédié séparé (Twilio ou équivalent), hors scope ici.

## Sécurité

- Email destinataire re-validé côté serveur (regex simple), pas seulement côté client.
- `subject`/`body` échappés HTML avant interpolation dans le template (même précaution que `notify-bug-report`/`notify-rating` — texte généré par l'app mais contenant potentiellement un prénom saisi librement par l'utilisateur).
- Appelant authentifié obligatoire (JWT vérifié) — pas de rôle admin requis, chacun envoie ses propres invitations.
- Anti-abus appliqué AVANT l'appel Resend (pas juste après), pour ne jamais dépasser les plafonds même en cas de doubles-clics/retries.

## Non-objectifs

- Pas d'envoi de vrais SMS (reste `sms:`/WhatsApp comme aujourd'hui).
- Ne touche à aucune Edge Function existante (nouvelle fonction dédiée).
- Ne change pas la génération des liens d'invitation eux-mêmes (RPCs `create_child_invitation`/`create_observer_invitation`/etc. inchangées) — uniquement la façon de les transmettre par email.

## Déploiement (manuel, hors repo)

Comme pour `notify-rating` : création de la fonction dans le dashboard Supabase (coller le code), configuration de `RESEND_API_KEY` (déjà existant, partagé) — pas de secret webhook nécessaire ici puisque ce n'est pas un Database Webhook, juste une fonction invoquée directement avec le JWT de l'utilisateur. La migration `0042` doit être exécutée dans l'éditeur SQL Supabase avant le déploiement du code client qui en dépend.

## Test / vérification

- Tests unitaires possibles pour toute logique pure extraite (ex: une fonction de validation d'email si mutualisée, déjà couverte par `isValidEmail` existant dans `core.js`).
- Aucun test automatisé possible pour l'envoi réel (Edge Function + Resend) — vérification live par l'utilisateur : envoyer une invitation de chaque type (parent/observateur/enfant/parrainage) vers une vraie adresse, confirmer la réception avec le bon contenu. Tester aussi le dépassement de plafond (envoyer 4 fois vers la même adresse en moins de 7 jours → la 4e doit être refusée avec un message clair).
