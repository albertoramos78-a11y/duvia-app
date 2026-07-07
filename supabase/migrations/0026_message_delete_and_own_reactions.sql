-- 0026_message_delete_and_own_reactions.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Suppression d'un message par son expéditeur, mais uniquement tant que
--    personne d'autre ne l'a lu (read_by ne contient alors que sender_id).
--    Une fois lu par un destinataire, la suppression devient impossible —
--    volontaire, pour ne jamais effacer un message que quelqu'un a déjà vu.
-- 2) REPLICA IDENTITY FULL : sans ça, l'event realtime DELETE ne se propage
--    pas de façon fiable quand la policy SELECT dépend d'autres colonnes que
--    la clé primaire (même bug déjà rencontré et corrigé pour expenses/
--    reimbursements dans 0023).
-- 3) L'expéditeur ne pouvait pas réagir à SON PROPRE message : la seule
--    policy UPDATE existante (messages_update_mark_read) n'autorise que les
--    destinataires (recipient_ids), jamais sender_id. setMessageReaction
--    utilise le même UPDATE générique que markMessageRead, donc un
--    expéditeur qui réagissait à son propre message échouait silencieusement
--    côté serveur.
--
-- À exécuter APRÈS 0025. Idempotent (drop/recreate policies).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.messages REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS messages_delete_own_unread ON public.messages;
CREATE POLICY messages_delete_own_unread ON public.messages
FOR DELETE
USING (
  auth.uid() = sender_id
  AND read_by <@ ARRAY[sender_id]::uuid[]
);

DROP POLICY IF EXISTS messages_update_own_reactions ON public.messages;
CREATE POLICY messages_update_own_reactions ON public.messages
FOR UPDATE
USING (
  is_validated_family_member(family_id)
  AND auth.uid() = sender_id
);
