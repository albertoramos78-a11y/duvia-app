# Notification email pour les nouveaux avis — design

**Date :** 2026-07-13
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Backlog item 17c. Depuis que les bug reports envoient un email de notification ([2026-07-12-bug-report-email-notification-design.md](2026-07-12-bug-report-email-notification-design.md)), l'utilisateur veut le même mécanisme pour la fonctionnalité "Donner mon avis" (`RatingTab`, `App.jsx:11939`) — être notifié par email dès qu'un nouvel avis est laissé, sans avoir à aller vérifier la table `ratings` dans Supabase.

## Contexte technique

- Table `ratings` (créée directement dans le dashboard Supabase, pas de fichier de migration dans ce repo — même situation que `family_members`) : colonnes `family_id`, `user_id` (unique, upsert dessus), `stars`, `comment`, `user_name`, `plan`.
- Un utilisateur ne peut avoir qu'un seul avis — `RatingTab.handleSubmit()` fait un `upsert(..., {onConflict:"user_id"})`. Le bouton "Mettre à jour mon avis" permet de modifier l'avis existant.
- Décidé pendant le brainstorm : notifier **uniquement les nouveaux avis**, pas les modifications — plus simple, et évite une rafale d'emails si quelqu'un retouche son avis plusieurs fois.

## Approche retenue

Même pattern que `notify-bug-report`, qui a déjà fait ses preuves : un **Database Webhook Supabase sur INSERT** dans `ratings` (configuré dans le dashboard, pas dans ce repo) déclenche une nouvelle Edge Function `notify-rating`. Comme c'est une fonction **toute neuve** (pas une modification d'une fonction existante), la mise en garde de CLAUDE.md sur la dérive dashboard/dépôt ne s'applique pas ici — elle peut être écrite directement sans avoir à faire coller un contenu live au préalable.

Un webhook INSERT-only répond exactement à la décision "nouveaux avis seulement" : un `upsert` sur une ligne existante déclenche un évènement `UPDATE`, pas `INSERT` — donc les modifications d'avis ne déclenchent jamais cette fonction, sans code supplémentaire pour les filtrer.

## Contenu de l'email

- **Destinataire** : `duvia.services@gmail.com` (même adresse que les bug reports).
- **Sujet** : `⭐ Nouvel avis sur Duvia (4/5)` (nombre d'étoiles inclus).
- **Corps** : note affichée en étoiles pleines/vides (★★★★☆), commentaire (échappé HTML — texte libre saisi par l'utilisateur, même précaution que `notify-bug-report`'s `escapeHtml()`), nom public (`user_name`), plan (`plan` : freemium/trial_premium/premium/earned_premium).
- Même charte visuelle que l'email bug report (dégradé violet→bleu en en-tête, carte blanche, mise en page Resend HTML).

## Sécurité

- Vérification par secret partagé en en-tête `x-webhook-secret`, comparé à une variable d'environnement `RATING_WEBHOOK_SECRET` — même mécanisme que `BUG_REPORT_WEBHOOK_SECRET`, empêche quiconque connaissant l'URL de la fonction de déclencher de faux emails.
- `comment` et `user_name` passés par `escapeHtml()` avant interpolation dans le HTML de l'email (texte libre utilisateur).

## Non-objectifs

- Pas de notification sur les modifications d'avis (décidé explicitement).
- Ne touche à aucune fonction Edge existante.
- Pas de changement client (`App.jsx`) — `RatingTab` continue d'écrire dans `ratings` exactement comme avant, il ignore totalement l'existence de cette notification.

## Déploiement (manuel, hors repo)

Comme pour `notify-bug-report` : création de la fonction dans le dashboard Supabase (coller le code), configuration du secret `RATING_WEBHOOK_SECRET` + `RESEND_API_KEY` (déjà existant, réutilisé), puis création du Database Webhook (Database → Webhooks, INSERT sur `ratings`, en-tête `x-webhook-secret`). Étapes détaillées dans le plan d'implémentation.

## Test / vérification

- Aucun test automatisé possible (`node --test` ne couvre pas les Edge Functions) — vérification live par l'utilisateur : laisser un nouvel avis sur `app.duvia.fr`, confirmer la réception de l'email avec les bonnes étoiles/commentaire/nom/plan. Puis modifier cet avis et confirmer qu'aucun second email n'arrive.
