-- 0045_chatbot_query_feature.sql
--
-- Ajoute 'chatbot_query' à la liste des features autorisées dans
-- ai_usage_log (posée par la migration 0044 pour 'rephrase_message'
-- uniquement). Voir docs/superpowers/specs/2026-07-20-ai-chatbot-assistant-
-- design.md — 2e fonctionnalité Premium+IA, réutilise la même table de log
-- et le même plafond quotidien non-atomique (20/jour), sur sa propre valeur
-- de feature pour ne pas partager le quota avec la reformulation de message.
--
-- Postgres ne permet pas de modifier les valeurs d'une contrainte CHECK en
-- place — il faut la supprimer puis la recréer. Le nom "ai_usage_log_feature_
-- check" est le nom auto-généré par Postgres pour la contrainte CHECK inline
-- posée sur la colonne "feature" par le CREATE TABLE de la migration 0044
-- (convention <table>_<colonne>_check).
alter table public.ai_usage_log drop constraint if exists ai_usage_log_feature_check;
alter table public.ai_usage_log add constraint ai_usage_log_feature_check
  check (feature in ('rephrase_message', 'chatbot_query'));
