# Assistant IA — reformulation de message (pilote Premium+IA) — design

**Date :** 2026-07-19
**Statut :** approuvé, prêt pour plan d'implémentation

## Problème

Backlog item 19 ("Palier Premium+IA"). L'utilisateur veut, à terme, 4 fonctionnalités IA (reformulation de message, synthèse des dépenses, synthèse du calendrier, synthèse météo), sans questions juridiques. Ce document ne couvre que le premier cas d'usage — **la reformulation de message** — choisi comme pilote pour poser l'infrastructure partagée (appel API Claude côté serveur, contrôle d'accès, anti-abus) qui sera réutilisée telle quelle par les 3 synthèses, chacune brainstormée séparément par la suite.

Contexte produit : la coparentalité est souvent conflictuelle, et la messagerie de Duvia est un canal direct entre deux personnes en tension. Aider à reformuler un message dans un ton neutre avant l'envoi est le cas d'usage le plus emblématique et le plus simple techniquement (texte en entrée/sortie, aucune donnée métier à agréger).

## Contexte technique

- Aucun palier "Premium+IA" n'existe réellement dans le code : `subStatus()` (`App.jsx:294`) ne connaît que `freemium`/`trial_premium`/`premium`/`beta` — la ligne "Premium+AI" dans `PremiumTab` n'est qu'un aperçu marketing (`TIER_RANK`), jamais reliée à un vrai `sub.plan`.
- La vraie facturation Stripe (backlog item 18) est elle-même bloquée sur le SIRET — inutile d'intégrer "Premium+IA" dans toute la mécanique de paliers (dates d'expiration, cycle, `TIER_RANK`) pour une fonctionnalité qui restera réservée à l'admin en attendant.
- Pattern déjà établi et éprouvé pour un appel API externe côté serveur avec anti-abus : la feature "envoi automatique d'emails d'invitation" (`docs/superpowers/specs/2026-07-19-real-invite-email-sending-design.md`) — Edge Function authentifiée par JWT, plafond quotidien via une table de log dédiée.
- `MessagingTab` (`App.jsx:16727`) gère déjà le brouillon (`draft`/`setDraft`) et l'envoi (`sendMsg`) — c'est là que le nouveau bouton s'insère, juste au-dessus du champ de saisie (`App.jsx:~17391`).
- Aucune clé Anthropic n'existe encore comme secret Supabase — à créer par l'utilisateur (compte console.anthropic.com + clé API), comme cela avait déjà été fait pour Resend.

## Approche retenue

### Accès : un simple booléen, pas un vrai palier

Nouvelle colonne `ai_enabled` (boolean, défaut `false`) sur la table `subscriptions`, complètement déconnectée de l'échelle Freemium/Trial/Premium. Activable/désactivable par compte depuis le panneau admin existant (nouvelle action sur `admin-manage-subscriptions`, à côté de `set_user_plan`). Pas de vrai palier vendable tant que Stripe n'est pas prêt — ce booléen sera converti en un vrai statut d'abonnement le jour où la fonctionnalité sera commercialisée.

### Nouvelle Edge Function `ai-rephrase-message`

Même schéma d'authentification que `send-invite-email` : JWT vérifié, pas de rôle admin requis (l'utilisateur agit sur ses propres messages), mais **le booléen `ai_enabled` est revérifié côté serveur** (jamais fait confiance au client) avant d'appeler l'API Claude.

1. Authentifie l'appelant (JWT).
2. Vérifie `subscriptions.ai_enabled = true` pour cet utilisateur — sinon `403 forbidden`.
3. Vérifie le plafond quotidien (voir Anti-abus ci-dessous).
4. Appelle l'API Messages d'Anthropic (`https://api.anthropic.com/v1/messages`, modèle `claude-sonnet-5`) avec une consigne système fixe et le texte du message en entrée utilisateur.
5. Renvoie le texte reformulé au client.

### Consigne système (prompt)

```
Tu es un assistant qui aide des parents séparés à communiquer sereinement au
sujet de leurs enfants. Reformule le message fourni par l'utilisateur en
conservant STRICTEMENT son sens et les informations factuelles qu'il
contient, dans un ton neutre, factuel et courtois — sans accusation, sans
sarcasme, sans emportement. N'ajoute aucune information qui n'est pas dans
le message original. Réponds UNIQUEMENT avec le message reformulé, dans la
même langue que le message original, sans aucun commentaire ni
introduction.
```

### Anti-abus : plafond quotidien, SANS la protection atomique de la feature emails

Nouvelle table `ai_usage_log` (partagée par les 4 futures fonctionnalités IA, `feature` distinguant chacune) :

```sql
create table if not exists public.ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null check (feature in ('rephrase_message')),
  used_at timestamptz not null default now()
);
```

Plafond : 20 utilisations par compte par 24h glissantes, vérifiées par un simple `SELECT count(*)` avant l'appel (PAS de RPC atomique façon `check_and_log_invite_email`). **Différence assumée avec la feature emails** : cette fonctionnalité est réservée aux comptes activés par l'admin (aujourd'hui, une poignée de comptes de confiance) — une éventuelle rafale concurrente ne ferait au pire que gonfler légèrement le coût API d'un compte déjà de confiance, pas ouvrir une brèche d'abus exploitable par un tiers. Le jour où `ai_enabled` devient un vrai palier vendable ouvert à tous, migrer vers le même schéma atomique (RPC + verrou) que `check_and_log_invite_email` sera nécessaire — noté explicitement pour ne pas l'oublier.

### UI (`MessagingTab`)

- Nouveau bouton "✨ Reformuler" à côté du champ de saisie, visible uniquement si `ai_enabled` (lu depuis `sub`/le contexte abonnement — nouveau champ à exposer, ex. `sub.aiEnabled`).
- Au clic : envoie le contenu actuel de `draft` à `ai-rephrase-message`, affiche un état de chargement.
- Résultat affiché en aperçu SOUS le champ de saisie (texte reformulé, non modifiable), avec deux boutons : **"Envoyer celle-ci"** (remplace `draft` par le texte reformulé puis appelle `sendMsg` normalement) et **"Garder mon texte original"** (ferme l'aperçu, `draft` inchangé). Aucun envoi automatique.
- Erreurs (plafond atteint, `ai_enabled` false côté serveur, échec API) affichées simplement sous le bouton, sans bloquer la possibilité d'envoyer le message original tel quel.

## Sécurité

- `ai_enabled` revérifié côté serveur à chaque appel (jamais fait confiance à un état client).
- Le texte du message reste privé : envoyé uniquement à Anthropic pour le traitement de la requête, jamais stocké au-delà du log d'usage (qui ne contient que `user_id`/`feature`/horodatage, pas le contenu du message).
- Clé Anthropic (`ANTHROPIC_API_KEY`) stockée comme secret Supabase, jamais exposée côté client.

## Non-objectifs

- Ne couvre pas les 3 autres cas d'usage (dépenses/calendrier/météo) — chacun aura son propre brainstorm, réutilisant cette même infrastructure (Edge Function d'auth similaire, `ai_usage_log` avec un nouveau `feature`).
- Ne construit pas de vrai palier Premium+IA facturable — le booléen `ai_enabled` est un interrupteur admin temporaire.
- Ne touche à aucune Edge Function existante — nouvelle fonction dédiée.
- Pas de garde-fou spécifique "questions juridiques" ici : hors sujet pour ce cas d'usage précis (reformulation de texte fourni par l'utilisateur, pas de génération de conseil).

## Déploiement (manuel, hors repo)

1. Créer un compte sur console.anthropic.com, générer une clé API, l'ajouter comme secret Supabase `ANTHROPIC_API_KEY` (projet production).
2. Exécuter la migration (nouvelle colonne `subscriptions.ai_enabled` + table `ai_usage_log`) dans l'éditeur SQL Supabase.
3. Créer la Edge Function `ai-rephrase-message` dans le dashboard, déployer.
4. Redéployer `admin-manage-subscriptions` avec la nouvelle action de bascule `ai_enabled`.

## Test / vérification

- Aucun test automatisé possible pour l'appel API réel — vérification live : activer `ai_enabled` sur un compte de test, taper un message à ton vif, cliquer "Reformuler", vérifier que le résultat est bien plus neutre tout en gardant le sens, tester "Garder mon texte original" (le brouillon original doit rester intact), tester le plafond (21e reformulation dans la même journée doit être refusée).
