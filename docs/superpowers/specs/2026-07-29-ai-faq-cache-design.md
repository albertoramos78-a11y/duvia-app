# Cache FAQ auto-alimenté pour l'assistant IA — design

**Date :** 2026-07-29
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

`ai-chatbot` (`supabase/functions/ai-chatbot/index.ts`) appelle l'API Anthropic à chaque question, même quand il s'agit d'une question d'usage générique déjà couverte par `FAQ_KNOWLEDGE` ("comment inviter l'autre parent ?", "comment ajouter une dépense ?"...) et donc structurellement identique à des dizaines/centaines de questions déjà posées par d'autres familles avant elle. Le prompt système est déjà mis en cache Anthropic (`cache_control: ephemeral`, lecture ~0.1x le prix d'un input token), ce qui réduit déjà le coût du contexte statique, mais chaque question distincte déclenche quand même un appel complet à Claude (tokens d'entrée pour la question + tokens de sortie pour régénérer une réponse essentiellement identique à une réponse déjà donnée). Objectif : réduire le coût réel (facture Anthropic) en évitant de rappeler Claude quand une réponse à une question quasiment identique existe déjà.

## Contexte technique

- `FAQ_KNOWLEDGE` (const de `index.ts`) est un bloc de texte statique, dupliqué manuellement depuis `src/faq/faqContent.js`, qui sert de source prioritaire au prompt système. Il n'est modifié qu'à la main, rarement — ce document ne change rien à ce fonctionnement.
- Aucune question/réponse n'est aujourd'hui journalisée nulle part, sauf ponctuellement par `notifyNoAnswer()` (email admin quand le modèle répond avec le marqueur `[NO_ANSWER]`) — ce mécanisme n'est pas modifié.
- Le plafond quotidien (`DAILY_TOKEN_LIMIT`, `ai_usage_log`) et le calcul pondéré des tokens (`weightedTokens()`) restent inchangés.
- Aucun fournisseur d'embeddings (Voyage, OpenAI, Cohere) n'est configuré dans le projet à ce jour — en ajouter un impliquerait une nouvelle dépendance externe facturée. Décision explicite (2026-07-29) : ne pas en ajouter pour cette itération, au profit d'une correspondance textuelle native Postgres (`pg_trgm`), gratuite et déjà disponible dans Supabase, quitte à rater les vraies paraphrases sans vocabulaire commun.
- Conséquence acceptée du choix `pg_trgm` : la correspondance est lexicale, pas sémantique. Une question aux mots totalement différents d'une question déjà en cache ne matchera pas, même si le sens est proche — repli normal sur un appel Claude classique dans ce cas (aucune régression par rapport à aujourd'hui).

## Approche retenue

### Vue d'ensemble

Avant d'appeler Claude, et seulement pour la 1ère question d'une conversation (`clientHistory.length === 0` — un tour de suivi dépend du contexte précédent, hors périmètre ici), on cherche dans une nouvelle table `ai_faq_cache` une question déjà répondue dont le texte est très proche (similarité de trigrammes `pg_trgm` > 0.7). Si trouvé : réponse renvoyée immédiatement, **zéro appel Anthropic**. Sinon : déroulement identique à aujourd'hui, et si la réponse obtenue s'avère être une réponse FAQ générique (voir critères d'écriture plus bas), elle est ajoutée au cache pour la prochaine fois — c'est le mécanisme "d'apprentissage" : le cache grandit automatiquement à partir de l'usage réel, sans étape de génération dédiée.

### Schéma (migration `0058_ai_faq_cache.sql`)

```sql
create extension if not exists pg_trgm;

create table ai_faq_cache (
  id uuid primary key default gen_random_uuid(),
  question_text text not null,
  answer_text text not null,
  faq_fingerprint text not null,
  lang text,
  hit_count int not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index ai_faq_cache_trgm_idx on ai_faq_cache using gin (question_text gin_trgm_ops);
```

- Pas de RLS client : table lue/écrite uniquement par l'Edge Function via le client `service_role` (même modèle que `ai_usage_log`).
- `faq_fingerprint` : hash (ex. SHA-256 tronqué) du contenu actuel de `FAQ_KNOWLEDGE`, calculé une fois au chargement du module. Une entrée écrite sous un ancien contenu de `FAQ_KNOWLEDGE` a un fingerprint différent du fingerprint courant : elle est ignorée à la lecture (voir requête ci-dessous) sans purge explicite nécessaire — se resynchronise automatiquement à la prochaine édition de `FAQ_KNOWLEDGE`. Évite de reproduire le problème de dérive déjà documenté ailleurs dans ce repo (Edge Functions qui répondent avec un contenu obsolète).
- `lang` : langue déclarée par le client (i18n courant), stockée à titre indicatif/analytique uniquement — la correspondance textuelle elle-même n'en a pas besoin (deux langues différentes n'ont structurellement pas de trigrammes communs, donc pas de risque de mélange sans code dédié).

### Lecture (avant l'appel Claude)

```sql
select id, answer_text
from ai_faq_cache
where faq_fingerprint = $1
  and similarity(question_text, $2) > 0.7
order by similarity(question_text, $2) desc
limit 1;
```

- Placée après les vérifications d'accès existantes (JWT valide, rôle parent, `ai_enabled` familial) mais **avant** la vérification du plafond quotidien de tokens : un hit ne coûtant rien, un utilisateur ayant déjà atteint son plafond du jour peut quand même recevoir une réponse FAQ déjà connue.
- Sur hit : incrémente `hit_count`, met à jour `last_used_at`, renvoie `{ answer, tokens_used_today: tokensUsedSoFar, tokens_limit, tokens_this_exchange: 0 }` (le compteur du jour n'est pas modifié — rien n'est consommé). Pas d'écriture dans `ai_usage_log`.
- Sur miss (rien au-dessus du seuil, ou pas la 1ère question de la conversation) : déroulement inchangé.

### Écriture (après une réponse Claude)

Seulement si les trois conditions suivantes sont réunies :
1. C'était la 1ère question de la conversation.
2. Zéro appel d'outil sur tout l'échange (aucun `tool_use` dans aucune des itérations de la boucle de function-calling) — garantit une réponse générique sur l'usage de l'app, jamais dérivée de données propres à une famille (dépenses, planning, messages...).
3. La réponse ne commence pas par le marqueur `[NO_ANSWER]`.

Insertion dans `ai_faq_cache` (`question_text`, `answer_text`, `faq_fingerprint` courant, `lang`), puis un email récapitulatif (même mécanisme Resend que `notifyNoAnswer`, best-effort, ne doit jamais faire échouer la réponse à l'utilisateur) : question, réponse, et un rappel que `DELETE FROM ai_faq_cache WHERE id = '...'` retire une entrée jugée mauvaise (la question retombera sur Claude au prochain coup, sans redéploiement).

Aucune déduplication explicite nécessaire à l'écriture : si une question suffisamment proche existait déjà, elle aurait été servie depuis le cache et n'aurait jamais atteint ce chemin.

## Non-objectifs

- **Cache des questions sur les données familiales** (dépenses, jours de garde...) : explicitement exclu — décision 2026-07-29. Ces réponses dépendent de données qui changent dans le temps, un cache introduirait un risque de réponse périmée pour un gain plus faible (moins de répétition inter-famille par nature).
- **Correspondance sémantique (embeddings)** : explicitement écarté pour cette itération au profit de `pg_trgm`, faute de vouloir introduire une nouvelle dépendance externe facturée. Peut être reconsidéré plus tard si le taux de cache-hit mesuré (`hit_count` agrégé) s'avère trop faible en pratique.
- **File de validation avant mise en cache** : écarté au profit d'une mise en cache immédiate + email de suivi (cohérent avec le mécanisme `notifyNoAnswer` déjà en place) — une revue a posteriori avec suppression manuelle en cas de problème plutôt qu'une revue bloquante a priori.
- **Cache multi-tours** : une question de suivi dans une conversation déjà engagée n'est jamais ni lue ni écrite dans le cache — dépend du contexte précédent, non trivialement réutilisable telle quelle.

## Test

Pas de test unitaire Node classique possible (logique Postgres `pg_trgm` + Edge Function Deno, hors périmètre de `src/**/*.test.js`). Vérification manuelle en staging avant déploiement prod :
1. Poser une question FAQ (ex. "comment inviter l'autre parent ?") → vérifier l'appel Anthropic dans les logs, et la nouvelle ligne dans `ai_faq_cache`.
2. Reposer une question proche mais reformulée (ex. "comment j'invite l'autre parent") → vérifier l'ABSENCE d'appel Anthropic dans les logs, et `hit_count` incrémenté.
3. Poser une question sur des données de famille (ex. "combien j'ai dépensé ce mois-ci ?") → vérifier qu'elle n'est jamais écrite dans `ai_faq_cache` (appel d'outil détecté).
4. Modifier `FAQ_KNOWLEDGE`, redéployer, reposer la question de l'étape 1 → vérifier qu'elle retombe sur un appel Anthropic (fingerprint différent) plutôt que de servir l'ancienne réponse en cache.
