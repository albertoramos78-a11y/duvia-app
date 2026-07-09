# Supprimer une conversation localement — Design

## Contexte

La messagerie n'a aucune notion de « conversation » côté serveur : `MessagingTab` regroupe les messages (`messages` table, `messageService.ts`, `useMessages.ts`) client-side, par ensemble de participants — `ck(ids)` trie et concatène les UID (expéditeur + destinataires) en une clé stable (`App.jsx:14581`). Il n'existe aujourd'hui aucun moyen de retirer une conversation de sa propre liste sans supprimer les messages sous-jacents (visibles par tout le monde). Demande (backlog 2026-07-08) : pouvoir « supprimer » un fil de sa liste sans que ça affecte l'autre participant ou le groupe.

## Décisions de conception

### 1. Stockage : nouvelle table `hidden_conversations`, scoping par utilisateur

Une ligne par (utilisateur, conversation masquée), avec un timestamp `hidden_at` :

```sql
CREATE TABLE IF NOT EXISTS public.hidden_conversations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id   UUID        NOT NULL,
  conv_key    TEXT        NOT NULL,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, conv_key)
);
```

RLS : select/insert/update/delete tous scopés à `user_id = auth.uid()` (même gabarit que `push_subscriptions`, migration `0027`). `family_id` n'est pas nécessaire à la RLS (les UID dans `conv_key` sont déjà globalement uniques) mais est stocké pour cohérence avec le reste du schéma et la lisibilité en SQL Editor.

« Supprimer » une conversation déjà masquée ré-écrit simplement `hidden_at` à `NOW()` (upsert sur la contrainte unique) — jamais de ligne à effacer.

### 2. Réapparition automatique par comparaison de timestamp, pas de flag à retirer

Une conversation est masquée pour l'utilisateur **si et seulement si** `hidden_at >= created_at` de son dernier message. Dès qu'un nouveau message arrive avec un `created_at` postérieur à `hidden_at`, le fil ressort naturellement de la liste — aucune écriture supplémentaire n'est nécessaire pour « la révéler », la comparaison suffit à chaque calcul de `convList`.

Ce comportement s'applique à la fois à un nouveau message reçu et à un nouveau message que l'utilisateur enverrait lui-même à la même personne/au même groupe (qui recrée logiquement le même `conv_key`) — dans les deux cas le fil redevient visible sans logique dédiée. Seul un nouveau message (nouveau `created_at`) compte comme activité : une réaction ou un accusé de lecture sur un message déjà existant (`UPDATE`, pas `INSERT`) ne fait pas réapparaître le fil.

### 3. Déclenchement : appui long sur la ligne de conversation

Même mécanique que le picker de réactions (`App.jsx:14903-14908`, timer ~450ms via `onMouseDown`/`onMouseUp`/`onTouchStart`/`onTouchEnd`, pas de librairie de gestes dans le projet). L'appui long sur une ligne de `convList` ouvre un petit menu contextuel avec une seule action « 🗑️ Supprimer ».

### 4. Confirmation explicite avant suppression

Tapoter « Supprimer » ouvre une modale de confirmation dont le texte précise que l'action ne concerne que l'utilisateur (« Cette conversation sera supprimée de ta liste. L'autre personne / le groupe la conservera. »). Seule la confirmation déclenche l'appel réseau.

## Architecture (service → hook → composant, pattern déjà en place)

- **Migration** `supabase/migrations/0028_hidden_conversations.sql` — table + RLS ci-dessus, idempotente (`IF NOT EXISTS` / `DROP POLICY IF EXISTS`, même convention que `0026`/`0027`).
- **`src/services/supabase/hiddenConversationsService.ts`** (nouveau fichier) :
  - `listHiddenConversations(userId): Promise<{convKey: string, hiddenAt: string}[]>`
  - `hideConversation(userId, familyId, convKey): Promise<void>` — upsert `on_conflict: "user_id,conv_key"`.
- **`src/hooks/useMessages.ts`** (étendu, pas de nouveau hook séparé — le filtrage croise nécessairement avec `msgs`, déjà possédé par ce hook) :
  - Charge les lignes masquées au montage (comme `listMessages`), expose `hiddenConvs: Record<string,string>` (convKey → hiddenAt ISO).
  - Expose `hideConversation(convKey)` : appelle le service, puis met à jour `hiddenConvs` localement (optimiste, comme les autres mutations du hook).
- **`src/App.jsx` (`MessagingTab`)** :
  - `convList` filtre les entrées où `hiddenConvs[conv.key]` existe et est `>=` au `ts` du dernier message du fil.
  - État `longPressConvKey` + handlers d'appui long sur chaque ligne (mêmes noms de pattern que `longPressMsgId`).
  - Petit menu contextuel (« 🗑️ Supprimer ») + modale de confirmation réutilisant le style des modales de confirmation existantes (ex. suppression de compte).

## Portée

Inclus : conversations 1-à-1 et de groupe dans `MessagingTab`, quel que soit le rôle (parent/observateur/enfant).

Hors périmètre :
- Pas de vue « conversations masquées » pour les retrouver manuellement — elles ne reviennent que par nouvelle activité, conformément à la décision de conception n°2.
- Ne touche pas à la suppression de message existante (`deleteMessage`/`remove` dans `useMessages.ts`), qui reste une suppression de ligne partagée, inchangée.
- Pas de notification/historique dédié à cette action (masquer une conversation est un geste local, pas un événement à tracer dans `HistTab`).

## Ce que ce chantier NE fait PAS

- Ne modifie pas le schéma de `messages` ni son canal realtime.
- Ne backfill rien (aucune conversation n'est masquée par défaut pour les utilisateurs existants).
