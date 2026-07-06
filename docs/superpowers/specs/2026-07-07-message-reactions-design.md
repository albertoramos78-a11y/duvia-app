# Réactions emoji sur les messages — Design

## Contexte

La messagerie (`messages` table, `messageService.ts`, `useMessages.ts`) n'a aujourd'hui aucun moyen de réagir à un message — seulement l'envoyer et le marquer lu (`read_by`). Demande : pouvoir réagir à n'importe quel message (peu importe qui l'a envoyé) avec un smiley, façon WhatsApp/Messenger.

## Décisions de conception

### 1. Choix limité de 6 smileys, pas de sélecteur libre

👍 ❤️ 😂 😮 😢 🙏 — fixes, pas de sélecteur d'emoji illimité. Plus simple à utiliser sur mobile (un tap), pas de clavier emoji à gérer.

### 2. Déclenchement : appui long sur le message

Un appui long (long-press) sur la bulle d'un message fait apparaître une petite rangée des 6 smileys juste au-dessus. Tapoter un smiley l'applique. Comme il n'y a pas de librairie de gestes dans le projet, l'appui long est géré à la main via `onTouchStart`/`onTouchEnd` (mobile) et `onMouseDown`/`onMouseUp` (desktop) avec un timer (~450ms).

### 3. Une seule réaction par personne et par message

Poser un nouveau smiley remplace l'ancien (si j'avais ❤️ et que je tape 😂, je n'ai plus que 😂). Retaper le smiley déjà posé le retire (bascule on/off). Pas de réactions multiples simultanées par personne sur le même message.

### 4. Stockage : colonne `reactions` (JSONB) sur `messages`, pas de nouvelle table

Format : `{"👍": ["user_id_1"], "❤️": ["user_id_2","user_id_3"]}` — clé = smiley, valeur = liste des `user_id` ayant posé ce smiley. Simple à lire/écrire, se synchronise avec le canal realtime `postgres_changes` déjà utilisé pour `messages` (aucun canal supplémentaire nécessaire).

Poser/retirer une réaction est donc une opération de lecture-modification-écriture sur ce JSONB : retirer mon `user_id` de tous les smileys existants (au cas où j'en avais déjà un autre), puis, si ce n'était pas déjà le smiley que je viens de taper, m'ajouter à celui-ci.

### 5. Affichage : badge par smiley + compteur, tap pour voir qui

Sous chaque message ayant au moins une réaction, une rangée de petits badges (un par smiley utilisé) avec le nombre (ex. "❤️ 2"). Taper un badge affiche une petite bulle avec les prénoms des personnes ayant réagi avec ce smiley (résolus via la même `pMap` déjà utilisée pour afficher les noms/avatars des messages).

## Portée

Inclus : messages de la messagerie familiale (`MessagingTab`, table `messages`) uniquement.

Hors périmètre : pas de réactions sur d'autres contenus (dépenses, remboursements, historique...). Pas de notification push dédiée à une réaction (une réaction ne déclenche pas de `pushNotif`/`addHist` — c'est un geste léger, pas une action à tracer).

## Fichiers concernés

- Migration SQL (nouvelle, numéro suivant celui déjà en place) : `ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb;`
- `src/services/supabase/messageService.ts` — ajouter `reactions: Record<string,string[]>` à `DuviaMessage`, et une fonction `toggleReaction(id, userId, emoji, currentReactions)` qui calcule le nouveau JSONB et fait l'UPDATE.
- `src/hooks/useMessages.ts` — exposer une méthode `reactToMessage(id, emoji)` (résout `currentReactions` depuis l'état local, appelle le service, optimiste comme les autres mutations du hook).
- `src/App.jsx` (`MessagingTab`) — état de long-press, rangée de smileys flottante, badges de réactions sous chaque message, popover "qui a réagi".

## Ce que ce chantier NE fait PAS

- Ne touche pas à `read_by` ni au reste du flux de messagerie existant.
- Ne backfill rien (les messages existants démarrent avec `reactions: {}`).
