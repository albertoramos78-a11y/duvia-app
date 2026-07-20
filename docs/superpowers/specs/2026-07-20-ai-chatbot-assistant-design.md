# Assistant IA conversationnel (chatbot) — design

**Date :** 2026-07-20
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Backlog item 19 ("Palier Premium+IA"), 2e cas d'usage après la reformulation de message (pilote déjà livré). L'utilisateur veut un chatbot capable de répondre aux questions des trois rôles (parent, observateur, enfant) sur deux registres :

1. Aide générale sur l'usage de Duvia ("comment inviter un observateur ?").
2. Questions personnalisées sur les données de LEUR PROPRE famille ("quand est mon prochain week-end ?", "combien j'ai dépensé ce mois-ci ?").

Contrairement à la reformulation de message (texte en entrée/sortie, aucune donnée métier à agréger), ce cas d'usage nécessite d'aller chercher des données réelles côté serveur — d'où une architecture plus riche (function calling / outils).

## Contexte technique

- Infrastructure déjà posée par la reformulation de message (`docs/superpowers/specs/2026-07-19-ai-message-rephrasing-design.md`) et réutilisée telle quelle ici : `ai_enabled` sur `subscriptions` (désormais dérivé du statut Premium+IA — un compte `plan="premium"` avec `ai_enabled=true`, voir la décision du 2026-07-20 faisant de Premium+IA le palier le plus élevé), table partagée `ai_usage_log` (`feature` distinguant chaque usage), pattern Edge-Function-JWT-authentifiée-plafond-quotidien, clé `ANTHROPIC_API_KEY` déjà configurée comme secret Supabase.
- `sub.aiEnabled` (camelCase, mappé depuis `ai_enabled`) est déjà lu indépendamment du système de palier ailleurs dans le code (`App.jsx:17477`, bouton "✨ Reformuler") — le chatbot réutilise exactement ce même flag pour son propre accès.
- **Contrainte découverte en amont, qui borne le périmètre de cette itération** : le planning de garde n'est PAS interrogeable par une simple requête SQL — il est calculé côté client depuis `cfg.custody` (encore dans le blob JSON `families.data`). Les tables dédiées `custody_rules` / `custody_pattern_days` / `custody_overrides` existent déjà mais sont en **écriture parallèle seulement** (Phase 3, voir l'en-tête de `custodyService.ts`) — la lecture/l'affichage se fait toujours depuis le JSON legacy, pas ces tables. Un outil "calendrier" fiable nécessiterait soit de porter l'algorithme de calcul du planning côté serveur (risque de divergence entre deux implémentations), soit d'attendre la Phase 4 (bascule de lecture). → **explicitement hors périmètre ici**, voir Non-objectifs.
- RLS existante confirmée pour les dépenses (`0017_expenses.sql`) : tout membre actif de la famille (parent/observateur/enfant, sans distinction) peut lire `expenses`/`reimbursements` — aucune logique de permission par rôle à reproduire manuellement côté outil.
- Météo : déjà fetchée côté client directement depuis Open-Meteo (API publique, sans clé), à partir des coordonnées enregistrées par chaque parent (`parent_locations`, migration `0035_parent_locations.sql`) — le même appel peut se faire côté serveur avec les mêmes coordonnées.
- Messagerie : un concept de conversations avec visibilité par utilisateur existe déjà (`0028_hidden_conversations.sql`) — la RLS exacte des `messages` n'a pas besoin d'être comprise en détail ici, puisque l'outil interroge avec le JWT de l'appelant : quelle que soit la portée réelle (famille entière ou conversations spécifiques), elle s'applique automatiquement.

## Approche retenue

### Accès

Identique à la reformulation : `sub.aiEnabled === true` (désormais = compte Premium+IA, le palier le plus élevé de l'app). Vérifié côté client pour afficher/masquer la bulle de chat, ET revérifié côté serveur à chaque appel (jamais fait confiance à un état client).

### UI : bulle de chat flottante globale

Nouveau composant `ChatbotBubble`, monté une fois au niveau racine de l'app (visible sur tous les onglets), conditionné sur `sub.aiEnabled`. Un clic ouvre une fenêtre de conversation par-dessus l'app actuelle (pas un nouvel onglet du menu principal). Historique de conversation tenu en `useState` React, **perdu au rechargement** — pas de nouvelle table, pas de question de rétention de données sensibles (dépenses/messages) à gérer dans le temps.

### Nouvelle Edge Function `ai-chatbot`

JWT-authentifiée, boucle de function-calling :

1. Authentifie l'appelant (JWT), vérifie `subscriptions.ai_enabled = true` — sinon `403 forbidden`.
2. Vérifie le plafond quotidien (`ai_usage_log`, `feature='chatbot_query'`).
3. Appelle l'API Messages d'Anthropic (`claude-sonnet-5`) avec : la consigne système (voir plus bas), l'historique de la conversation en cours (fourni par le client à chaque appel — jamais persisté côté serveur), la nouvelle question, et la liste des outils déclarés (voir ci-dessous).
4. Si la réponse a `stop_reason: "tool_use"` : exécute l'outil demandé (voir "Outils" ci-dessous), renvoie son résultat à Claude comme `tool_result`, reboucle à l'étape 3.
5. Une fois `stop_reason: "end_turn"`, renvoie le texte final au client, et enregistre UNE ligne dans `ai_usage_log` pour la question (pas une ligne par aller-retour d'outil interne).

**Client JWT-scopé pour les outils** : les outils n'utilisent PAS la clé service-role. Ils passent par un client Supabase construit avec le JWT de l'appelant (`createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: 'Bearer ' + callerToken } } })`), pour que les règles RLS déjà en vigueur pour ce compte/rôle s'appliquent automatiquement — sans dupliquer manuellement "qui a le droit de voir quoi". Seule la vérification `ai_enabled` et le plafond `ai_usage_log` utilisent le client service-role (ce sont des tables sans policy client, comme pour la reformulation).

### Outils exposés à Claude

- **`get_expenses(from_date?, to_date?)`** — lit `expenses`/`reimbursements` de la famille de l'appelant sur la période demandée (par défaut : les 3 derniers mois). Retourne une liste compacte (libellé, montant, catégorie, date, statut), pas le schéma DB brut.
- **`get_weather(days?)`** — lit `parent_locations` de la famille de l'appelant, appelle Open-Meteo pour chaque ville configurée (même endpoint que le client, voir `fetchMyWeatherForecast` dans `App.jsx`), retourne les prévisions résumées par jour.
- **`get_family_config()`** — lit une projection NON sensible de la configuration famille : prénoms/âges des enfants, structure parentale (nombre de parents, pas leurs emails), dates personnalisées configurées. N'inclut jamais d'email, d'identifiant de compte, ni de contenu du coffre-fort.
- **`get_messages(from_date?, to_date?, limit?)`** — lit la messagerie familiale visible par l'appelant (RLS existante, quelle que soit sa portée exacte) sur la période/quantité demandée (par défaut : les 30 derniers messages).

Chaque outil est une fonction TypeScript pure côté Edge Function qui construit une requête avec le client JWT-scopé et retourne un JSON compact.

### Consigne système (prompt)

```
Tu es l'assistant IA de Duvia, une application de coparentalité partagée
entre deux foyers ("Deux maisons. Une famille."). Tu réponds aux questions
des parents, observateurs et enfants utilisant l'application.

Tu peux répondre à deux types de questions :
1. Aide sur l'utilisation de l'application (comment inviter quelqu'un, où
   trouver telle fonctionnalité, etc.) — réponds directement, sans outil.
2. Questions sur les données de LEUR PROPRE famille (dépenses, météo,
   informations de configuration, messages) — utilise les outils fournis
   pour aller chercher les données réelles avant de répondre. Ne devine
   JAMAIS un chiffre ou une information que tu pourrais vérifier avec un
   outil.

Tu ne réponds JAMAIS à des questions d'ordre juridique (garde, pension
alimentaire, droits parentaux, procédures judiciaires, litiges) — dans ce
cas, explique poliment que tu ne peux pas conseiller sur ces sujets et
recommande de consulter un avocat ou un professionnel qualifié.

Reste neutre, factuel et bienveillant — le contexte familial est souvent
sensible. Réponds dans la langue de la question. Si une information
demandée n'est disponible dans aucun outil (ex. planning de garde,
actuellement non disponible), dis-le clairement plutôt que d'inventer une
réponse.
```

### Anti-abus

Plafond 20 questions/jour par compte (`ai_usage_log`, nouvelle valeur `feature='chatbot_query'`), même schéma non-atomique (simple `SELECT count(*)`) que `rephrase_message` — même justification assumée : accès restreint à une poignée de comptes de confiance forcés admin, pas une frontière de sécurité exposée à un tiers.

## Sécurité

- Chaque outil exécute sa requête avec le JWT de l'appelant, jamais la clé service-role — les règles RLS déjà en vigueur pour ce compte/rôle s'appliquent automatiquement, sans logique de permission à dupliquer ni à laisser dériver du reste de l'app.
- `ai_enabled` revérifié côté serveur à chaque appel (jamais fait confiance à un état client).
- Aucune donnée envoyée à Anthropic sauf ce que Claude demande explicitement via un outil pour CETTE question précise — une question générale sur l'usage de l'app n'entraîne aucun accès aux données famille (contrairement à un envoi systématique du contexte complet, écarté en amont).
- Le contenu récupéré par les outils (dépenses, messages, config) n'est jamais stocké au-delà du tour de conversation en cours — seul `ai_usage_log` persiste (`user_id`/`feature`/horodatage), jamais le contenu des questions/réponses/données consultées.
- Clé Anthropic déjà configurée comme secret Supabase (réutilisée, pas de nouveau secret).

## Non-objectifs

- **Pas d'outil calendrier** dans cette itération (voir Contexte technique) — à reconsidérer une fois la Phase 4 de bascule de lecture des tables `custody_*` faite, ou via un mécanisme dédié à brainstormer séparément.
- Pas d'historique de conversation persistant — perdu au rechargement, par choix explicite (voir UI).
- Aucune réponse à caractère juridique, quelle que soit la question posée.
- Ne construit pas de nouveau système de palier ou de facturation — réutilise `ai_enabled`/Premium+IA tel quel.

## Déploiement (manuel, hors repo)

1. Migration : ajoute `'chatbot_query'` à la contrainte `check` de `ai_usage_log.feature` (ALTER de la contrainte existante posée par la migration `0044_ai_features_foundation.sql`).
2. Créer la Edge Function `ai-chatbot` dans le dashboard, déployer.
3. Aucun nouveau secret requis (réutilise `ANTHROPIC_API_KEY` déjà configuré).

## Test / vérification

Aucun test automatisé possible pour l'appel API réel — vérification live :
- Poser une question générale ("comment inviter un observateur ?") → réponse pertinente, sans appel d'outil.
- Poser une question sur les dépenses réelles d'un compte de test → vérifier l'exactitude des chiffres renvoyés contre l'onglet Dépenses.
- Poser une question météo → vérifier la cohérence avec la météo affichée dans l'app pour la même ville.
- Poser une question sur le planning de garde → vérifier que le chatbot indique clairement ne pas pouvoir y répondre (pas d'invention).
- Poser une question juridique (ex. "quels sont mes droits de garde ?") → vérifier le refus poli et la redirection vers un professionnel.
- Tester le plafond (21e question dans la même journée doit être refusée).
