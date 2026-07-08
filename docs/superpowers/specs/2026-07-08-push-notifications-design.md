# Notifications push (vraies, arrière-plan)

## Contexte

Aujourd'hui, Duvia n'a **aucune vraie notification push**. Ce qui existe (`App.jsx:3743-3786`, `App.jsx:16779-16782`) est l'API `Notification` du navigateur, déclenchée côté client par le code Realtime (nouveau message, action sur une dépense, document coffre-fort) — ça ne fonctionne que si l'onglet/l'app est ouvert et actif, et repose sur `Notification.requestPermission()` appelé automatiquement au montage (`App.jsx:3731`), sans geste utilisateur. Les navigateurs récents bloquent de plus en plus ce genre de prompt non déclenché par un clic, ce qui explique probablement la perception que "ça ne marche plus".

Le service worker (`public/sw.js`) sert uniquement à rendre l'app installable (PWA) — pas de handler `push`, pas de clé VAPID, pas de table d'abonnements, pas de fonction serveur d'envoi.

Ce document couvre la mise en place de vraies notifications push web (Web Push API), qui arrivent même app fermée / téléphone verrouillé.

## Portée

**Inclus (ce chantier) :**
- Infrastructure push complète (VAPID, abonnements, service worker, envoi serveur).
- 4 types d'événements : nouveau message, dépense (ajoutée/confirmée/refusée), demande observateur/enfant à valider, document ajouté au coffre-fort.
- Préférences granulaires par type d'événement, séparément pour push et email.

**Explicitement hors scope (chantier séparé, futur spec) :**
- Rappel "changement de garde 24h avant". Le planning de garde n'est calculé que côté client aujourd'hui à partir du blob `cfg` (règles de rotation, dates spéciales, jours fériés) ; les tables `custody_*` sont en écriture fantôme seulement (`useCustody.ts`, Phase 3, pas encore lues). Un job planifié côté serveur ne peut pas savoir "dans 24h ça change" sans qu'on lui donne cette info via un nouveau mécanisme (le client écrit la prochaine date de changement dans une table, un job planifié la lit). Réutilisera l'infra construite ici (abonnements, envoi) une fois ce mécanisme conçu séparément.

## Architecture

### VAPID & abonnements

Une paire de clés VAPID générée une fois. La clé privée + `VAPID_SUBJECT` (`mailto:...`) deviennent des secrets Edge Function (même mécanisme que `RESEND_API_KEY`/`WEBHOOK_SECRET` existants pour `notify-expense`). La clé publique est exposée au client via `VITE_VAPID_PUBLIC_KEY`.

Nouvelle table `push_subscriptions` :

| colonne | type | note |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid | `references auth.users` |
| `endpoint` | text | unique |
| `p256dh` | text | clé publique de chiffrement de l'abonnement |
| `auth_key` | text | secret d'authentification de l'abonnement |
| `user_agent` | text, nullable | pour affichage "Activé sur : Chrome / iPhone" côté préférences |
| `created_at` | timestamptz | default `now()` |

RLS : un utilisateur ne voit/insère/supprime que ses propres lignes (`user_id = auth.uid()`). Un même utilisateur peut avoir plusieurs lignes (un par appareil) — tous reçoivent le push.

### Service worker (`public/sw.js`)

Deux nouveaux handlers, en plus de l'existant (qui ne change pas) :
- `push` : parse le payload JSON (`{title, body, tag, url}`), vérifie via `clients.matchAll({includeUncontrolled:true})` si un client déjà au premier plan affiche déjà le contenu concerné (voir "Anti-doublon" ci-dessous) — sinon `self.registration.showNotification(title, {body, tag, data:{url}})`.
- `notificationclick` : ferme la notification, focus un client existant sur `url` s'il y en a un, sinon ouvre une nouvelle fenêtre.

### Envoi (Edge Functions)

Même schéma que `notify-expense` existant : un Database Webhook Supabase se déclenche sur INSERT dans la table concernée → une Edge Function récupère les destinataires (tous les membres actifs de la famille sauf l'auteur de l'action), vérifie la préférence `push_*`/`email_*` de chacun (`user_metadata`, modèle opt-out `!== false`, identique à l'existant), puis :
- **Push** : envoie via un helper partagé `supabase/functions/_shared/push.ts` (lib `web-push` en Deno, signature VAPID) à toutes les lignes `push_subscriptions` du destinataire. Une réponse 404/410 d'un endpoint entraîne la suppression immédiate de la ligne correspondante (abonnement mort/désinstallé) — pas de job de nettoyage séparé. Un échec sur un appareil n'empêche pas l'envoi aux autres appareils du même utilisateur.
- **Email** : logique déjà existante pour dépenses (`notify-expense`), reprise à l'identique pour les 3 nouveaux types.

Fonctions concernées :
- `notify-expense` (existante) — étendue pour ajouter l'envoi push, en plus de l'email déjà en place.
- `notify-message` (nouvelle) — déclenchée sur INSERT `messages`.
- `notify-join-request` (nouvelle) — déclenchée sur INSERT `family_members` en statut pending (ou table d'invitation équivalente selon ce que confirmera l'exploration en phase de plan). Ajoute aussi l'email pour ce type, qui n'existe pas aujourd'hui.
- `notify-vault-document` (nouvelle) — déclenchée sur INSERT `vault_documents`.

Contenu du payload push : reste au même niveau d'exposition que les popups in-app actuelles (titre + aperçu court), pas de nouvelle donnée sensible affichée en clair.

### Anti-doublon avec les notifications foreground existantes

Le code ad-hoc actuel (`App.jsx:3743-3786`, `16779-16782`) qui appelle `Notification`/`reg.showNotification` côté client quand l'app est ouverte est **retiré** pour les 4 types désormais couverts par le vrai push (message, dépense, demande observateur/enfant, document coffre-fort) — sinon un même événement déclencherait deux notifications OS (une via le code client existant, une via le `push` reçu par le service worker). Le service worker devient la seule source de la notification OS pour ces 4 types, avec suppression si l'utilisateur a déjà l'onglet/la vue concernée au premier plan.

Les autres types de `pushNotif` in-app (confirmation de garde, remboursement, suppression de membre, etc.) ne sont pas concernés par ce chantier et gardent leur comportement actuel (popup in-app uniquement, pas de notification OS, pas de push).

## UX côté client

### Activation

Un bouton explicite dans Préférences : **"🔔 Activer les notifications push sur cet appareil"**, remplaçant l'appel automatique `requestPermission()` au montage (supprimé). Le clic appelle directement `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`, qui gère lui-même le prompt de permission dans le contexte du geste utilisateur. Une fois abonné, le bouton devient un état "✅ Activé sur cet appareil" avec option de désactivation (supprime l'abonnement navigateur + la ligne `push_subscriptions`).

### Cas iOS

Si l'appareil est un iPhone et que l'app n'est pas ouverte en mode "ajoutée à l'écran d'accueil" (`window.matchMedia('(display-mode: standalone)').matches` / `navigator.standalone`), le push est techniquement impossible depuis Safari — le bouton est remplacé par une instruction : *"Ajoute Duvia à ton écran d'accueil pour activer les notifications push."*

### Permission refusée

Si `Notification.permission === "denied"` (bloqué précédemment), affichage d'un message expliquant qu'il faut réactiver manuellement dans les réglages du navigateur (impossible de re-demander par code une fois refusé).

### Préférences par type

La section "📧 Notifications email" actuelle (`App.jsx` ~6632-6641 pour les parents, ~6960-6970 pour les observateurs) devient une section "🔔 Notifications" où chaque ligne d'événement affiche deux cases côte à côte (📧 email / 🔔 push) au lieu d'une seule :
- Parents : messages, dépenses, coffre-fort (existants, case push ajoutée) + demande observateur/enfant (nouveau, case email ET push ajoutées).
- Observateurs/enfants : mêmes types qu'aujourd'hui (actuellement messages uniquement), case push ajoutée à côté de la case email existante.

Chaque préférence par défaut activée (`!== false`, cohérent avec le modèle opt-out déjà en place pour l'email) — mais tant que l'appareil n'est pas abonné (bouton d'activation ci-dessus), aucun push ne part de toute façon : la fonction serveur ne trouve simplement aucune ligne `push_subscriptions` active pour ce user.

## Déploiement

1. Migration `push_subscriptions` + policies RLS.
2. Génération de la paire de clés VAPID, secrets ajoutés dans le dashboard Supabase (étape manuelle guidée).
3. Déploiement des 4 Edge Functions (inertes tant qu'aucun Database Webhook n'y pointe).
4. Branchement des Database Webhooks un par un (messages → test → demandes → test → coffre-fort → test → dépenses), chacun vérifié avant de passer au suivant. Pas de bascule globale d'un coup sur un système qui touche de la prod avec de vrais utilisateurs.
5. Déploiement du build client (service worker, UI d'activation, préférences) — peut être livré avant ou après les étapes serveur puisque le bouton d'activation est inoffensif tant qu'aucun événement ne déclenche encore d'envoi côté serveur.

## Tests

Logique pure additionnelle (ex. construction du texte de la notif, si extraite en fonction indépendante) va dans `core.js`/`core.test.js`, suivant la convention du projet. Le reste (Edge Functions, Service Worker, Push API navigateur) n'est pas unit-testable de façon significative dans ce repo — validation manuelle : abonner un appareil, déclencher chacun des 4 événements, vérifier réception app fermée, vérifier absence de doublon app ouverte, vérifier qu'un type désactivé ne notifie plus (push et email indépendamment), vérifier le cas iOS non-standalone.

## Hors scope (explicitement)

- Rappel de changement de garde 24h avant (voir "Portée" ci-dessus — chantier séparé).
- Notifications push pour les autres types d'événements existants (confirmation de garde, remboursement, suppression de membre, etc.) — restent in-app uniquement.
- Pas de centre de notifications unifié ni d'historique des push envoyés — le comportement reste "fire and forget", comme l'email existant.
