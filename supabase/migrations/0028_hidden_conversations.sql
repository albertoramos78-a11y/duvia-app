-- 0028_hidden_conversations.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Permet à un utilisateur de retirer une conversation (au sens client-side —
-- voir ck(ids) dans MessagingTab, App.jsx) de sa propre liste de messages,
-- sans rien supprimer pour les autres participants. Une ligne = une
-- conversation masquée par un utilisateur donné ; hidden_at est toujours
-- généré côté serveur (trigger), jamais fourni par le client, pour éviter
-- tout problème de décalage d'horloge lors de la comparaison avec le
-- created_at (serveur, lui aussi) du dernier message de la conversation.
--
-- Ré-masquer une conversation déjà masquée met simplement hidden_at à jour
-- (upsert sur la contrainte unique) — aucune ligne n'est jamais supprimée
-- par cette fonctionnalité ; voir
-- docs/superpowers/specs/2026-07-09-hide-conversation-locally-design.md.
--
-- À exécuter APRÈS 0027. Idempotent (IF NOT EXISTS pour la table/l'index,
-- CREATE OR REPLACE pour la fonction, DROP TRIGGER/POLICY IF EXISTS avant
-- recréation — même convention que 0017/0026/0027).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.hidden_conversations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id   UUID        NOT NULL,
  conv_key    TEXT        NOT NULL,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, conv_key)
);

CREATE INDEX IF NOT EXISTS hidden_conversations_user_id_idx ON public.hidden_conversations(user_id);

-- ── Trigger : hidden_at est toujours l'heure serveur, y compris lors d'un
-- ré-masquage (upsert en conflit = chemin UPDATE, où DEFAULT ne s'applique pas) ──
CREATE OR REPLACE FUNCTION public.handle_hidden_conversations_hidden_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.hidden_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hidden_conversations_set_hidden_at ON public.hidden_conversations;
CREATE TRIGGER hidden_conversations_set_hidden_at
  BEFORE INSERT OR UPDATE ON public.hidden_conversations
  FOR EACH ROW EXECUTE FUNCTION public.handle_hidden_conversations_hidden_at();

ALTER TABLE public.hidden_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hidden_conversations_select_own" ON public.hidden_conversations;
CREATE POLICY "hidden_conversations_select_own" ON public.hidden_conversations FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "hidden_conversations_insert_own" ON public.hidden_conversations;
CREATE POLICY "hidden_conversations_insert_own" ON public.hidden_conversations FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "hidden_conversations_update_own" ON public.hidden_conversations;
CREATE POLICY "hidden_conversations_update_own" ON public.hidden_conversations FOR UPDATE
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
