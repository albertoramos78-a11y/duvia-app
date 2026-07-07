-- 0025_message_reactions.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Réactions emoji sur les messages (👍 ❤️ 😂 😮 😢 🙏).
--
-- Stockage : {emoji: [user_id, ...]} — une réaction par personne et par
-- message (appliquée côté client par toggleMessageReaction, pas en base).
-- Aucune nouvelle table ni canal realtime : messages a déjà un abonnement
-- postgres_changes qui traite tout UPDATE en remplaçant la ligne entière.
--
-- À exécuter APRÈS 0024. Idempotent (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb;
