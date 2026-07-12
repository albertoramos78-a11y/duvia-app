# Notification email à chaque signalement de bug — design

**Date :** 2026-07-12
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Quand un utilisateur clique "Signaler un problème" dans l'app (`BugReportModal`, `App.jsx:2913`), `submitBugReport()` (`src/services/diagnostics.js:158`) insère un rapport structuré dans la table Supabase `bug_reports` (commentaire, version de l'app, infos système, logs récents, éventuellement une capture d'écran). Personne n'est prévenu : il faut ouvrir le tableau Supabase pour découvrir un nouveau rapport. L'utilisateur veut recevoir un email à `duvia.services@gmail.com` dès qu'un rapport arrive.

Note (constatée en explorant le code, sans rapport avec la suite du design) : `bug_reports` n'a pas de fichier de migration dans ce dépôt — la table a été créée directement dans le tableau de bord Supabase, comme les tables `custody_*` déjà documentées dans `CLAUDE.md` ("Not yet done"). Pas un bloquant pour cette fonctionnalité, juste noté pour cohérence.

## Design retenu

### 1. Nouvelle fonction Edge `notify-bug-report`

Reprend exactement le modèle déjà utilisé par les 6 fonctions email existantes (`notify-expense`, `notify-message`, `notify-vault`, `notify-new-device-login`, `notify-password-change`, `send-parent-verification-email`) — Resend, `Deno.serve`, mêmes en-têtes CORS.

Contenu de l'email (déterminé par le choix utilisateur "rapport complet") :
- Commentaire écrit par l'utilisateur (`comment`)
- Version de l'app (`app_version`)
- Plateforme/navigateur/OS (`system.platform`, `system.userAgent`)
- `user_id` / `family_id` si présents (sinon "non connecté" / "aucune famille")
- L'identifiant du rapport (`id`), pour le retrouver dans le tableau Supabase

Volontairement **absents de l'email** : la capture d'écran et les tableaux `logs`/`errors` bruts — trop volumineux et peu lisibles par email ; consultables directement dans la ligne Supabase via l'identifiant fourni.

Destinataire fixe : `duvia.services@gmail.com` (constante dans le code, comme `FROM_EMAIL`/`APP_URL` dans les fonctions existantes).

### 2. Déclenchement : Database Webhook Supabase

Contrairement aux 6 fonctions existantes (appelées côté client juste après l'action), celle-ci est déclenchée **côté serveur** par un Database Webhook Supabase configuré dans le tableau de bord (Database → Webhooks) : "INSERT sur `bug_reports` → HTTP POST vers cette fonction". Aucune ligne de code React à ajouter — `App.jsx` n'est pas modifié.

Pourquoi cette différence assumée par rapport au reste du code : un webhook déclenché par la base de données part même si l'onglet du navigateur se ferme juste après l'envoi du rapport (contrairement à un appel client qui dépend du JS encore actif), et ne peut pas être déclenché sans qu'une vraie ligne existe dans `bug_reports`.

Le payload envoyé par un Database Webhook Supabase a la forme :
```json
{ "type": "INSERT", "table": "bug_reports", "schema": "public", "record": { ...la ligne insérée... }, "old_record": null }
```
La fonction lit `payload.record` pour construire l'email.

**Sécurité :** un Database Webhook Supabase permet d'ajouter un en-tête HTTP personnalisé lors de sa création dans le tableau de bord. On y met un secret aléatoire (ex: `x-webhook-secret: <valeur>`), stocké aussi comme variable d'environnement de la fonction (`BUG_REPORT_WEBHOOK_SECRET`). La fonction rejette (401) toute requête dont l'en-tête ne correspond pas — sans ça, n'importe qui connaissant l'URL de la fonction pourrait déclencher l'envoi d'un faux email.

### 3. Pas de changement client, pas de bump de version

Aucun fichier sous `src/` n'est modifié. Pas de bump `APP_VERSION`/`SW_VERSION` nécessaire (règle de `CLAUDE.md` : seulement pour du code app qui atteint les utilisateurs — ici uniquement une fonction Edge + une config de webhook, tous deux côté serveur).

## Mise en place (manuelle, après écriture du code)

1. Coller le code de `notify-bug-report` dans le tableau de bord Supabase (Edge Functions → New function), comme pour les fonctions précédentes.
2. Vérifier que `RESEND_API_KEY` est déjà configuré comme secret de la fonction (déjà utilisé par les fonctions existantes — normalement partagé au niveau du projet, à confirmer).
3. Générer une valeur aléatoire pour `BUG_REPORT_WEBHOOK_SECRET`, l'ajouter comme secret de la fonction.
4. Créer le Database Webhook (Database → Webhooks → Create a new webhook) : table `bug_reports`, event `Insert`, type `HTTP Request` vers l'URL de la fonction déployée, avec l'en-tête `x-webhook-secret` réglé sur la même valeur qu'à l'étape 3.

Ces étapes manuelles seront guidées une par une au moment de l'implémentation, comme pour les fonctionnalités précédentes de cette session.

## Test / vérification

Aucun test automatisé possible ici (fonction Edge + webhook, tous deux hors du dépôt testé par `npm test`). Vérification uniquement en direct : soumettre un vrai rapport de bug depuis l'app ("Signaler un problème") et confirmer la réception de l'email à `duvia.services@gmail.com`, avec les bonnes informations dedans.

## Documentation

Ajouter `notify-bug-report` à la liste des Edge Functions dans `CLAUDE.md` une fois déployée. Le Database Webhook (comme le `pg_cron` de `expire_stale_family_data()`) ne sera pas capturé dans un fichier de migration — configuration tableau de bord uniquement, à noter dans `CLAUDE.md`.

## Non-objectifs

- Ne touche pas au formulaire `BugReportModal` ni à `submitBugReport()`.
- Ne crée pas de migration pour la table `bug_reports` elle-même (hors sujet de cette fonctionnalité).
- Pas de limitation de fréquence (throttling) — le rapport de bug est un geste explicite de l'utilisateur (bouton + commentaire), pas un risque de spam automatique.
