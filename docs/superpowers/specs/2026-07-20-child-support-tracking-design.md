# Suivi de la pension alimentaire — design

**Date :** 2026-07-20
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Backlog item 14 ("pension alimentaire"), le plus gros chantier resté non défini, explicitement mis de côté plusieurs fois cette session en attendant son propre brainstorm. Les parents séparés ont une pension alimentaire mensuelle (montant fixe décidé par jugement/accord, versée par un parent à l'autre) et n'ont aujourd'hui aucun moyen, dans Duvia, de garder une trace fiable de qui a payé quoi et quand — utile en cas de désaccord ou pour fournir un justificatif.

Duvia a déjà un système de dépenses partagées avec remboursements (`expenses`/`reimbursements`, `App.jsx` `ExpTab`) — mais la pension alimentaire est conceptuellement différente : ce n'est pas une dépense partagée à diviser, c'est une obligation fixe à sens unique. Les deux systèmes doivent rester séparés (décision explicite, voir Approche retenue).

## Contexte technique

- `ExpTab` (`App.jsx:13330`) gère déjà dépenses + remboursements dans l'onglet Dépenses. Le remboursement (`Reimbursement`, `expenseService.ts:31`) a déjà exactement la forme dont s'inspire ce design : `from`/`to` (index parent), `amount`, `date`, `note`, `status` (pending/confirmed/rejected), avec les actions `confirmReim`/`rejectReim` déjà câblées (`useExpenses.ts:343,359`). La pension alimentaire réutilise ce PATTERN d'interaction (proposer → confirmer/contester), mais avec ses propres tables — décision explicite de ne pas mélanger les deux dans le même calcul de solde (voir ci-dessous).
- Le calcul du solde entre parents (`ExpensesTab`/`ExpTab`, `App.jsx:13773-13775` : `balance[i] = totals[i] - owed[i] + reimSent[i] - reimReceived[i]`) agrège uniquement les dépenses/remboursements confirmés. La pension alimentaire ne doit JAMAIS entrer dans ce calcul — elle a son propre statut, séparé.
- Le projet utilise déjà `pg_cron` pour une tâche planifiée quotidienne (`expire_stale_family_data()`, mentionnée dans CLAUDE.md, configurée côté dashboard Supabase — pas de fichier de migration dans ce repo). Le job de génération/rappel de pension suit le même mécanisme.
- Notifications push déjà en place (`src/hooks/usePush.ts`, clé VAPID configurée) et déjà utilisées par plusieurs Edge Functions déclenchées côté serveur (`notify-expense`, etc.) pour prévenir un parent d'un événement créé par l'autre. Le nouveau job de rappel de pension envoie ses notifications par le même mécanisme.
- `cfg.parents` : exactement 2 parents par famille (structure existante, pas de cas à 3+ parents à gérer). La pension alimentaire est donc une relation UNIQUE entre ces 2 parents — une seule configuration active à la fois par famille (pas une liste).

## Approche retenue

### Séparation du solde des dépenses

Décision explicite (confirmée avec l'utilisateur) : les versements de pension ne comptent PAS dans le solde global des dépenses partagées. Deux nouvelles tables dédiées, indépendantes de `expenses`/`reimbursements` :

**`pension_configs`** — la configuration récurrente active (ou passée) :
- `id`, `family_id`
- `from_parent` (0|1), `from_user_id` — le parent qui paie
- `to_parent` (0|1), `to_user_id` — le parent qui reçoit
- `amount` (numeric) — montant mensuel
- `day_of_month` (int, 1-28 — borné à 28 pour éviter les problèmes de mois courts type février)
- `start_date` (date) — première échéance couverte par cette configuration
- `end_date` (date, nullable) — NULL = configuration active ; posée à la date de clôture quand une nouvelle configuration la remplace (changement de montant)
- `status` (`proposed` | `active` | `superseded`) — voir ci-dessous, confirmation mutuelle avant activation
- `created_by` (0|1), `created_at`
- `confirmed_by` (0|1, nullable), `confirmed_at` (nullable)

**`pension_payments`** — une ligne par échéance mensuelle :
- `id`, `family_id`, `config_id` (FK vers `pension_configs`)
- `period` (text, format `YYYY-MM`) — le mois concerné
- `amount` (numeric) — copié de la config au moment de la génération (l'historique reste exact même si le montant change plus tard)
- `due_date` (date)
- `status` (`pending` | `confirmed` | `contested`)
- `marked_paid_by` (0|1, nullable), `marked_paid_at` (nullable)
- `confirmed_by` (0|1, nullable), `confirmed_at` (nullable)
- `note` (text, nullable) — raison en cas de contestation
- `created_at`
- Contrainte unique `(config_id, period)` — empêche une double génération si le job planifié tourne deux fois pour la même échéance (idempotence).

### Confirmation mutuelle de la configuration

Cohérent avec le principe déjà retenu pour les versements eux-mêmes (le bénéficiaire confirme chaque paiement) : une configuration proposée par un parent (`status='proposed'`) n'est PAS active tant que l'autre parent ne l'a pas confirmée (`status='active'`). Tant qu'elle est à l'état `proposed`, aucune échéance mensuelle n'est générée. Ça évite qu'un parent impose unilatéralement un montant ou une date sans accord de l'autre — cohérent avec le fait que la pension est un accord entre les deux parties, pas une déclaration à sens unique.

Modifier le montant : crée une NOUVELLE configuration à l'état `proposed` (à confirmer par l'autre parent) ; l'ancienne passe en `status='superseded'` avec `end_date` posée à la date choisie, seulement au moment où la nouvelle est confirmée (pas avant — sinon il y aurait un trou si la nouvelle n'est jamais confirmée).

### Cycle mensuel automatique

Nouvelle fonction SQL `SECURITY DEFINER`, appelée quotidiennement par `pg_cron` (même mécanisme que `expire_stale_family_data()`, configuré côté dashboard Supabase, pas dans ce repo) :

1. Pour chaque `pension_configs` avec `status='active'` : si la date du jour a atteint le `day_of_month` du mois courant et qu'aucune ligne `pension_payments` n'existe pour ce `config_id`+`period`, en créer une (`status='pending'`, `due_date` = date d'échéance du mois, `amount` copié de la config).
2. Nouvelle Edge Function `send-pension-reminders`, invoquée par le même job planifié : pour chaque paiement `pending` dont la `due_date` est dans 2-3 jours, notification push au parent payeur ; pour chaque paiement `pending` dont la `due_date` est dépassée, notification push au parent bénéficiaire (une seule fois par paiement, pas un rappel quotidien répété — voir Non-objectifs).

### UI

Nouvelle section "Pension alimentaire" dans l'onglet Dépenses existant (`ExpTab`), visuellement séparée de la carte de solde des dépenses partagées — pas un nouvel onglet dans la barre de navigation principale (déjà chargée).

- **Aucune configuration active** : bouton "Configurer la pension" → formulaire (qui paie parmi les 2 parents, montant mensuel, jour d'échéance, date de début) → crée une `pension_configs` en `proposed`, notifie l'autre parent.
- **Configuration `proposed` en attente** : bandeau visible par l'autre parent avec le détail proposé + boutons Confirmer/Refuser.
- **Configuration `active`** : affiche l'échéance du mois en cours (statut, montant, date) + historique des mois précédents en dessous (les 12 derniers, avec pagination/chargement à la demande au-delà). Le parent payeur voit un bouton "Marquer payé" sur l'échéance `pending` ; une fois marqué, le bénéficiaire voit Confirmer/Contester (avec note optionnelle si contesté).
- Bouton "Modifier le montant" sur la configuration active → même formulaire que la création, pré-rempli, déclenche le mécanisme de remplacement décrit ci-dessus.

## Sécurité / RLS

- Lecture : tout membre actif de la famille (parents, observateurs) peut lire `pension_configs`/`pension_payments` de sa famille — même modèle que `expenses`/`reimbursements` (transparence familiale).
- Écriture, contrainte par rôle (RLS + vérifications applicatives, pattern à détailler dans le plan) :
  - Seuls les **parents** (pas observateurs/enfants) peuvent créer/modifier une configuration ou marquer/confirmer un paiement.
  - Confirmer une configuration `proposed` : uniquement l'AUTRE parent que celui l'ayant créée (`created_by != confirmed_by` imposé).
  - Marquer un paiement "payé" : uniquement le parent `from_parent` de la config.
  - Confirmer/contester un paiement : uniquement le parent `to_parent` de la config.
- Le job planifié (`SECURITY DEFINER`) et `send-pension-reminders` s'exécutent avec les privilèges nécessaires pour lire toutes les familles et créer les échéances — comme `expire_stale_family_data()`, documenté mais configuré hors-repo (dashboard Supabase), pas de nouveau secret requis (réutilise l'infra push existante).

## Non-objectifs

- Pas de calcul/barème d'aide à la fixation du montant de la pension — l'utilisateur saisit un montant déjà décidé (jugement/accord), Duvia ne conseille jamais sur ce montant (même limite que le chatbot IA vis-à-vis du juridique).
- Pas de rappel répété quotidien tant qu'un paiement reste en retard — une seule notification "en retard" par échéance, pour éviter l’effet de relance/accusation répétée entre parents.
- Pas d'export PDF dédié à la pension pour cette itération (l'export PDF existant des dépenses n'inclut pas la pension, séparée par design) — à reconsidérer si le besoin de justificatif formel se confirme.
- Pas de gestion de plus de 2 parents ni de configurations multiples simultanées — une seule pension active à la fois, cohérent avec le modèle `cfg.parents` à 2 entrées.
- Aucune notion de pénalité de retard calculée automatiquement (intérêts, majoration) — hors-sujet, terrain juridique.

## Déploiement (manuel, hors repo)

1. Migration `0046_pension_tracking.sql` : tables `pension_configs`/`pension_payments`, RLS, fonction `SECURITY DEFINER` de génération mensuelle.
2. Créer et déployer l'Edge Function `send-pension-reminders`.
3. Configurer le job `pg_cron` quotidien (dashboard Supabase, comme `expire_stale_family_data()`) pour appeler la fonction de génération + invoquer `send-pension-reminders`.
4. Aucun nouveau secret requis (réutilise l'infra push existante).

## Test / vérification

Aucun test automatisé possible pour le job planifié réel — vérification live :
- Proposer une configuration → vérifier que l'autre parent voit le bandeau de confirmation, pas d'échéance générée tant que non confirmée.
- Confirmer la configuration → vérifier qu'elle passe active et qu'une échéance est générée au bon jour du mois suivant.
- Marquer un paiement payé → vérifier que l'autre parent voit bien "à confirmer", puis confirmer → statut définitif.
- Contester un paiement avec une note → vérifier que la note est visible par le parent payeur.
- Modifier le montant → vérifier que l'ancienne config passe `superseded` uniquement après confirmation de la nouvelle, jamais avant.
- Vérifier la notification push du payeur 2-3 jours avant l'échéance, et celle du bénéficiaire si la date est dépassée sans paiement marqué.
- Vérifier qu'aucun versement de pension n'apparaît dans le calcul du solde de l'onglet Dépenses.
